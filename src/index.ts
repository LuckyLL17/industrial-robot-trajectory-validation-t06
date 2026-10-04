import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';

type Joint={min:number;max:number;maxVelocity:number}; type Robot={id:string;name:string;dof:number;joints:Joint[];reach:number}; type Pose={x:number;y:number;z:number;rx:number;ry:number;rz:number}; type Waypoint=Pose&{speed:number;blend:number;process?:Record<string,number>};
const app=Fastify({logger:true});const now=()=>new Date().toISOString();
const robots:Robot[]=[{id:'robot-01',name:'六轴焊接机器人 A',dof:6,reach:1450,joints:[-170,170,-100,135,-180,180].map((_,i)=>({min:[-170,-100,-150,-180,-120,-360][i],max:[170,100,150,180,120,360][i],maxVelocity:[180,160,170,360,360,500][i]}))}];
const cells:any[]=[{id:'cell-01',name:'车身侧围焊装单元',robotId:'robot-01',tools:[{id:'gun-01',mass:12,tcp:{x:0,y:0,z:220}}],obstacles:[{id:'fence',type:'box',center:{x:0,y:0,z:700},size:{x:1800,y:1800,z:1600}},{id:'fixture',type:'box',center:{x:500,y:0,z:300},size:{x:420,y:360,z:300}}]}];
const paths:any[]=[];const validations:any[]=[];const plans:any[]=[];const executions:any[]=[];const audit:any[]=[];const log=(action:string,payload:any)=>audit.push({id:randomUUID(),time:now(),action,payload});
function distance(a:Pose,b:Pose){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z)}
function insideBox(p:Pose,b:any){return Math.abs(p.x-b.center.x)<=b.size.x/2&&Math.abs(p.y-b.center.y)<=b.size.y/2&&Math.abs(p.z-b.center.z)<=b.size.z/2}
function validatePath(path:any){const robot=robots.find(x=>x.id===path.robotId);const cell=cells.find(x=>x.id===path.cellId);const errors:any[]=[];let length=0,maxSpeed=0;for(let i=1;i<path.waypoints.length;i++){const prev=path.waypoints[i-1],cur=path.waypoints[i];length+=distance(prev,cur);maxSpeed=Math.max(maxSpeed,Number(cur.speed||0));for(const ob of cell?.obstacles||[]){if(insideBox(cur,ob)||insideBox({x:(prev.x+cur.x)/2,y:(prev.y+cur.y)/2,z:(prev.z+cur.z)/2,rx:0,ry:0,rz:0},ob))errors.push({type:'collision',obstacleId:ob.id,segment:i-1,clearance:0});}}
for(const p of path.waypoints){const reach=Math.hypot(p.x,p.y,p.z);if(reach>Number(robot?.reach||0))errors.push({type:'unreachable',waypoint:p});if(Math.abs(p.rx)>180||Math.abs(p.ry)>180||Math.abs(p.rz)>360)errors.push({type:'orientation-limit',waypoint:p});}
if(maxSpeed>220)errors.push({type:'speed-limit',maxSpeed});return{valid:errors.length===0,errors,length:Number(length.toFixed(2)),maxSpeed,estimatedSeconds:Number((length/Math.max(1,maxSpeed||100)).toFixed(2)),singularityRisk:path.waypoints.filter((p:any)=>Math.abs(p.z)<80).length};}
app.get('/health',async()=>({ok:true,service:'industrial-robot-trajectory-validation',time:now()}));
app.get('/api/cells',async()=>cells);app.get('/api/robots',async()=>robots);
app.post('/api/paths',async(req:any,res)=>{const b=req.body as any;if(!b.cellId||!b.robotId||!Array.isArray(b.waypoints)||b.waypoints.length<2)return res.code(400).send({error:'cellId、robotId 和至少两个 waypoints 必填'});const p={id:randomUUID(),version:1,name:b.name||'未命名轨迹',cellId:b.cellId,robotId:b.robotId,toolId:b.toolId||null,waypoints:b.waypoints,process:b.process||{},status:'draft',createdAt:now()};paths.push(p);return p;});
app.post('/api/paths/:id/validate',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const result=validatePath(p);const v={id:randomUUID(),pathId:p.id,createdAt:now(),...result};validations.push(v);p.lastValidationId=v.id;p.status=result.valid?'validated':'blocked';log('path.validate',v);return v;});
app.post('/api/paths/:id/plan',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const v=validations.filter(x=>x.pathId===p.id).at(-1);if(!v?.valid)return res.code(409).send({error:'path must pass collision validation'});const b=req.body as any;const plan={id:randomUUID(),pathId:p.id,controller:b.controller||'RAPID',posture:b.posture||'elbow-up',blendPolicy:b.blendPolicy||'smooth',samplingMs:Number(b.samplingMs||20),segments:p.waypoints.slice(1).map((w:any,i:number)=>({index:i+1,from:p.waypoints[i],to:w,acceleration:Number((Math.min(2.5,(w.speed||100)/80)).toFixed(2))})),status:'planned',createdAt:now()};plans.push(plan);log('trajectory.plan',plan);return plan;});
app.post('/api/paths/:id/optimize',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const candidates=[.75,1,1.2].map(scale=>{const copy={...p,waypoints:p.waypoints.map((w:any)=>({...w,speed:Math.min(220,(w.speed||100)*scale),blend:Math.min(100,(w.blend||10)+scale*5)}))};return{scale,validation:validatePath(copy),waypoints:copy.waypoints}}).filter(x=>x.validation.valid).sort((a,b)=>a.validation.estimatedSeconds-b.validation.estimatedSeconds);return{pathId:p.id,candidates,best:candidates[0]||null};});
app.get('/api/paths/:id/compare',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});const versions=paths.filter(x=>x.name===p.name).map(x=>({id:x.id,version:x.version,validation:validations.filter(v=>v.pathId===x.id).at(-1)}));return{pathId:p.id,versions};});
app.get('/api/audit',async()=>audit.slice(-100));

