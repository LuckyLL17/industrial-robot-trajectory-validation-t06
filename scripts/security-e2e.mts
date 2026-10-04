// Security boundary E2E: release gate vs execution entry.
// Run against a fresh server: PORT=6399 tsx src/index.ts
const BASE = process.env.BASE || 'http://127.0.0.1:6399';
let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`, extra ?? ''); }
}
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const cleanWp = [
  { x: 1000, y: 0, z: 0, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
  { x: 1100, y: 0, z: 0, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
];
const collisionWp = [
  { x: 500, y: 0, z: 300, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
  { x: 520, y: 0, z: 300, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
];
async function newPath(waypoints: any, toolId = 'gun-01') {
  const r = await call('POST', '/api/paths', { name: `sec-${Date.now()}-${Math.random()}`, cellId: 'cell-01', robotId: 'robot-01', toolId, waypoints });
  if (r.status !== 200) throw new Error('path create failed: ' + JSON.stringify(r.body));
  return r.body;
}
const codesOf = (b: any) => (b?.failures || []).map((f: any) => f.code);

async function main() {
  console.log('# 正常放行与无 release 直连执行阻断');
  const A = await newPath(cleanWp);
  let v = await call('POST', `/api/paths/${A.id}/validate`, {});
  check('碰撞校验通过', v.status === 200 && v.body.valid === true);

  let exec = await call('POST', '/api/executions', { pathId: A.id });
  check('未 release 直接执行被阻断 (原绕过漏洞)', exec.status === 409 && exec.body.code === 'execution-safety-blocked');
  check('阻断原因包含 release-required', codesOf(exec.body).includes('release-required'), exec.body);

  let rel = await call('POST', `/api/paths/${A.id}/release`, { operator: 'tester' });
  check('release 正常放行', rel.status === 200 && rel.body.status === 'released', rel.body);

  let dup = await call('POST', `/api/paths/${A.id}/release`, {});
  check('重复 release 申请返回 409', dup.status === 409 && dup.body.code === 'release-already-active');
  check('重复申请回指当前有效 release', dup.body.release?.id === rel.body.id, dup.body);

  exec = await call('POST', '/api/executions', { pathId: A.id, mode: 'dry-run' });
  check('release 后执行创建并完成', exec.status === 200 && exec.body.status === 'completed');
  check('执行记录绑定 releaseId 与门禁快照', exec.body.releaseId === rel.body.id && !!exec.body.gateSnapshot, exec.body);
  const firstExecId = exec.body.id;

  console.log('# 活动动态障碍：release 拒绝 / 已放行后失效');
  let ob = await call('POST', '/api/dynamic-obstacles', { cellId: 'cell-01', center: { x: 950, y: 0, z: 0 }, size: { x: 100, y: 100, z: 100 } });
  check('动态障碍上报成功', ob.status === 200 && ob.body.status === 'active');
  await sleep(2);

  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('障碍活动时执行被阻断', exec.status === 409);
  check('阻断含 dynamic-obstacle-present', codesOf(exec.body).includes('dynamic-obstacle-present'), exec.body);
  check('历史 release 失效(release-stale)', codesOf(exec.body).includes('release-stale'), exec.body);
  check('stale 指向障碍上报事件', (exec.body.failures.find((f: any) => f.code === 'release-stale')?.stale || []).includes('dynamic-obstacle-reported-after-release'), exec.body);

  console.log('# 障碍清除后仍需重新放行，重新 release 后恢复');
  const clr = await call('POST', `/api/dynamic-obstacles/${ob.body.id}/clear`, {});
  check('障碍清除成功', clr.status === 200 && clr.body.status === 'cleared');
  const clrDup = await call('POST', `/api/dynamic-obstacles/${ob.body.id}/clear`, {});
  check('重复清除返回 409 且可解释', clrDup.status === 409 && clrDup.body.code === 'obstacle-already-cleared');

  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('障碍清除但未重新 release 仍阻断', exec.status === 409 && codesOf(exec.body).includes('release-stale'), exec.body);

  let rel2 = await call('POST', `/api/paths/${A.id}/release`, {});
  check('清除后重新 release 放行', rel2.status === 200 && rel2.body.status === 'released', rel2.body);
  check('新 release 与旧 release 不同', rel2.body.id !== rel.body.id);
  check('旧 release 被标记 supersededAt', !!rel.body.supersededAt || (await call('GET', `/api/paths/${A.id}/releases`)).body.releases.find((r: any) => r.id === rel.body.id)?.supersededAt, 'old not superseded');
  dup = await call('POST', `/api/paths/${A.id}/release`, {});
  check('新 release 的重复申请仍被拒绝', dup.status === 409 && dup.body.code === 'release-already-active');

  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('重新放行后执行成功', exec.status === 200 && exec.body.status === 'completed');

  console.log('# TCP 标定过期 / 更换标定');
  const expired = await call('POST', '/api/calibrations', { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.3, validDays: -1 });
  check('可登记已过期标定记录', expired.status === 200);
  let blockedRel = await call('POST', `/api/paths/${A.id}/release`, {});
  check('标定过期时 release 被拒绝', blockedRel.status === 409 && blockedRel.body.code === 'release-blocked');
  check('拒绝原因含 tcp-calibration', (blockedRel.body.gate?.failures || []).includes('tcp-calibration'), blockedRel.body);
  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('标定过期时执行被阻断', exec.status === 409 && codesOf(exec.body).includes('tcp-calibration'), exec.body);

  await call('POST', '/api/calibrations', { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.4, angleErrorDeg: 0.1, validDays: 30 });
  let rel3 = await call('POST', `/api/paths/${A.id}/release`, {});
  check('标定恢复后重新 release 放行', rel3.status === 200 && rel3.body.status === 'released');
  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('标定恢复后执行成功', exec.status === 200 && exec.body.status === 'completed');

  console.log('# 重新碰撞校验后旧 release 不得继续放行');
  v = await call('POST', `/api/paths/${A.id}/validate`, {});
  check('再次碰撞校验产生新记录', v.status === 200 && typeof v.body.id === 'string'); // id exists
  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('校验记录变化后执行被阻断', exec.status === 409 && codesOf(exec.body).includes('release-stale'), exec.body);
  check('stale 原因为 collision-validation-changed', (exec.body.failures.find((f: any) => f.code === 'release-stale')?.stale || []).includes('collision-validation-changed'), exec.body);
  const rel4 = await call('POST', `/api/paths/${A.id}/release`, {});
  check('重新 release 放行', rel4.status === 200);
  exec = await call('POST', '/api/executions', { pathId: A.id });
  check('重新放行后执行成功', exec.status === 200 && exec.body.status === 'completed');

  console.log('# 碰撞校验未通过 / 未校验 / 缺少标定 的 release 可解释拒绝');
  const B = await newPath(collisionWp);
  v = await call('POST', `/api/paths/${B.id}/validate`, {});
  check('碰撞校验不通过', v.status === 200 && v.body.valid === false);
  blockedRel = await call('POST', `/api/paths/${B.id}/release`, {});
  check('release 返回 409 blocked', blockedRel.status === 409 && blockedRel.body.status === 'blocked');
  check('拒绝原因含 collision-validation', blockedRel.body.gate.failures.includes('collision-validation'), blockedRel.body);
  exec = await call('POST', '/api/executions', { pathId: B.id });
  check('阻断引用被拒绝的 releaseId', exec.status === 409 && codesOf(exec.body).includes('release-blocked') && exec.body.failures.find((f: any) => f.code === 'release-blocked')?.releaseId === blockedRel.body.id, exec.body);
  check('阻断不重新计算碰撞校验(沿用存储结果)', exec.body.gate.checks['collision-validation'].detail.includes('stored validation'), exec.body);

  const C = await newPath(cleanWp);
  blockedRel = await call('POST', `/api/paths/${C.id}/release`, {});
  check('从未校验的轨迹 release 被拒', blockedRel.status === 409 && blockedRel.body.gate.failures.includes('collision-validation'));

  const D = await newPath(cleanWp, 'missing-tool');
  await call('POST', `/api/paths/${D.id}/validate`, {});
  blockedRel = await call('POST', `/api/paths/${D.id}/release`, {});
  check('缺少标定 release 被拒', blockedRel.status === 409 && blockedRel.body.gate.failures.includes('tcp-calibration'), blockedRel.body);

  console.log('# 历史记录与审计可查询');
  const releases = await call('GET', `/api/paths/${A.id}/releases`);
  check('路径维度 release 历史可查', releases.status === 200 && releases.body.releases.length >= 5, releases.body);
  check('历史中保留 blocked/released/superseded 全生命周期', releases.body.releases.some((r: any) => r.status === 'released' && r.supersededAt) && releases.body.releases.at(-1).status === 'released');
  const allRel = await call('GET', '/api/safety/releases');
  check('全局 release 记录可查', allRel.status === 200 && Array.isArray(allRel.body) && allRel.body.length >= releases.body.releases.length);
  const execs = await call('GET', '/api/executions');
  check('执行记录列表可查', execs.status === 200 && execs.body.some((e: any) => e.id === firstExecId));
  const oneExec = await call('GET', `/api/executions/${firstExecId}`);
  check('单条执行记录可查', oneExec.status === 200 && oneExec.body.id === firstExecId);
  const missingExec = await call('GET', '/api/executions/nope');
  check('未知执行返回 404', missingExec.status === 404);
  const audit = await call('GET', '/api/audit');
  const actions = audit.body.map((a: any) => a.action);
  for (const a of ['path.release', 'path.release.duplicate', 'execution.blocked', 'execution.complete', 'dynamic-obstacle.report', 'dynamic-obstacle.clear', 'calibration.register']) {
    check(`审计包含 ${a}`, actions.includes(a), actions);
  }
  const blockedAudit = audit.body.find((a: any) => a.action === 'execution.blocked');
  check('阻断审计记录失败原因', !!blockedAudit && Array.isArray(blockedAudit.payload.failures) && blockedAudit.payload.failures.length > 0, blockedAudit);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
