import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

type Joint = { min: number; max: number; maxVelocity: number };
type Robot = { id: string; name: string; dof: number; joints: Joint[]; reach: number };
type Pose = { x: number; y: number; z: number; rx: number; ry: number; rz: number };
type Waypoint = Pose & { speed: number; blend: number; process?: Record<string, number> };

const app = Fastify({ logger: true });
const now = () => new Date().toISOString();

const robots: Robot[] = [{ id: 'robot-01', name: '六轴焊接机器人 A', dof: 6, reach: 1450, joints: [-170, 170, -100, 135, -180, 180].map((_, i) => ({ min: [-170, -100, -150, -180, -120, -360][i], max: [170, 100, 150, 180, 120, 360][i], maxVelocity: [180, 160, 170, 360, 360, 500][i] })) }];
const cells: any[] = [{ id: 'cell-01', name: '车身侧围焊装单元', robotId: 'robot-01', tools: [{ id: 'gun-01', mass: 12, tcp: { x: 0, y: 0, z: 220 } }], obstacles: [{ id: 'fence', type: 'box', center: { x: 0, y: 0, z: 700 }, size: { x: 1800, y: 1800, z: 1600 } }, { id: 'fixture', type: 'box', center: { x: 500, y: 0, z: 300 }, size: { x: 420, y: 360, z: 300 } }] }];

const paths: any[] = [];
const validations: any[] = [];
const plans: any[] = [];
const executions: any[] = [];
const audit: any[] = [];

function log(action: string, payload: any) {
  audit.push({ id: randomUUID(), time: now(), action, payload });
}

function distance(a: Pose, b: Pose) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
function insideBox(p: Pose, b: any) { return Math.abs(p.x - b.center.x) <= b.size.x / 2 && Math.abs(p.y - b.center.y) <= b.size.y / 2 && Math.abs(p.z - b.center.z) <= b.size.z / 2; }
function validatePath(path: any) {
  const robot = robots.find(x => x.id === path.robotId);
  const cell = cells.find(x => x.id === path.cellId);
  const errors: any[] = [];
  let length = 0, maxSpeed = 0;
  for (let i = 1; i < path.waypoints.length; i++) {
    const prev = path.waypoints[i - 1], cur = path.waypoints[i];
    length += distance(prev, cur);
    maxSpeed = Math.max(maxSpeed, Number(cur.speed || 0));
    for (const ob of cell?.obstacles || []) {
      if (insideBox(cur, ob) || insideBox({ x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2, z: (prev.z + cur.z) / 2, rx: 0, ry: 0, rz: 0 }, ob))
        errors.push({ type: 'collision', obstacleId: ob.id, segment: i - 1, clearance: 0 });
    }
  }
  for (const p of path.waypoints) {
    const reach = Math.hypot(p.x, p.y, p.z);
    if (reach > Number(robot?.reach || 0)) errors.push({ type: 'unreachable', waypoint: p });
    if (Math.abs(p.rx) > 180 || Math.abs(p.ry) > 180 || Math.abs(p.rz) > 360) errors.push({ type: 'orientation-limit', waypoint: p });
  }
  if (maxSpeed > 220) errors.push({ type: 'speed-limit', maxSpeed });
  return { valid: errors.length === 0, errors, length: Number(length.toFixed(2)), maxSpeed, estimatedSeconds: Number((length / Math.max(1, maxSpeed || 100)).toFixed(2)), singularityRisk: path.waypoints.filter((p: any) => Math.abs(p.z) < 80).length };
}

app.get('/health', async () => ({ ok: true, service: 'industrial-robot-trajectory-validation', time: now() }));
app.get('/api/cells', async () => cells);
app.get('/api/robots', async () => robots);