// Advanced operations: calibration, workpiece frames, dynamic obstacles and safety release gates.
const calibrations:any[]=[{id:'cal-01',robotId:'robot-01',toolId:'gun-01',tcpErrorMm:0.42,angleErrorDeg:.18,status:'valid',validUntil:new Date(Date.now()+30*86400000).toISOString()}];
const dynamicObstacles:any[]=[]; const frames:any[]=[{id:'frame-body',name:'车身基准坐标系',origin:{x:0,y:0,z:0},rotation:{rx:0,ry:0,rz:0},status:'verified'}]; const safetyReleases:any[]=[];
app.get('/api/calibrations',async()=>calibrations);
app.post('/api/calibrations',async(req:any,res)=>{const b=req.body as any;if(!b.robotId||!b.toolId||b.tcpErrorMm==null)return res.code(400).send({error:'robotId、toolId、tcpErrorMm 必填'});const c={id:randomUUID(),robotId:b.robotId,toolId:b.toolId,tcpErrorMm:Number(b.tcpErrorMm),angleErrorDeg:Number(b.angleErrorDeg||0),status:Number(b.tcpErrorMm)<=1&&Number(b.angleErrorDeg||0)<=.5?'valid':'invalid',validUntil:new Date(Date.now()+Number(b.validDays||30)*86400000).toISOString(),createdAt:now()};calibrations.push(c);log('calibration.register',{id:c.id,robotId:c.robotId,toolId:c.toolId,status:c.status,validUntil:c.validUntil});return c;});
app.post('/api/frames',async(req:any,res)=>{const b=req.body as any;if(!b.name||!b.origin)return res.code(400).send({error:'name 和 origin 必填'});const f={id:randomUUID(),name:b.name,origin:b.origin,rotation:b.rotation||{rx:0,ry:0,rz:0},status:'pending-verification',createdAt:now()};frames.push(f);return f;});
app.post('/api/dynamic-obstacles',async(req:any,res)=>{const b=req.body as any;if(!b.cellId||!b.center||!b.size)return res.code(400).send({error:'cellId、center、size 必填'});const o={id:randomUUID(),cellId:b.cellId,center:b.center,size:b.size,source:b.source||'safety-scanner',status:'active',reportedAt:now()};dynamicObstacles.push(o);log('dynamic-obstacle.report',{id:o.id,cellId:o.cellId,source:o.source,reportedAt:o.reportedAt});return o;});
app.post('/api/dynamic-obstacles/:id/clear',async(req:any,res)=>{const o=dynamicObstacles.find(x=>x.id===(req.params as any).id);if(!o)return res.code(404).send({error:'dynamic obstacle not found'});if(o.status!=='active')return res.code(409).send({error:'obstacle already cleared',code:'obstacle-already-cleared',obstacle:o});o.status='cleared';o.clearedAt=now();log('dynamic-obstacle.clear',{id:o.id,cellId:o.cellId,clearedAt:o.clearedAt});return o;});

