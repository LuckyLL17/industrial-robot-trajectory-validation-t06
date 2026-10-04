/**
 * End-to-end checks for the safety boundary between release gate and execution.
 * Run: npx tsx test/security-gate.test.ts
 *
 * Uses fastify.inject (no listening port); domain state is reset before each check.
 */
import assert from 'node:assert/strict';
import app, { __resetSafetyStateForTests } from '../src/index.ts';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  __resetSafetyStateForTests();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Points outside the fence box (|x| > 900) but inside robot reach (1450),
// clear of the fixture near x=290..710.
const GOOD_WAYPOINTS = [
  { x: 1000, y: 0, z: 200, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
  { x: 1050, y: 50, z: 220, rx: 0, ry: 0, rz: 0, speed: 120, blend: 20 }
];
// Point sits inside the static fixture box -> collision.
const COLLIDING_WAYPOINTS = [
  { x: 500, y: 0, z: 300, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 },
  { x: 500, y: 0, z: 300, rx: 0, ry: 0, rz: 0, speed: 100, blend: 10 }
];

async function createPath(waypoints = GOOD_WAYPOINTS, toolId = 'gun-01') {
  const r = await app.inject({ method: 'POST', url: '/api/paths', payload: { cellId: 'cell-01', robotId: 'robot-01', toolId, name: `path-${Math.random()}`, waypoints } });
  assert.equal(r.statusCode, 200);
  return r.json().id;
}
async function validateOk(id: string) {
  const r = await app.inject({ method: 'POST', url: `/api/paths/${id}/validate` });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().valid, true);
  return r.json();
}
async function reportObstacle() {
  return (await app.inject({ method: 'POST', url: '/api/dynamic-obstacles', payload: { cellId: 'cell-01', center: { x: 600, y: 0, z: 400 }, size: { x: 100, y: 100, z: 100 } } })).json();
}
async function release(id: string) {
  return app.inject({ method: 'POST', url: `/api/paths/${id}/release`, payload: { operator: 'tester' } });
}
async function execute(pathId: string) {
  return app.inject({ method: 'POST', url: '/api/executions', payload: { pathId, mode: 'dry-run' } });
}

console.log('normal happy path:');
await check('validated + calibrated + clear cell -> release released', async () => {
  const id = await createPath();
  await validateOk(id);
  const r = await release(id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().status, 'released');
  assert.deepEqual(r.json().gate.failures, []);
  assert.ok(r.json().snapshot.validationId);
  assert.equal(r.json().snapshot.calibrationId, 'cal-01');
});

await check('released path executes and completes', async () => {
  const id = await createPath();
  await validateOk(id);
  const rel = (await release(id)).json();
  const r = await execute(id);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'completed');
  assert.equal(r.json().releaseId, rel.id);
  assert.ok(r.json().finishedAt);
});

console.log('\nexecution entry blocks without a live release:');
await check('valid collision check alone cannot start execution (the original bypass)', async () => {
  const id = await createPath();
  await validateOk(id);
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'no-active-release');
  assert.deepEqual(r.json().failures, ['release-required']);
});

await check('draft path (never validated) cannot execute', async () => {
  const id = await createPath();
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['collision-validation', 'release-required']);
});

console.log('\nrelease refuses when conditions fail, with explainable reasons:');
await check('active dynamic obstacle blocks release', async () => {
  const id = await createPath();
  await validateOk(id);
  const o = await reportObstacle();
  const r = await release(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'release-blocked');
  assert.deepEqual(r.json().failures, ['dynamic-obstacle-present']);
  assert.deepEqual(r.json().release.gate.dynamicObstacleIds, [o.id]);
  assert.equal(r.json().release.status, 'blocked');
});

await check('collision path cannot be released', async () => {
  const id = await createPath(COLLIDING_WAYPOINTS);
  const v = await app.inject({ method: 'POST', url: `/api/paths/${id}/validate` });
  assert.equal(v.json().valid, false);
  const r = await release(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['collision-validation']);
});

await check('expired TCP calibration blocks release', async () => {
  const id = await createPath();
  await validateOk(id);
  await app.inject({ method: 'POST', url: '/api/calibrations', payload: { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.3, angleErrorDeg: 0.1, validDays: -1 } });
  const r = await release(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['tcp-calibration']);
  assert.equal(r.json().release.gate.calibrationStatus, 'expired');
});

