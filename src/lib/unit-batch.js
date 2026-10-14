// unit-batch.js —— 按「完整业务单元」分批执行大数据量写入，报告真实提交边界
//
// 解决三个问题：
//   1. 用 runUnitBatch 逐业务单元提交，失败只回滚该单元。
//   2. 返回 succeeded / failed / unprocessed 三类 ID 与失败原因，调用方按真实提交边界
//      反馈用户；重试只重投 pendingUnits 给出的单元，已成功的绝不重复提交。
//   3. 「整批零写」有统一入口。越权/无效目标（项目不符、名单里没有、类型不对）在写
//      第一行之前用 rejectUnits 整体拒绝，不会出现「校验到一半写了几行」。
//
// 约定：
//   unit = { id?, ids?, statements }，statements 是必须用 db.batchAtomic 原子执行的
//   完整业务单元。
//   result = { succeeded: [id], failed: [{ id, reason }], unprocessed: [id] }
//   纯函数，不直接访问数据库。

function unitIds(unit) {
  if (!unit || typeof unit !== 'object') throw new Error('unit-batch: 业务单元必须是对象');
  if (!Array.isArray(unit.statements) || unit.statements.length === 0) {
    throw new Error('unit-batch: 每个业务单元必须带非空 statements');
  }
  if (Array.isArray(unit.ids)) return unit.ids.slice();
  if (unit.id !== undefined) return [unit.id];
  return [];
}

// 逐单元执行。onFail='continue'（默认）：某个单元失败继续跑完剩余单元；
// onFail='stop'：失败即止，剩余单元进 unprocessed（调用方决定是否重试）。
// runUnit(unit) 由调用方注入，内部必须是 db.batchAtomic(unit.statements)。
async function runUnitBatch(units, runUnit, { onFail = 'continue' } = {}) {
  if (typeof runUnit !== 'function') throw new Error('unit-batch: runUnit 必须是函数');
  const succeeded = [];
  const failed = [];
  const unprocessed = [];
  let stopped = false;
  for (const unit of units) {
    if (stopped) {
      unprocessed.push(...unitIds(unit));
      continue;
    }
    try {
      await runUnit(unit);
      succeeded.push(...unitIds(unit));
    } catch (e) {
      for (const id of unitIds(unit)) failed.push({ id, reason: String(e?.message || e) });
      if (onFail === 'stop') stopped = true;
    }
  }
  return { succeeded, failed, unprocessed };
}

// 整批零写：校验不通过时整体拒绝，返回全部 failed，任何语句都不执行。
function rejectUnits(units, reason) {
  if (!Array.isArray(units)) throw new Error('unit-batch: units 必须是数组');
  const msg = typeof reason === 'string' ? reason : String(reason?.message || reason || '批量请求被拒绝');
  return {
    succeeded: [],
    failed: units.flatMap((unit) => unitIds(unit).map((id) => ({ id, reason: msg }))),
    unprocessed: [],
  };
}

// 从上次结果挑出待重试的单元（failed + unprocessed），已成功单元不重复提交。
function pendingUnits(units, result) {
  const retryIds = new Set([
    ...(result?.failed || []).map((f) => f.id),
    ...(result?.unprocessed || []),
  ]);
  if (!retryIds.size) return [];
  return units.filter((unit) => unitIds(unit).some((id) => retryIds.has(id)));
}

module.exports = { runUnitBatch, rejectUnits, pendingUnits, unitIds };