app.post('/api/paths', async (req: any, res) => {
  const b = req.body as any;
  if (!b.cellId || !b.robotId || !Array.isArray(b.waypoints) || b.waypoints.length < 2)
    return res.code(400).send({ error: 'cellId、robotId 和至少两个 waypoints 必填' });
  const p = { id: randomUUID(), version: 1, name: b.name || '未命名轨迹', cellId: b.cellId, robotId: b.robotId, toolId: b.toolId || null, waypoints: b.waypoints, process: b.process || {}, status: 'draft', createdAt: now() };
  paths.push(p);
  log('path.create', { id: p.id, cellId: p.cellId, robotId: p.robotId, toolId: p.toolId });
  return p;
});

app.post('/api/paths/:id/validate', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  const result = validatePath(p);
  const v = { id: randomUUID(), pathId: p.id, createdAt: now(), ...result };
  validations.push(v);
  p.lastValidationId = v.id;
  p.status = result.valid ? 'validated' : 'blocked';
  // Note: a standing release is NOT proactively torn down here — at execution
  // time the gate compares the release snapshot and rejects the stale release
  // with an explainable 'release-stale' reason.
  log('path.validate', v);
  return v;
});

app.post('/api/paths/:id/plan', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  const v = validations.filter(x => x.pathId === p.id).at(-1);
  if (!v?.valid) return res.code(409).send({ error: 'path must pass collision validation' });
  const b = req.body as any;
  const plan = { id: randomUUID(), pathId: p.id, controller: b.controller || 'RAPID', posture: b.posture || 'elbow-up', blendPolicy: b.blendPolicy || 'smooth', samplingMs: Number(b.samplingMs || 20), segments: p.waypoints.slice(1).map((w: any, i: number) => ({ index: i + 1, from: p.waypoints[i], to: w, acceleration: Number((Math.min(2.5, (w.speed || 100) / 80)).toFixed(2)) })), status: 'planned', createdAt: now() };
  plans.push(plan);
  log('trajectory.plan', plan);
  return plan;
});

app.post('/api/paths/:id/optimize', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  const candidates = [.75, 1, 1.2].map(scale => {
    const copy = { ...p, waypoints: p.waypoints.map((w: any) => ({ ...w, speed: Math.min(220, (w.speed || 100) * scale), blend: Math.min(100, (w.blend || 10) + scale * 5) })) };
    return { scale, validation: validatePath(copy), waypoints: copy.waypoints };
  }).filter(x => x.validation.valid).sort((a, b) => a.validation.estimatedSeconds - b.validation.estimatedSeconds);
  return { pathId: p.id, candidates, best: candidates[0] || null };
});

app.get('/api/paths/:id/compare', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  const versions = paths.filter(x => x.name === p.name).map(x => ({ id: x.id, version: x.version, validation: validations.filter(v => v.pathId === x.id).at(-1) }));
  return { pathId: p.id, versions };
});

app.get('/api/audit', async () => audit.slice(-100));

// ---------------------------------------------------------------------------
// Safety domain: TCP calibration, workpiece frames, dynamic obstacles,
// safety release gate and the execution entry that the gate guards.
// ---------------------------------------------------------------------------
const calibrations: any[] = [{ id: 'cal-01', robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.42, angleErrorDeg: .18, status: 'valid', validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: now() }];
const dynamicObstacles: any[] = [];
const frames: any[] = [{ id: 'frame-body', name: '车身基准坐标系', origin: { x: 0, y: 0, z: 0 }, rotation: { rx: 0, ry: 0, rz: 0 }, status: 'verified' }];
const safetyReleases: any[] = [];

// Current, most recently registered calibration for the path's robot/tool pair.
// Expiry is evaluated against the clock, not against a stale status flag.
function currentCalibration(path: any) {
  return calibrations
    .filter(x => x.robotId === path.robotId && x.toolId === path.toolId)
    .at(-1);
}

function isCalibrationUsable(c: any, at = Date.now()) {
  return !!c && c.status === 'valid' && Date.parse(c.validUntil) > at;
}

