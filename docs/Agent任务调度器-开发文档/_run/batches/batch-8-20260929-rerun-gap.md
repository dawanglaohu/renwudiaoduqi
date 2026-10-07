---
batch: 8
tasks: M10-T4, M4-T14, M6-T10, M6-T4, M6-T7, M6-T9, M7-T2, M8-T10, M8-T5, M9-T5
date: 2026-09-29
verdict: open
tests: fail
note: 两次独立 CI 在 Batch 14 查 bug 重跑处失败；真实数据库对照确认非连续运行次数可导致重跑返回旧运行，须独立修复后复验。
repair_schema: 1
---

## 发现与证据

PR #161 的 `5f297693` 与 PR #170 的 `d79c780b` 均在 `e2e/batch-14-composition.test.ts:1745` 失败：查 bug 重跑 HTTP 返回 200，随后 35 秒内未出现新 bughunt 运行。两次运行分别为 GitHub Actions `36565871344`、`36566400701`。`pnpm -w check` 通过不能替代该端到端结果。

生产 `bughunt.ts:328` 按全部运行的最大次数生成查 bug 次数，单任务历史因跨任务交错可不连续；`rerun.ts:394` 却按本任务记录数加一，新次数可能撞上既有行。真实迁移、仓储、事务与 `createRerunService` 的最小对照：历史 `[1,2,3]` 创建次数 4 的 bughunt；历史 `[1,2,4]` 遇到唯一约束后回滚，约束兜底返回旧的 awaiting_human 实施运行，闸门仍等待。此对照确认生产缺陷；CI 未保存重跑响应体和全部运行次数，因此不将最小对照冒称为 CI 内部次数的直接记录。

完整输入输出与来源见 `_run/R8-T70356006.ci-blocker-20260929.json`。本记录不宣称已完成整批收口，也不修改原任务集合；第 8 批保持 open。

## 返工任务

```task
stable-key: rerun-noncontiguous-attempt-number
title: 修复非连续运行次数下原样重跑假成功并复验查 bug 生命周期
module: M8
source-tasks: M8-T5
depends-on: M8-T5, M7-T9, R12-T32133721
input: 查 bug 按全局最大次数加一，单任务历史可能跳号；重跑按记录数加一触发唯一冲突，事务回滚后兜底返回旧实施运行并报告 HTTP 200，两次 Batch 14 E2E 未等到新运行。
output: 重跑在不连续历史与真实事务下分配有效递增次数；幂等和约束恢复只返回与请求语义一致的运行；真实容器、HTTP 与浏览器链验证查 bug 失败重跑，失败保留可处理闸门和原始上下文。
acceptance: 1) 真实迁移与仓储复现 [1,2,4] 历史后，POST /runs/:id/rerun 创建新 bughunt，次数大于已有最大值，沿用原快照、agent、model 和父实施运行，不返回旧 implement 冒充成功 2) 相同幂等键返回同一新运行，不新增重复记录；真实事务回滚和唯一约束冲突不得误报成功或消失闸门 3) 覆盖跨任务交错、次数缺口与旧泳道已被其他任务占用，保持并发上限、泳道互斥和 bughunt_failed 闸门语义；不能靠放宽数据库约束修复 4) 经生产容器和 HTTP 证明新运行拉起、旧闸门被替代，查 bug 完成后父运行继续正确流程；保留旧运行拒绝重跑、已放行闸门拒绝和失败负例 5) 在最终 HEAD 执行 pnpm -w check、bughunt-lifecycle 集成和 Batch 14 浏览器 E2E，核对 rerun 响应体的新 id/kind/attemptNo，失败产物保留相关运行与闸门状态，不改宽断言或增加超时掩盖错误。
edges: E-177, E-323, E-331, E-265
paths: packages/daemon/src/boot/container.ts, packages/daemon/src/service/rerun.ts, packages/daemon/src/service/bughunt.ts, packages/daemon/src/service/dispatch.ts, packages/daemon/src/repo/runs.ts, packages/daemon/src/repo/tasks.ts, packages/daemon/test/unit/rerun.test.ts, packages/daemon/test/integration/bughunt-lifecycle.test.ts, packages/daemon/test/integration/pipeline-lanes.test.ts, e2e/batch-14-composition.test.ts
estimate: 1d
severity: S2
jev: none
```
