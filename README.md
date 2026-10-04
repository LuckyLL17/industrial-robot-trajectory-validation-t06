# 工业机器人离线轨迹规划与碰撞验证服务

纯后端 Node.js + TypeScript + Fastify 服务，默认无需 Docker、数据库或消息中间件即可运行。

## 启动

```bash
npm install
npm run dev
```

默认端口：`6303`。健康检查：`GET /health`。

## 业务闭环

- 领域状态模型与事件输入
- 可回放的时间序列/仿真流程
- 约束校验与风险门禁
- 方案版本、审计轨迹与异常处置
- 所有状态暂存于进程内，便于本机演示；可扩展为数据库、事件总线和实时流处理架构

## 增强业务闭环

- TCP 工具标定误差和标定有效期管理
- 工件基准坐标系登记
- 动态障碍物上报与清除
- 轨迹发布前的碰撞、标定、动态障碍物多重安全门禁
- 执行中关节跟踪误差和 TCP 力阈值保护停机
- 轨迹 release、执行遥测和安全审计

扩展接口：`/api/calibrations`、`/api/frames`、`/api/dynamic-obstacles`、`/api/paths/:id/release`、`/api/executions/:id/telemetry`。

## 执行安全门禁

`POST /api/executions` 不再只看碰撞校验，而是实时复核全部现场条件：

1. 已存储的最近一次碰撞校验通过（门禁只读取校验记录，不重新计算）；
2. TCP 标定存在、状态 `valid` 且未过 `validUntil`；
3. 所属工作单元当前没有 `active` 动态障碍；
4. 存在针对上述条件快照的、状态为 `released` 且未被取代（`supersededAt`）的 release。

任一条件缺失或在 release 之后失效（校验记录变化、标定更换/过期、release 后有新障碍上报），执行返回 `409 execution-safety-blocked`，`failures` 中给出可解释原因（`release-required`、`release-blocked`、`release-stale`、`dynamic-obstacle-present`、`tcp-calibration`、`collision-validation` 等）。历史 release 不会永久放行：条件变化后必须先清除风险并重新申请 release。

- release 被拒绝：`409 release-blocked`，响应携带门禁快照与逐项 `checks`。
- 对当前条件已有有效 release 时重复申请：`409 release-already-active`，回指原 release。
- release/执行历史可查询：`GET /api/paths/:id/releases`、`GET /api/executions`、`GET /api/executions/:id`、`GET /api/safety/releases`，阻断与重复申请均写入 `/api/audit`。
- 安全测试：`PORT=6399 npx tsx src/index.ts` 后运行 `BASE=http://127.0.0.1:6399 npx tsx scripts/security-e2e.mts`。