// Live safety gate: reads the LAST STORED collision validation result (never recomputes it),
// current TCP calibration state and the currently active dynamic obstacles of the cell.
// The returned object doubles as the snapshot frozen into an accepted safety release.
function latestCalibration(path:any){return calibrations.filter(x=>x.robotId===path.robotId&&x.toolId===path.toolId).at(-1);}
function safetyGate(path:any){
  const cell=cells.find(x=>x.id===path.cellId);
  const v=validations.filter(x=>x.pathId===path.id).at(-1);
  const calibration=latestCalibration(path);
  if(calibration&&calibration.status==='valid'&&Date.parse(calibration.validUntil)<=Date.now())calibration.status='expired';
  const activeDynamic=dynamicObstacles.filter(x=>x.cellId===path.cellId&&x.status==='active');
  const checks:Record<string,{pass:boolean;detail:string}>={
    'cell-missing':{pass:!!cell,detail:cell?`workcell ${cell.id} found`:'workcell not found'},
    'collision-validation':{pass:!!v?.valid,detail:v?(v.valid?`stored validation ${v.id} passed`:`stored validation ${v.id} failed with ${v.errors.length} issue(s)`):'no collision validation recorded for path'},
    'tcp-calibration':{pass:!!calibration&&calibration.status==='valid',detail:calibration?(calibration.status==='valid'?`calibration ${calibration.id} valid until ${calibration.validUntil}`:`calibration ${calibration.id} is ${calibration.status}`):`no calibration found for robot ${path.robotId} / tool ${String(path.toolId)}`},
    'dynamic-obstacle-present':{pass:activeDynamic.length===0,detail:activeDynamic.length?`active obstacles: ${activeDynamic.map((o:any)=>o.id).join(', ')}`:'no active dynamic obstacles in cell'},
  };
  const failures=Object.entries(checks).filter(([,c])=>!c.pass).map(([k])=>k);
  return {released:failures.length===0,failures,checks,checkedAt:now(),validationId:v?.id||null,calibrationId:calibration?.id||null,activeObstacleIds:activeDynamic.map((o:any)=>o.id)};
}
function latestReleaseFor(pathId:string){return safetyReleases.filter(r=>r.pathId===pathId).at(-1);}
// A release only matches the current conditions when nothing it certified has changed:
// the stored validation, the calibration record and the obstacle timeline of the cell.
function releaseMatchesConditions(release:any,gate:any){
  if(release.gate.validationId!==gate.validationId)return false;
  if(release.gate.calibrationId!==gate.calibrationId)return false;
  const reportedAfterRelease=dynamicObstacles.some((o:any)=>o.cellId===release.cellId&&Date.parse(o.reportedAt)>Date.parse(release.createdAt));
  return !reportedAfterRelease;
}

// Execution admission: an accepted release is mandatory AND every gate condition must still
// hold right now. A historical release never authorizes execution once a condition changed;
// the operator must clear the condition and obtain a fresh release.
function evaluateExecution(path:any){
  const gate=safetyGate(path);
  const v=validations.filter(x=>x.pathId===path.id).at(-1);
  const release=latestReleaseFor(path.id);
  const failures:any[]=gate.failures.map((code:string)=>({code,detail:gate.checks[code].detail}));
  if(!release){
    failures.push({code:'release-required',detail:'no safety release recorded; call POST /api/paths/:id/release first'});
  }else if(release.status!=='released'){
    failures.push({code:'release-blocked',detail:`latest release ${release.id} was rejected`,releaseId:release.id,blockingFailures:release.gate.failures});
  }else{
    if(release.supersededAt)failures.push({code:'release-superseded',detail:`release ${release.id} was superseded by release ${latestReleaseFor(path.id)?.id}`,releaseId:release.id});
    const stale:string[]=[];
    if(release.gate.validationId!==(v?.id||null))stale.push('collision-validation-changed');
    if(release.gate.calibrationId!==gate.calibrationId)stale.push('tcp-calibration-changed');
    const postReleaseObstacles=dynamicObstacles.filter((o:any)=>o.cellId===path.cellId&&Date.parse(o.reportedAt)>Date.parse(release.createdAt));
    if(postReleaseObstacles.length)stale.push('dynamic-obstacle-reported-after-release');
    if(stale.length)failures.push({code:'release-stale',detail:'conditions changed after the release; obtain a fresh release',releaseId:release.id,stale,obstacleIds:postReleaseObstacles.map((o:any)=>o.id)});
  }
  return {allowed:failures.length===0,failures,checkedAt:now(),validationId:v?.id||null,releaseId:release?.id||null,gate};
}