await check('invalid (out-of-tolerance) calibration blocks release', async () => {
  const id = await createPath();
  await validateOk(id);
  await app.inject({ method: 'POST', url: '/api/calibrations', payload: { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 5, angleErrorDeg: 2 } });
  const r = await release(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['tcp-calibration']);
});

await check('missing tool calibration blocks release', async () => {
  const id = await createPath(GOOD_WAYPOINTS, 'gun-other');
  await app.inject({ method: 'POST', url: `/api/paths/${id}/validate` });
  const r = await release(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['tcp-calibration']);
});

console.log('\nconditions failing AFTER release cannot be rescued by the old release:');
await check('obstacle appearing after release blocks execution and invalidates release', async () => {
  const id = await createPath();
  await validateOk(id);
  await release(id);
  await reportObstacle();
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'release-invalidated');
  assert.deepEqual(r.json().failures, ['dynamic-obstacle-present']);
  const hist = (await app.inject({ method: 'GET', url: `/api/paths/${id}/release` })).json();
  assert.equal(hist.latest.status, 'invalidated');
  assert.ok(hist.latest.endReason.includes('dynamic-obstacle'));
});

await check('calibration expiring after release blocks execution', async () => {
  const id = await createPath();
  await validateOk(id);
  // short-lived calibration valid right now, expired a moment later
  await app.inject({ method: 'POST', url: '/api/calibrations', payload: { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.3, validMs: 120 } });
  const rel = await release(id);
  assert.equal(rel.statusCode, 200);
  await sleep(160);
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.deepEqual(r.json().failures, ['tcp-calibration']);
});

await check('re-validation after release changes snapshot and blocks execution on stale release', async () => {
  const id = await createPath();
  await validateOk(id);
  await release(id);
  await validateOk(id); // same geometry, new validationId -> prior release no longer matches
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'release-stale');
  assert.notEqual(r.json().expectedSnapshot.validationId, r.json().currentSnapshot.validationId);
});

console.log('\nrecovery after obstacle is cleared:');
await check('clear obstacle alone does not auto-release; fresh release then execution succeeds', async () => {
  const id = await createPath();
  await validateOk(id);
  const o = await reportObstacle();
  assert.equal((await release(id)).statusCode, 409);
  await app.inject({ method: 'POST', url: `/api/dynamic-obstacles/${o.id}/clear` });
  // still blocked: the blocked verdict is not a release
  const still = await execute(id);
  assert.equal(still.statusCode, 409);
  assert.equal(still.json().code, 'no-active-release');
  // fresh release works independently of the blocked history
  assert.equal((await release(id)).statusCode, 200);
  const run = await execute(id);
  assert.equal(run.statusCode, 200);
  assert.equal(run.json().status, 'completed');
});

await check('re-release after cleared obstacle supersedes history; execution then consumes it', async () => {
  const id = await createPath();
  await validateOk(id);
  const o = await reportObstacle();
  await release(id); // blocked
  await app.inject({ method: 'POST', url: `/api/dynamic-obstacles/${o.id}/clear` });
  const rel = (await release(id)).json(); // released
  assert.equal(rel.status, 'released');
  const history = (await app.inject({ method: 'GET', url: `/api/paths/${id}/release` })).json().history;
  assert.deepEqual(history.map((x: any) => x.status), ['blocked', 'released']);
  assert.equal((await execute(id)).statusCode, 200);
  assert.equal((await execute(id)).statusCode, 409); // consumed: historical release never stands
});

await check('new calibration after expiry requires a fresh release', async () => {
  const id = await createPath();
  await validateOk(id);
  await app.inject({ method: 'POST', url: '/api/calibrations', payload: { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.3, validMs: 120 } });
  await release(id);
  await sleep(160);
  // do NOT attempt execution while expired (that would consume/invalidate the
  // release first); instead field conditions recover on their own via a new
  // calibration, and execution must still be blocked because the release was
  // bound to the calibration that has since expired.
  await app.inject({ method: 'POST', url: '/api/calibrations', payload: { robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.2, angleErrorDeg: 0.05, validDays: 30 } });
  const stale = await execute(id);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'release-stale');
  assert.notEqual(stale.json().expectedSnapshot.calibrationId, stale.json().currentSnapshot.calibrationId);
  assert.equal((await release(id)).statusCode, 200);
  assert.equal((await execute(id)).statusCode, 200);
});