function activeObstaclesForPath(path: any) {
  return dynamicObstacles.filter(x => x.status === 'active' && x.cellId === path.cellId);
}

// Monotonic per-cell counter of obstacle reports. Clearing an obstacle does
// not roll it back, so a transient obstacle that appears and vanishes between
// release and execution is still detectable as a changed world.
function obstacleEpoch(cellId: string) {
  return dynamicObstacles.filter(x => x.cellId === cellId).length;
}

/**
 * Live safety gate. It only READS current state — it never re-runs collision
 * validation (re-validation is an explicit operator action) and a pass here is
 * a point-in-time verdict, not a standing authorization.
 */
function safetyGate(path: any) {
  const cell = cells.find(x => x.id === path.cellId);
  const v = validations.filter(x => x.pathId === path.id).at(-1);
  const calibration = currentCalibration(path);
  if (calibration && Date.parse(calibration.validUntil) <= Date.now()) calibration.status = 'expired';
  const activeDynamic = activeObstaclesForPath(path);
  const failures: string[] = [];
  if (!cell) failures.push('cell-missing');
  if (!v || !v.valid) failures.push('collision-validation');
  if (!isCalibrationUsable(calibration)) failures.push('tcp-calibration');
  if (activeDynamic.length) failures.push('dynamic-obstacle-present');
  return {
    released: failures.length === 0,
    failures,
    checkedAt: now(),
    validationId: v?.id || null,
    calibrationId: calibration?.id || null,
    calibrationStatus: calibration ? (Date.parse(calibration.validUntil) <= Date.now() ? 'expired' : calibration.status) : null,
    dynamicObstacleIds: activeDynamic.map((x: any) => x.id),
    obstacleEpoch: obstacleEpoch(path.cellId)
  };
}

// Snapshot of the field conditions at the instant a release is granted.
// Execution must prove the world still matches this snapshot; otherwise the
// historical release cannot authorize it.
function releaseSnapshot(path: any, gate: any) {
  return {
    validationId: gate.validationId,
    calibrationId: gate.calibrationId,
    // Active ids must match (always empty at a releasable gate) and the cell's
    // obstacle report epoch must not have advanced, so a report-clear blip
    // after release forces a fresh release instead of going unnoticed.
    dynamicObstacleIds: [...gate.dynamicObstacleIds].sort(),
    obstacleEpoch: gate.obstacleEpoch
  };
}

function sameSnapshot(a: any, b: any) {
  return a.validationId === b.validationId
    && a.calibrationId === b.calibrationId
    && JSON.stringify(a.dynamicObstacleIds) === JSON.stringify(b.dynamicObstacleIds)
    && a.obstacleEpoch === b.obstacleEpoch;
}

function latestRelease(pathId: string) {
  return safetyReleases.filter(r => r.pathId === pathId).at(-1);
}

// A release is live while it has not been superseded by a new release and has
// not been invalidated by changing field conditions.
function activeReleaseForPath(pathId: string) {
  return safetyReleases.filter(r => r.pathId === pathId && r.status === 'released').at(-1);
}

function supersedeReleasesForPath(path: any, reason: string) {
  for (const r of safetyReleases) {
    if (r.pathId === path.id && r.status === 'released') {
      r.status = 'superseded';
      r.endedAt = now();
      r.endReason = reason;
    }
  }
}

function invalidateReleasesForPath(path: any, reason: string) {
  for (const r of safetyReleases) {
    if (r.pathId === path.id && r.status === 'released') {
      r.status = 'invalidated';
      r.endedAt = now();
      r.endReason = reason;
    }
  }
}

/**
 * Decide whether execution is allowed right now. The release must exist, be
 * live, and every condition captured at release time must still hold. Each
 * branch produces a distinct, auditable reason.
 */
