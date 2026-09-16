## BATCH_SUMMARY
收口运行验证发现 2 处问题，其中 B1 已修，B2 涉及前置批次尚未修复。

## TESTS
pass
- unit tests all green

## BUGS
- B1 [S2] 涉及 M4-T1: 缺少默认模型 → 传空配置调用 → 未回落 defaults → registry.ts:32
- B2 [S1] 涉及 M3-T6（跨批）：跨批提示词截断 → 长文本输入测试 → 超长时丢弃尾段 → prompt.ts:88

## FIXED
- B1: commit 8e4b2a1 已修复

## NOT_FIXED
- none

## SUSPECT
- none

## RECORD
verdict: clean

## NEXT
需由 M8-T7 为 B2 派发修复运行。