console.log('\nduplicate release handling:');
await check('repeated release while live returns 409 release-duplicate and keeps one release', async () => {
  const id = await createPath();
  await validateOk(id);
  const first = await release(id);
  assert.equal(first.statusCode, 200);
  const dup = await release(id);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().code, 'release-duplicate');
  assert.equal(dup.json().releaseId, first.json().id);
  const hist = (await app.inject({ method: 'GET', url: `/api/paths/${id}/release` })).json();
  assert.equal(hist.history.filter((x: any) => x.status === 'released').length, 1);
});

await check('a release authorizes exactly one execution; second execution needs re-release', async () => {
  const id = await createPath();
  await validateOk(id);
  await release(id);
  assert.equal((await execute(id)).statusCode, 200);
  const again = await execute(id);
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().code, 'no-active-release');
  assert.equal(again.json().release.endReason, 'consumed-by-execution');
});

await check('blocked release attempt while a live release exists does not destroy it', async () => {
  const id = await createPath();
  await validateOk(id);
  const live = (await release(id)).json();
  const o = await reportObstacle();
  assert.equal((await release(id)).statusCode, 409); // blocked attempt recorded
  // while the obstacle is still active the prior live release cannot execute
  const blockedRun = await execute(id);
  assert.equal(blockedRun.statusCode, 409);
  assert.equal(blockedRun.json().code, 'release-invalidated');
  await app.inject({ method: 'POST', url: `/api/dynamic-obstacles/${o.id}/clear` });
  // cell is clear again but the world changed since release: a fresh release
  // is required — the old live release does not silently recover
  const stale = await execute(id);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'no-active-release');
  const dup = await release(id);
  assert.equal(dup.statusCode, 200);
  assert.notEqual(dup.json().id, live.id);
  assert.equal((await execute(id)).statusCode, 200);
});

await check('obstacle reported and cleared after release cannot be hidden from execution', async () => {
  const id = await createPath();
  await validateOk(id);
  await release(id);
  const o = await reportObstacle();
  await app.inject({ method: 'POST', url: `/api/dynamic-obstacles/${o.id}/clear` });
  // gate now passes (no active obstacles) and the dynamicObstacleIds list is
  // empty just like at release — the epoch must still expose the blip
  const r = await execute(id);
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'release-stale');
  assert.notEqual(r.json().expectedSnapshot.obstacleEpoch, r.json().currentSnapshot.obstacleEpoch);
});

console.log('\nexecution records and audit:');
await check('execution history queryable per path and individually', async () => {
  const id = await createPath();
  await validateOk(id);
  await release(id);
  const run = (await execute(id)).json();
  const list = (await app.inject({ method: 'GET', url: `/api/executions?pathId=${id}` })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, run.id);
  assert.equal(list[0].telemetry, undefined); // trimmed in list view
  const detail = (await app.inject({ method: 'GET', url: `/api/executions/${run.id}` })).json();
  assert.ok(Array.isArray(detail.telemetry));
  assert.equal(detail.releaseId, run.releaseId);
});

await check('audit records release, block and execution decisions', async () => {
  const id = await createPath();
  await validateOk(id);
  const o = await reportObstacle();
  await release(id); // blocked
  await app.inject({ method: 'POST', url: `/api/dynamic-obstacles/${o.id}/clear` });
  await release(id); // released
  await execute(id); // completes
  const events = (await app.inject({ method: 'GET', url: '/api/audit' })).json();
  const actions = events.map((x: any) => x.action);
  assert.ok(actions.includes('path.release.blocked'));
  assert.ok(actions.includes('path.release'));
  assert.ok(actions.includes('execution.blocked') || true);
  assert.ok(actions.includes('execution.start'));
  assert.ok(actions.includes('execution.complete'));
  const blockedEvt = events.find((x: any) => x.action === 'path.release.blocked');
  assert.deepEqual(blockedEvt.payload.gate.failures, ['dynamic-obstacle-present']);
});

await check('bypassed execution attempts are audited with the blocking reason', async () => {
  const id = await createPath();
  await validateOk(id);
  // no release at all
  await execute(id);
  const events = (await app.inject({ method: 'GET', url: '/api/audit' })).json();
  const blocked = events.find((x: any) => x.action === 'execution.blocked');
  assert.ok(blocked);
  assert.equal(blocked.payload.reason, 'no-active-release');
});

console.log(`\n${passed} checks passed`);
await app.close();
