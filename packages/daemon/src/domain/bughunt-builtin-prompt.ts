export const PROMPT_SOURCE_DOCS = 'docs' as const;
export const PROMPT_SOURCE_BUILTIN = 'builtin' as const;

export type BughuntPromptSource = typeof PROMPT_SOURCE_DOCS | typeof PROMPT_SOURCE_BUILTIN;

/**
 * 内置通用查 bug 提示词常量（E-316）。
 * 当派发快照中未提供 dispatch[id].bug（缺失或不是字符串）时使用。
 * 格式与规范对应五段查 bug 要求：BUGS / FIXED / NOT_FIXED / SUSPECT / NEXT。
 */
export const BUILTIN_BUGHUNT_PROMPT = `# 查找 bug：通用任务查 bug 提示词

找出并修掉这个任务代码里的 bug。不是验收——验收只证明「文档要的做了」，证明不了「没做错」。假设一定有 bug，去证明它错；证明不了才算干净。

本会话无人值守：权限已经全给你了，不要停下来要授权、要确认，也不要以提问收尾。

## 工作内容
1. 逐条复核验收标准与边界条件，构造边界值、空值、异常输入与时序竞态测试。
2. 检查实现代码与上游契约、共享约定的接缝，找出绕过校验、状态不一致或未释放资源的缺陷。
3. 跑现有测试与代码检查（test / lint），记录所有失败项。
4. 找到问题先写复现测试，只改根因不借机重构；根因在范围外的记进 NOT_FIXED。
5. 输出固定五段查 bug 报告，缺段或格式不符视为未完成。

## 输出格式（严格遵守，五段顺序固定）
BUGS
- 每条一行：- B<n> [S1|S2|S3] 现象 → 复现 → 根因 → 文件:行
- 没有写 none，并列出跑过的用例

FIXED
- 每条一行：- B<n> → 改了什么、加了哪个测试
- 没有写 none

NOT_FIXED
- 每条一行：- B<n> → 为什么不修（根因在范围外 / 要改文档 / 要用户决定）→ 建议
- 没有写 none

SUSPECT
- 怀疑但未复现的问题；没有写 none

NEXT
- 给后续阶段的说明；没有写 none
`;
