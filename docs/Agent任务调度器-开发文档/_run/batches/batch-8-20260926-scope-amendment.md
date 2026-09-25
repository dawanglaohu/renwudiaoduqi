---
batch: 8
tasks: M10-T4, M4-T14, M6-T10, M6-T4, M6-T7, M6-T9, M7-T2, M8-T10, M8-T5, M9-T5
date: 2026-09-26
verdict: open
tests: skipped
skip_reason: 本记录仅登记已授权的返工范围拆分；完整批次收口须待返工落地后重跑。
pr: https://github.com/dawanglaohu/renwudiaoduqi/pull/153
note: R8-T97041355 交付结构化事件和失败回收接线；厂商当前没有模型专用类型字段，E-36 精确归因由新返工继续追踪，批次保持 open。
repair_schema: 1
---

## 范围修正

2026-09-26 用户同意拆分。Codex CLI 0.156.1 和 0.157.0 的真实无效模型请求在 app-server 只提供 `codexErrorInfo: other`，exec 只有自由文本。旧的所谓“真实脱敏” `turn/failed` 测试行实际由测试代码构造，不能作为厂商协议证据。R8-T97041355 的任务围栏在来源记录中定点修正为事件与状态处理接线；原 E-36 精确归因要求由下列独立返工承接，前一任务落地不代表问题闭合。

## 遗留

- E-36：等待至少一家实际可派发的 agent 在模型被拒时提供模型专用的结构化类型字段；此前一律按 E-348 零产出转人工，不从报错文本推断。

## 返工任务

```task
stable-key: e36-vendor-typed-model-rejection
title: E-36 沿真实厂商协议和生产派发入口接通模型专用结构化拒绝信号
module: M8
source-tasks: M8-T5
depends-on: M8-T5, R8-T97041355
input: Codex CLI 0.156.1/0.157.0 的真实无效模型请求在 app-server 的 turn/completed.error 中只有 codexErrorInfo=other，exec 的 turn.failed.error 只有 message；现有合成 code/type 帧不能证明真实 agent 会发 run.model_rejected。基础事件与失败回收接线由 R8-T97041355 交付，但 E-36 精确归因仍未生效。
output: 找到至少一家实际可派发 agent 的模型专用类型化拒绝字段，保存脱敏原始协议录制，沿该家生产派发入口映射 run.model_rejected 并打开 reportsModelRejection；保持其他未验证 agent 的能力位为 false 和 E-348 回退，不从自由文本、通用 HTTP 状态或 codexErrorInfo=other 推断；更新相关文档、单元和真实入口测试。
acceptance: 1) 至少一家实际可派发 agent 的脱敏原始运行录制包含可区分模型拒绝与其他失败的结构化 code/type，写明 agent 和版本；无此信号不得判通过 2) 该家适配器对录制信号恰产出一条 run.model_rejected，同样报错只在 message/stderr 或通用错误类别中时不产出，reportsModelRejection 仅在此家为 true 3) 从真实生产派发入口用无效模型验证 failed、queued_reason、泳道释放、审批卡作废及不进入 E-348；零产出且无类型字段仍进入 awaiting_human 4) 13 节 E-36、19 节 M8-T5 与能力位说明一致，补丁经 maintain_docs.py begin/sync/verify 登记 5) pnpm -w check 和相关真实 agent 验证通过，回报实际验证家数
edges: E-36, E-348
paths: packages/daemon/src/adapters/codex/map-events.ts, packages/daemon/src/adapters/codex/capabilities.ts, packages/daemon/src/adapters/claude/map-events.ts, packages/daemon/src/adapters/claude/capabilities.ts, packages/daemon/src/service/dispatch.ts, packages/daemon/src/service/run.ts, packages/daemon/src/boot/container.ts, packages/daemon/test/unit/codex-adapter.test.ts, packages/daemon/test/integration/dispatch-spawn.test.ts, packages/daemon/test/integration/container-wiring.test.ts, docs/Agent任务调度器-开发文档/02-设计/10-接口约定.md, docs/Agent任务调度器-开发文档/03-质量/13-边界问题与异常处理.md, docs/Agent任务调度器-开发文档/04-执行/19-模块任务拆分.md
estimate: 1d
severity: S2
jev: none
```
