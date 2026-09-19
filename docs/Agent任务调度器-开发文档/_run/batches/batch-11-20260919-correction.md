---
batch: 11
tasks: M7-T5, M7-T7, M8-T6, M9-T10, M9-T8, M9-T9
date: 2026-09-19
verdict: fixed
tests: pass
pr: none
note: 更正 2026-09-19 收口记录的三项误报，并真正补齐日志尾读/delta 合行/重拉与多流档位单点判定。
---

## 交付了什么

这是第 11 批的更正收口。2026-09-19 记录把审计计划中的 M9-T8/M9-T9 修复误写成已进入 PR #116；核对 main 后确认对应 Web 源码仍为旧实现。本更正用修复前失败的回归测试重现五个断点，再提交真实生产补丁与派发记录更正。

## 测试

- 修复前：`pnpm exec vitest run packages/web/test/log-window.test.ts packages/web/test/stream-column.test.ts` 为 5 条新增回归全部失败，分别命中首屏方向、delta 合行、实时段驱逐后的重拉、重复宽度断点和粗指针手机化。
- 修复后聚焦：`packages/web/test/batch-11-log-seams.test.ts`、`log-window.test.ts`、`stream-column.test.ts` 共 57/57 通过；真实 React hook 通过 shared ROUTES 调用日志端点并验证首屏尾读及重新锚定。
- `pnpm -w check`：159/159 测试文件，1867 通过、32 条平台条件跳过；49 个错误码、深浅主题对比度、架构禁令、480 文件 Biome 与 TypeScript 全部通过。

## 发现与修复

- C1 [S2] M9-T8：首屏对小日志不传 `direction`，daemon 默认 forward，打开会话读到头部；现显式 `direction:'backward'`，手机/桌面只改变 limit。
- C2 [S2] M9-T8：`agent_message_chunk` / `agent_thought_chunk` 是 token delta，旧代码每个 chunk 都创建日志行；现同 kind 的未闭合 delta 原位合并，遇换行或 kind 边界才新建逻辑行，未读计数按逻辑行增长。
- C3 [S2] M9-T8：实时事件撑满六段并驱逐全部 REST 段后，`hasOlder=true` 但没有字节游标，向上加载按钮成为空操作；现识别该状态并从 REST 尾部重新锚定。
- C4 [S3] M9-T9：`computeDensityTier` 已给出 full，视图又用裸 `width>=1440` 判一次布局；现 full 档仅按流数布局，断点决策仍只有 `useDensityTier()` 一处。
- C5 [S3] M9-T9：粗指针桌面档被 `density.isTouch` 强制套手机停止确认和 tail-only；现手机行为只由 `phone/phone-xs` 档触发，触屏笔电仍只放大命中区。

## 遗留

- M9-T8：按数组 index 保存展开态、进度行识别过宽、折叠历史未统一清洗/截断、截断 payload 提示与“用系统程序打开原文件”执行端仍为 S3，未在本次更正中扩大范围。
- M9-T9：afterBody 与审批双槽、五段外壳 grid token、无效 utility 与运行时重挂测试仍为 S3，由 M9-T21/M9-T25 接线时继续复核。

## 给下一批的提醒

批次记录只能声明实际进入该 PR 的代码；计划、审计结论和工作树未提交改动都不是已修证据。日志实时事件是 delta 语义，REST 日志是可游标分段，两者拼接必须保留这个区别。
