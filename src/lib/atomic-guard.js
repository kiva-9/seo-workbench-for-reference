// 条件更新零行不会让事务自动失败；CHECK 守卫把过期计划变成整单元回滚。
const { randomUUID } = require('node:crypto');
function withAtomicGuard(backend, statements, sql, args = []) {
  const key = randomUUID();
  return [
    backend.prepare('INSERT INTO business_mutation_guards(operation_id,guard_key,ok) VALUES (?, ?, COALESCE(('+sql+'),0))').bind(key,'business-plan',...args),
    ...statements,
    backend.prepare('DELETE FROM business_mutation_guards WHERE operation_id=?').bind(key),
  ];
}
module.exports={withAtomicGuard};