app.post('/api/paths/:id/release',async(req:any,res)=>{
  const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});
  const gate=safetyGate(p);
  const latest=latestReleaseFor(p.id);
  // Duplicate application: an active release still matching current conditions is not re-issued.
  if(latest&&latest.status==='released'&&!latest.supersededAt&&gate.released&&releaseMatchesConditions(latest,gate)){
    const duplicate={error:'path already has an active release for the current conditions',code:'release-already-active',release:latest};
    log('path.release.duplicate',{pathId:p.id,releaseId:latest.id,failures:[]});
    return res.code(409).send(duplicate);
  }
  const release={id:randomUUID(),pathId:p.id,cellId:p.cellId,gate,status:gate.released?'released':'blocked',operator:(req.body as any)?.operator||'cell-supervisor',createdAt:now(),supersededAt:null as string|null};
  safetyReleases.push(release);
  if(gate.released){
    // A new accepted release retires every previously accepted release: history stays queryable,
    // but old releases must never authorize later states.
    for(const r of safetyReleases){if(r!==release&&r.pathId===p.id&&r.status==='released'&&!r.supersededAt)r.supersededAt=now();}
    p.status='released';
  }
  log('path.release',{id:release.id,pathId:p.id,status:release.status,failures:gate.failures,operator:release.operator});
  if(!gate.released)return res.code(409).send({error:'safety release rejected',code:'release-blocked',...release});
  return release;
});

app.post('/api/executions',async(req:any,res)=>{
  const b=req.body as any;
  if(!b?.pathId)return res.code(400).send({error:'pathId 必填'});
  const p=paths.find(x=>x.id===b.pathId);if(!p)return res.code(404).send({error:'path not found'});
  const readiness=evaluateExecution(p);
  if(!readiness.allowed){
    log('execution.blocked',{pathId:p.id,mode:b.mode||'dry-run',failures:readiness.failures,releaseId:readiness.releaseId,validationId:readiness.validationId});
    return res.code(409).send({error:'execution blocked by safety gate',code:'execution-safety-blocked',...readiness});
  }
  const release=latestReleaseFor(p.id);
  const e:any={id:randomUUID(),pathId:p.id,releaseId:release.id,mode:b.mode||'dry-run',startedAt:now(),status:'running',progress:0,telemetry:[],safety:{eStop:false,protectiveStop:false},gateSnapshot:release.gate};executions.push(e);
  for(let i=0;i<p.waypoints.length;i++){e.progress=Math.round((i+1)/p.waypoints.length*100);e.telemetry.push({time:now(),waypoint:i,joints:p.waypoints[i],tcpSpeed:p.waypoints[i].speed});}
  e.status='completed';e.finishedAt=now();log('execution.complete',e);return e;});
app.get('/api/executions',async()=>executions);
app.get('/api/executions/:id',async(req:any,res)=>{const e=executions.find(x=>x.id===(req.params as any).id);if(!e)return res.code(404).send({error:'execution not found'});return e;});
app.get('/api/paths/:id/releases',async(req:any,res)=>{const p=paths.find(x=>x.id===(req.params as any).id);if(!p)return res.code(404).send({error:'path not found'});return{pathId:p.id,releases:safetyReleases.filter(r=>r.pathId===p.id)};});
app.post('/api/executions/:id/stop',async(req:any,res)=>{const e=executions.find(x=>x.id===(req.params as any).id);if(!e)return res.code(404).send({error:'execution not found'});e.status='protective-stopped';e.safety.protectiveStop=true;e.stoppedAt=now();log('execution.stop',{id:e.id,stoppedAt:e.stoppedAt});return e;});
app.post('/api/executions/:id/telemetry',async(req:any,res)=>{const e=executions.find(x=>x.id===(req.params as any).id);if(!e)return res.code(404).send({error:'execution not found'});const b=req.body as any;if(b.jointErrorDeg!=null&&Number(b.jointErrorDeg)>2){e.status='protective-stopped';e.safety.protectiveStop=true;e.stopReason='joint tracking error';}if(b.tcpForceN!=null&&Number(b.tcpForceN)>180){e.status='protective-stopped';e.safety.protectiveStop=true;e.stopReason='TCP force threshold exceeded';}e.telemetry.push({time:now(),...b});return e;});
app.get('/api/safety/releases',async()=>safetyReleases);app.get('/api/dynamic-obstacles',async()=>dynamicObstacles);

app.listen({port:Number(process.env.PORT||6303),host:'127.0.0.1'}).catch(err=>{app.log.error(err);process.exit(1)});