function evaluateExecution(path: any) {
  const gate = safetyGate(path);
  const release = activeReleaseForPath(path.id);

  if (!release) {
    return {
      allowed: false,
      reason: 'no-active-release',
      failures: [...gate.failures, ...(gate.failures.includes('release-required') ? [] : ['release-required'])],
      gate,
      release: latestRelease(path.id) ? { id: latestRelease(path.id)!.id, status: latestRelease(path.id)!.status, endReason: latestRelease(path.id)!.endReason || null } : null
    };
  }

  if (!gate.released) {
    // Field conditions changed after release: the standing release is dead.
    invalidateReleasesForPath(path, gate.failures.join('+'));
    path.status = gate.failures.includes('collision-validation') ? 'blocked' : 'validated';
    return {
      allowed: false,
      reason: 'release-invalidated',
      failures: gate.failures,
      gate,
      release: { id: release.id, status: 'invalidated', endReason: gate.failures.join('+') }
    };
  }

  const snapshot = releaseSnapshot(path, gate);
  if (!sameSnapshot(release.snapshot, snapshot)) {
    // Gate currently passes, but on a different validation/calibration than the
    // one the operator released. Re-issue the release explicitly.
    invalidateReleasesForPath(path, 'release-snapshot-mismatch');
    path.status = 'validated';
    return {
      allowed: false,
      reason: 'release-stale',
      failures: ['release-stale'],
      gate,
      release: { id: release.id, status: 'invalidated', endReason: 'release-snapshot-mismatch' },
      expectedSnapshot: release.snapshot,
      currentSnapshot: snapshot
    };
  }

  return { allowed: true, reason: 'ok', gate, release: { id: release.id, status: release.status } };
}

app.get('/api/calibrations', async () => calibrations);
app.post('/api/calibrations', async (req: any, res) => {
  const b = req.body as any;
  if (!b.robotId || !b.toolId || b.tcpErrorMm == null)
    return res.code(400).send({ error: 'robotId、toolId、tcpErrorMm 必填' });
  const c = {
    id: randomUUID(),
    robotId: b.robotId,
    toolId: b.toolId,
    tcpErrorMm: Number(b.tcpErrorMm),
    angleErrorDeg: Number(b.angleErrorDeg || 0),
    status: Number(b.tcpErrorMm) <= 1 && Number(b.angleErrorDeg || 0) <= .5 ? 'valid' : 'invalid',
    validUntil: new Date(Date.now() + Number(b.validMs ?? Number(b.validDays ?? 30) * 86400000)).toISOString(),
    createdAt: now()
  };
  calibrations.push(c);
  log('calibration.create', { id: c.id, robotId: c.robotId, toolId: c.toolId, status: c.status, validUntil: c.validUntil });
  return c;
});

app.post('/api/frames', async (req: any, res) => {
  const b = req.body as any;
  if (!b.name || !b.origin) return res.code(400).send({ error: 'name 和 origin 必填' });
  const f = { id: randomUUID(), name: b.name, origin: b.origin, rotation: b.rotation || { rx: 0, ry: 0, rz: 0 }, status: 'pending-verification', createdAt: now() };
  frames.push(f);
  return f;
});

app.get('/api/dynamic-obstacles', async (req: any) => {
  const cellId = (req.query as any)?.cellId;
  return cellId ? dynamicObstacles.filter(x => x.cellId === cellId) : dynamicObstacles;
});

app.post('/api/dynamic-obstacles', async (req: any, res) => {
  const b = req.body as any;
  if (!b.cellId || !b.center || !b.size) return res.code(400).send({ error: 'cellId、center、size 必填' });
  const o = { id: randomUUID(), cellId: b.cellId, center: b.center, size: b.size, source: b.source || 'safety-scanner', status: 'active', reportedAt: now() };
  dynamicObstacles.push(o);
  log('dynamic-obstacle.report', { id: o.id, cellId: o.cellId });
  return o;
});

