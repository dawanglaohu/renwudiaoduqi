export const PROMPT_SOURCE_DOCS = 'docs' as const;
export const PROMPT_SOURCE_BUILTIN = 'builtin' as const;

export type WrapupPromptSource = typeof PROMPT_SOURCE_DOCS | typeof PROMPT_SOURCE_BUILTIN;

/**
 * 内置通用收口提示词常量（E-296）。
 * 当文档未导出 dispatchBatches 或没有与本批当前任务集合相等的条目时使用。
 * 格式严格对应八段收口规范：BATCH_SUMMARY / TESTS / BUGS / FIXED / NOT_FIXED / SUSPECT / RECORD / NEXT。
 */
export const BUILTIN_WRAPUP_PROMPT = `# 批次收口：批次小结 · 测试 · 查 bug

本批任务已全部落地。单任务审查各看各的一层，看不见任务之间的接缝；这一步把整批当整体验一遍，并给下一批留一份小结。假设一定有 bug，去证明它错；证明不了才算干净。

本会话无人值守：权限已经全给你了，不要停下来要授权、要确认，也不要以提问收尾。

## 收口工作内容
1. 先跑现有全部测试与代码检查（test / lint），记录所有失败项。
2. 逐任务在当前分支上复核验收标准与边界条件，指到具体代码位置。
3. 查五类接缝：模块间调用契约、同一边界被跨任务处理的连贯性、全项目共用约定执行、跨任务并发与状态共享、端到端主链路。
4. 找到问题先写复现测试，只改根因不借机重构；根因在前面批次的也修复并标「跨批」，根因在文档的记进 NOT_FIXED 标「doc-issue」。
5. 输出固定八段收口报告，缺段或格式不符视为未完成。

## 输出格式（严格遵守，八段顺序固定）
BATCH_SUMMARY
- 本批合起来交付了什么，三五句小结

TESTS
- pass | fail | skipped → 跑的命令与结果；skipped 写原因

BUGS
- 每条一行：- B<n> [S1|S2|S3] 涉及 <任务ID>（跨批加「跨批」）：现象 → 复现 → 根因 → 文件:行
- 没有写 none，并列出跑过的用例

FIXED
- 每条一行：- B<n> → commit/说明：改了什么、加了哪个测试
- 没有写 none

NOT_FIXED
- 每条一行：- B<n> [S1|S2|S3] 涉及 <任务ID>（跨批加「跨批」）：现象 → 复现 → 根因 → 文件:行 → 为什么不修（doc-issue / 要用户决定 / 牵动太大该单开任务）
- 没有写 none

SUSPECT
- 怀疑但未复现的问题；没有写 none

RECORD
- verdict: clean | fixed | open

NEXT
- 给下一批的提醒、接口契约说明或遗留注意事项；没有写 none
`;
