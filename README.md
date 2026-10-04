# 工业机器人离线轨迹规划与碰撞验证服务

纯后端 Node.js + TypeScript + Fastify 服务，默认无需 Docker、数据库或消息中间件即可运行。

## 启动

```bash
npm install
npm run dev
```

默认端口：`6303`。健康检查：`GET /health`。测试：`npm test`（使用 `fastify.inject`，无需监听端口）。

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

## 执行安全门禁（release ↔ execution）

`POST /api/executions` 不再只看最后一次碰撞校验。执行前必须同时满足：

1. 轨迹最近一次碰撞校验有效（`collision-validation`）；
2. 当前机器人/工具的 TCP 标定存在、状态 valid 且未过期（`tcp-calibration`）；
3. 所属单元内没有活动动态障碍（`dynamic-obstacle-present`）；
4. 存在针对**当前状态**的、仍存活的安全 release（`released`）。

`POST /api/paths/:id/release` 在四项都满足时才放行，并记录现场快照
（`validationId`、`calibrationId`、活动障碍列表、单元障碍上报纪元）。语义：

- 条件不满足：返回 `409 release-blocked`，失败原因写入审计，不产生有效放行；
- 同一现场状态下重复申请：返回 `409 release-duplicate`，不重复发放；
- release 后任何条件失效（新增障碍、标定过期、重新碰撞校验等），执行入口
  返回 `409 release-invalidated` / `409 release-stale` 并把旧 release 标记为
  `invalidated`；障碍清除或重新标定**不会**自动恢复旧 release，必须重新申请；
- 即使障碍被上报后又清除（现场恢复为空），障碍上报纪元的变化也会使旧 release
  失效，历史 release 永远不能永久放行；
- 一次 release 只授权一次执行，执行创建后该 release 变为 `consumed`；
- 门禁只读取当前状态，不会用重新调用碰撞校验代替放行流程。

查询：`GET /api/paths/:id/release`（最新结果与历史）、`GET /api/safety/releases`、
`GET /api/executions`、`GET /api/executions/:id`；所有放行、拒绝、阻断与执行
决定均写入 `GET /api/audit`。