app.post('/api/dynamic-obstacles/:id/clear', async (req: any, res) => {
  const o = dynamicObstacles.find(x => x.id === (req.params as any).id);
  if (!o) return res.code(404).send({ error: 'dynamic obstacle not found' });
  if (o.status === 'active') {
    o.status = 'cleared';
    o.clearedAt = now();
    // A release granted while this obstacle was present (i.e. none could have
    // been granted) or an earlier one cannot silently revive; clearing only
    // allows a fresh release request.
    log('dynamic-obstacle.clear', { id: o.id, cellId: o.cellId });
  }
  return o;
});

app.get('/api/safety/releases', async (req: any) => {
  const pathId = (req.query as any)?.pathId;
  return pathId ? safetyReleases.filter(r => r.pathId === pathId) : safetyReleases;
});

app.get('/api/paths/:id/release', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  return { pathId: p.id, latest: latestRelease(p.id) || null, history: safetyReleases.filter(r => r.pathId === p.id) };
});

// Safety release: explicit operator gate. It records an explainable verdict on
// every call. Blocked calls never create a standing release; duplicate calls
// while the same release is still live are rejected idempotently.
app.post('/api/paths/:id/release', async (req: any, res) => {
  const p = paths.find(x => x.id === (req.params as any).id);
  if (!p) return res.code(404).send({ error: 'path not found' });
  const operator = (req.body as any)?.operator || 'cell-supervisor';
  const gate = safetyGate(p);

  if (gate.released) {
    const active = activeReleaseForPath(p.id);
    if (active && sameSnapshot(active.snapshot, releaseSnapshot(p, gate))) {
      const duplicate = {
        error: 'release already active for current path state; re-issue only after conditions change',
        code: 'release-duplicate',
        releaseId: active.id,
        status: active.status,
        gate,
        checkedAt: now()
      };
      log('path.release.duplicate', { pathId: p.id, releaseId: active.id, operator, gate });
      return res.code(409).send(duplicate);
    }
    // Either no live release, or the field state moved on (obstacle cleared and
    // stayed clear, new calibration/validation, ...): supersede earlier releases
    // and grant a fresh one bound to the current snapshot.
    supersedeReleasesForPath(p, 'new-release');
    const release = {
      id: randomUUID(),
      pathId: p.id,
      gate,
      snapshot: releaseSnapshot(p, gate),
      status: 'released' as const,
      operator,
      createdAt: now(),
      endedAt: null,
      endReason: null
    };
    safetyReleases.push(release);
    p.status = 'released';
    log('path.release', release);
    return res.code(200).send(release);
  }

  // Refused: record the attempt with the precise failing conditions so the
  // decision is explainable, but do not alter or consume any prior release.
  const previous = latestRelease(p.id);
  const attempt = {
    id: randomUUID(),
    pathId: p.id,
    gate,
    snapshot: releaseSnapshot(p, gate),
    status: 'blocked' as const,
    operator,
    createdAt: now(),
    previousReleaseId: previous ? previous.id : null
  };
  safetyReleases.push(attempt);
  log('path.release.blocked', attempt);
  return res.code(409).send({
    error: 'safety release blocked',
    code: 'release-blocked',
    failures: gate.failures,
    release: attempt
  });
});

