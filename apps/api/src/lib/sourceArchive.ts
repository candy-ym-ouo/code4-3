import { AppError } from "./errors.js";

/**
 * 来源归档/取消归档的纯业务规则。
 *
 * 来源通过 archived_at 软删除：非归档来源在 (type, lower(name)) 上有唯一索引。
 * 归档代表该来源的供应链关系结束，需要同时核对：
 *  - 关联批次：仍有未结批次（非归档且有正库存）时拒绝归档；
 *  - 联系人等档案：归档后冻结，历史引用保留快照，不再允许修改联系人。
 */

export type SourceArchiveState = {
  archivedAt: Date | string | null;
  name: string;
  type: string;
};

export type ArchiveDecision =
  | { changed: true }
  | { changed: false };

/**
 * 计算归档请求是否构成一次真实的状态翻转。
 * 重复请求（来源已是目标状态）返回 changed:false，调用方不得再写审计日志。
 */
export function decideArchive(state: Pick<SourceArchiveState, "archivedAt">, targetArchived: boolean): ArchiveDecision {
  const isArchived = state.archivedAt !== null;
  if (isArchived === targetArchived) return { changed: false };
  return { changed: true };
}

/**
 * 归档前核对关联批次。
 * 未结批次口径与来源列表的 activeBatchCount 一致：未归档且仍有正库存。
 */
export function assertCanArchive(input: {
  state: Pick<SourceArchiveState, "archivedAt">;
  openBatchCount: number;
}): ArchiveDecision {
  const decision = decideArchive(input.state, true);
  if (!decision.changed) return decision;
  if (input.openBatchCount > 0) {
    throw new AppError(409, "SOURCE_HAS_OPEN_BATCHES", "来源仍有未结批次，请先耗尽或归档相关批次");
  }
  return decision;
}

/**
 * 取消归档前核对。
 * 恢复后来源重新进入 (type, lower(name)) 唯一约束，因此必须先确认没有同名、
 * 同类型的非归档来源占用名称，否则把数据库唯一索引冲突转成可读的业务错误。
 */
export function assertCanUnarchive(input: {
  state: SourceArchiveState;
  activeNameTaken: boolean;
}): ArchiveDecision {
  const decision = decideArchive(input.state, false);
  if (!decision.changed) return decision;
  if (input.activeNameTaken) {
    throw new AppError(409, "SOURCE_NAME_CONFLICT", "已有同名且同类型的使用中来源，请先改名或重新归档该来源");
  }
  return decision;
}
