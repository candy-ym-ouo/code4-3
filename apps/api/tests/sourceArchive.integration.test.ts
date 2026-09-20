import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { pool } from "../src/lib/db.js";
import { createSession, hashPassword } from "../src/lib/auth.js";
import type { FastifyInstance } from "fastify";

/**
 * 真实 PostgreSQL 集成测试：来源归档/取消归档的状态、约束与审计幂等。
 * 仅在 PG* 连接变量指向可用数据库时运行（CI integration 任务/本地手动）。
 */
const dbAvailable = await (async () => {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
})();

const maybe = dbAvailable ? describe : describe.skip;

maybe("source archive integration", () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    await pool.query(
      `TRUNCATE TABLE audit_logs, stock_movements, color_changes, consumptions, project_requirements,
                       projects, attachments, batches, materials, sources, storage_locations,
                       sessions, users RESTART IDENTITY CASCADE`
    );
    const userResult = await pool.query<{ id: string }>(
      "INSERT INTO users(display_name, password_hash) VALUES ($1, $2) RETURNING id",
      ["集成测试员", await hashPassword("integration-password-123")]
    );
    userId = userResult.rows[0]!.id;
    const session = await createSession(userId);
    cookie = `handcraft_session=${session.token}`;
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  type SourceBody = {
    id: string;
    name: string;
    type: string;
    archivedAt: string | null;
    [key: string]: unknown;
  };

  async function api(path: string, method = "GET", body?: unknown) {
    const response = await app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
      payload: body as any
    });
    const json = response.json() as { data?: SourceBody; error?: { code: string; message: string } };
    return { status: response.statusCode, json };
  }

  async function createSource(name: string) {
    const response = await api("/sources", "POST", { name, type: "PURCHASED", contactName: "王老板" });
    expect(response.status, response.json.error?.message).toBe(201);
    return response.json.data!;
  }

  async function createMaterial(name: string) {
    const response = await api("/materials", "POST", { name, craftTypes: ["DYEING"], stockUnit: "g" });
    expect(response.status, response.json.error?.message).toBe(201);
    return response.json.data!.id as string;
  }

  async function auditCount(sourceId: string, action: string) {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_logs WHERE entity_type = 'SOURCE' AND entity_id = $1 AND action = $2",
      [sourceId, action]
    );
    return Number(result.rows[0]!.count);
  }

  it("拒绝归档仍有未结批次的来源", async () => {
    const source = await createSource("有未结批次的染坊");
    const materialId = await createMaterial("染材-未结");
    await pool.query(
      `INSERT INTO batches(material_id, source_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit, status)
       VALUES ($1, $2, current_date, 100, 100, 'g', 'g', 'ACTIVE')`,
      [materialId, source.id]
    );

    const rejected = await api(`/sources/${source.id}/archive`, "POST");
    expect(rejected.status).toBe(409);
    expect(rejected.json.error?.code).toBe("SOURCE_HAS_OPEN_BATCHES");

    const detail = await pool.query("SELECT archived_at FROM sources WHERE id = $1", [source.id]);
    expect(detail.rows[0]!.archived_at).toBeNull();
    expect(await auditCount(source.id, "ARCHIVE")).toBe(0);
  });

  it("批次耗尽后允许归档，并冻结联系人（PATCH 只读）", async () => {
    const source = await createSource("耗尽后可归档的染坊");
    const materialId = await createMaterial("染材-耗尽");
    const batch = await pool.query<{ id: string }>(
      `INSERT INTO batches(material_id, source_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit, status)
       VALUES ($1, $2, current_date, 100, 0, 'g', 'g', 'DEPLETED') RETURNING id`,
      [materialId, source.id]
    );

    const archived = await api(`/sources/${source.id}/archive`, "POST");
    expect(archived.status, archived.json.error?.message).toBe(200);
    expect(archived.json.data!.archivedAt).toBeTruthy();
    expect(await auditCount(source.id, "ARCHIVE")).toBe(1);

    // 归档后联系人等档案只读。
    const patch = await api(`/sources/${source.id}`, "PATCH", { contactName: "新联系人" });
    expect(patch.status).toBe(409);
    expect(patch.json.error?.code).toBe("SOURCE_ARCHIVED");
    const unchanged = await pool.query("SELECT contact_name FROM sources WHERE id = $1", [source.id]);
    expect(unchanged.rows[0]!.contact_name).toBe("王老板");

    // 批次仍存在但已耗尽（未归档、剩余 0），不算未结批次。
    expect(batch.rows[0]!.id).toBeTruthy();
  });

  it("重复归档请求不产生第二条审计", async () => {
    const source = await createSource("重复归档的染坊");
    const first = await api(`/sources/${source.id}/archive`, "POST");
    expect(first.status).toBe(200);
    const second = await api(`/sources/${source.id}/archive`, "POST");
    expect(second.status).toBe(200);
    const third = await api(`/sources/${source.id}/archive`, "POST");
    expect(third.status).toBe(200);
    expect(await auditCount(source.id, "ARCHIVE")).toBe(1);
  });

  it("取消归档恢复原名唯一性：名称被占用时拒绝，改名后可恢复", async () => {
    const archived = await createSource("同名冲突染坊");
    await api(`/sources/${archived.id}/archive`, "POST");

    // 归档后可以再建一个同名同类型来源（部分唯一索引释放名称）。
    const occupant = await createSource("同名冲突染坊");
    expect(occupant.archivedAt).toBeNull();

    const blocked = await api(`/sources/${archived.id}/unarchive`, "POST");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error?.code).toBe("SOURCE_NAME_CONFLICT");
    expect(await auditCount(archived.id, "UNARCHIVE")).toBe(0);

    // 占用者改名腾出唯一名称。
    const renamed = await api(`/sources/${occupant.id}`, "PATCH", { name: "改名后的染坊" });
    expect(renamed.status, renamed.json.error?.message).toBe(200);

    const restored = await api(`/sources/${archived.id}/unarchive`, "POST");
    expect(restored.status, restored.json.error?.message).toBe(200);
    expect(restored.json.data!.archivedAt).toBeNull();
    expect(await auditCount(archived.id, "UNARCHIVE")).toBe(1);

    // 再归档/再恢复只各产生一次翻转。
    await api(`/sources/${archived.id}/archive`, "POST");
    await api(`/sources/${archived.id}/unarchive`, "POST");
    expect(await auditCount(archived.id, "ARCHIVE")).toBe(2);
    expect(await auditCount(archived.id, "UNARCHIVE")).toBe(2);
  });

  it("重复取消归档请求不产生第二条审计", async () => {
    const source = await createSource("重复恢复的染坊");
    await api(`/sources/${source.id}/archive`, "POST");
    await api(`/sources/${source.id}/unarchive`, "POST");
    await api(`/sources/${source.id}/unarchive`, "POST");
    await api(`/sources/${source.id}/unarchive`, "POST");
    expect(await auditCount(source.id, "UNARCHIVE")).toBe(1);
  });

  it("对不存在的来源归档/取消归档返回 404 且不写审计", async () => {
    const missing = "00000000-0000-0000-0000-000000000099";
    const archive = await api(`/sources/${missing}/archive`, "POST");
    expect(archive.status).toBe(404);
    const unarchive = await api(`/sources/${missing}/unarchive`, "POST");
    expect(unarchive.status).toBe(404);
    const audits = await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE entity_id = $1", [missing]);
    expect(audits.rows[0]!.count).toBe(0);
  });

  it("仅剩已耗尽（未归档、零库存）批次时允许归档", async () => {
    const source = await createSource("只有耗尽批次的染坊");
    const materialId = await createMaterial("染材-仅耗尽");
    await pool.query(
      `INSERT INTO batches(material_id, source_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit, status)
       VALUES ($1, $2, current_date, 50, 0, 'g', 'g', 'DEPLETED')`,
      [materialId, source.id]
    );
    const archived = await api(`/sources/${source.id}/archive`, "POST");
    expect(archived.status, archived.json.error?.message).toBe(200);
    expect(archived.json.data!.archivedAt).toBeTruthy();
    expect(await auditCount(source.id, "ARCHIVE")).toBe(1);
  });

  it("并发重复归档只有一次真实翻转和一条审计", async () => {
    const source = await createSource("并发归档的染坊");
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api(`/sources/${source.id}/archive`, "POST"))
    );
    for (const response of results) {
      expect([200, 409]).toContain(response.status);
    }
    const archivedRows = results.filter((response) => response.status === 200);
    expect(archivedRows.length).toBeGreaterThanOrEqual(1);
    expect(await auditCount(source.id, "ARCHIVE")).toBe(1);
  });
});