// Execution entry: a valid collision check alone is NOT enough. Requires a
// live release whose every precondition still holds at execution time.
app.post('/api/executions', async (req: any, res) => {
  const b = req.body as any;
  const p = paths.find(x => x.id === b.pathId);
  if (!p) return res.code(404).send({ error: 'path not found' });

  const decision = evaluateExecution(p);
  if (!decision.allowed) {
    log('execution.blocked', {
      pathId: p.id,
      reason: decision.reason,
      failures: decision.failures,
      release: decision.release
    });
    return res.code(409).send({
      error: 'execution blocked by safety gate',
      code: decision.reason,
      failures: decision.failures,
      gate: decision.gate,
      release: decision.release,
      expectedSnapshot: (decision as any).expectedSnapshot,
      currentSnapshot: (decision as any).currentSnapshot
    });
  }

  const e: any = {
    id: randomUUID(),
    pathId: p.id,
    releaseId: decision.release!.id,
    mode: b.mode || 'dry-run',
    startedAt: now(),
    status: 'running',
    progress: 0,
    telemetry: [],
    gateSnapshot: decision.gate,
    safety: { eStop: false, protectiveStop: false }
  };
  executions.push(e);
  // A release authorizes exactly one execution: consume it so a historical
  // release verdict can never stand in for a fresh safety review.
  const release = safetyReleases.find(r => r.id === decision.release!.id);
  if (release) {
    release.status = 'consumed';
    release.endedAt = now();
    release.endReason = 'consumed-by-execution';
  }
  log('execution.start', { id: e.id, pathId: p.id, releaseId: e.releaseId, mode: e.mode });
  for (let i = 0; i < p.waypoints.length; i++) {
    e.progress = Math.round((i + 1) / p.waypoints.length * 100);
    e.telemetry.push({ time: now(), waypoint: i, joints: p.waypoints[i], tcpSpeed: p.waypoints[i].speed });
  }
  e.status = 'completed';
  e.finishedAt = now();
  log('execution.complete', e);
  return e;
});

app.get('/api/executions', async (req: any) => {
  const pathId = (req.query as any)?.pathId;
  const list = pathId ? executions.filter(x => x.pathId === pathId) : executions;
  // Strip bulky telemetry from the collection view; fetch one execution for detail.
  return list.map(({ telemetry, ...meta }) => meta);
});

app.get('/api/executions/:id', async (req: any, res) => {
  const e = executions.find(x => x.id === (req.params as any).id);
  if (!e) return res.code(404).send({ error: 'execution not found' });
  return e;
});

app.post('/api/executions/:id/stop', async (req: any, res) => {
  const e = executions.find(x => x.id === (req.params as any).id);
  if (!e) return res.code(404).send({ error: 'execution not found' });
  e.status = 'protective-stopped';
  e.safety.protectiveStop = true;
  e.stoppedAt = now();
  log('execution.stop', { id: e.id, pathId: e.pathId });
  return e;
});

app.post('/api/executions/:id/telemetry', async (req: any, res) => {
  const e = executions.find(x => x.id === (req.params as any).id);
  if (!e) return res.code(404).send({ error: 'execution not found' });
  const b = req.body as any;
  if (b.jointErrorDeg != null && Number(b.jointErrorDeg) > 2) {
    e.status = 'protective-stopped';
    e.safety.protectiveStop = true;
    e.stopReason = 'joint tracking error';
  }
  if (b.tcpForceN != null && Number(b.tcpForceN) > 180) {
    e.status = 'protective-stopped';
    e.safety.protectiveStop = true;
    e.stopReason = 'TCP force threshold exceeded';
  }
  e.telemetry.push({ time: now(), ...b });
  return e;
});

export default app;

// Test-only hook: restore all in-memory domain state to the seeded baseline.
export function __resetSafetyStateForTests() {
  paths.length = 0;
  validations.length = 0;
  plans.length = 0;
  executions.length = 0;
  audit.length = 0;
  dynamicObstacles.length = 0;
  safetyReleases.length = 0;
  calibrations.length = 0;
  calibrations.push({ id: 'cal-01', robotId: 'robot-01', toolId: 'gun-01', tcpErrorMm: 0.42, angleErrorDeg: .18, status: 'valid', validUntil: new Date(Date.now() + 30 * 86400000).toISOString(), createdAt: now() });
}

// Only bind the port when started directly; importing the app (tests) stays side-effect free.
const entry = process.argv[1]?.replace(/\\/g, '/') || '';
if (entry.endsWith('/src/index.ts') || entry.endsWith('/dist/index.js')) {
  app.listen({ port: Number(process.env.PORT || 6303), host: '127.0.0.1' }).catch(err => {
    app.log.error(err);
    process.exit(1);
  });
}
