import { describe, expect, it } from "vitest";
import { assertCanArchive, assertCanUnarchive, decideArchive } from "../src/lib/sourceArchive.js";
import { AppError } from "../src/lib/errors.js";

const activeSource = { archivedAt: null, name: "苏州染坊", type: "PURCHASED" };
const archivedSource = { archivedAt: "2026-09-20T00:00:00Z", name: "苏州染坊", type: "PURCHASED" };

describe("source archive state transitions", () => {
  it("flips active -> archived and archived -> active once", () => {
    expect(decideArchive(activeSource, true)).toEqual({ changed: true });
    expect(decideArchive(archivedSource, false)).toEqual({ changed: true });
  });

  it("treats repeated archive/unarchive requests as no-op", () => {
    expect(decideArchive(archivedSource, true)).toEqual({ changed: false });
    expect(decideArchive(activeSource, false)).toEqual({ changed: false });
  });

  it("rejects archiving when the source still has open batches", () => {
    expect.assertions(2);
    try {
      assertCanArchive({ state: activeSource, openBatchCount: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SOURCE_HAS_OPEN_BATCHES");
    }
  });

  it("allows archiving when only archived or depleted batches remain", () => {
    expect(assertCanArchive({ state: activeSource, openBatchCount: 0 })).toEqual({ changed: true });
  });

  it("does not raise the open-batch error for a duplicate archive request", () => {
    // 重复归档应保持幂等 no-op，即使仍能查到批次计数也不应再报错。
    expect(assertCanArchive({ state: archivedSource, openBatchCount: 5 })).toEqual({ changed: false });
  });

  it("rejects unarchiving when an active source already owns the same name and type", () => {
    expect.assertions(2);
    try {
      assertCanUnarchive({ state: archivedSource, activeNameTaken: true });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("SOURCE_NAME_CONFLICT");
    }
  });

  it("allows unarchiving when the name is free", () => {
    expect(assertCanUnarchive({ state: archivedSource, activeNameTaken: false })).toEqual({ changed: true });
  });

  it("treats a duplicate unarchive request as no-op even when the name is taken", () => {
    expect(assertCanUnarchive({ state: activeSource, activeNameTaken: true })).toEqual({ changed: false });
  });
});
