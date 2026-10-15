# 第 19 批第 2 轮修复代码独立复核

范围：工作树 D:/xiangmu/agent-scheduler-batch-19，分支 batch/19-20261014，比较基线 origin/main d4c6241。只复核 B1/B2/B3、M8-T13 AC1–8/E-360…370 的相关接缝、必要 M5 支持路径与受保护回填。批次记录、完整现场验收、PR、CI、GIF、合并及清理仍由主代理完成；此结论不表示整个批次已收口。

## Checklist

1. B1：当前成员 readiness 变为 false 后，queued 收口保持原运行/代次/额度，释放窗口与全局 Agent 名额；恢复后出队同一运行，已启动运行不受影响。
2. B2：暂停或源变化撤销异步预检后，只回收该调用明确新建且尚未受理的干净 Git 工作树；复用、未知归属、脏树和已受理资源保留；不 prune，不强删未合并分支；清理失败不遮蔽原始错误。
3. B3：冻结 Agent 临时不可用时维持原 queued 收口及 running 计划，权威执行 DTO 提供 agent_unavailable；恢复观测后自动续派，不换家、不增加尝试。
4. 必要 M5 路径归属已纳入 task-contracts.json，任务笔记仅修改受保护区块且代码位置与实际代码对应。
5. 复核当前代码及修复前失败证据，独立运行最小充分测试与改动文件检查。

## Action Trace

- 已读取用户粘贴请求、AGENTS.md、知识库入口、任务 M8-T13/M5-T1/M5-T4、测试策略、维护补丁、当前差异与 round2 日志。检查 unstaged/staged/recent history；开始复核时无新提交，完整修复为工作树差异。
- B1：读取 dispatch.ts:681、1941、2044 及全局 Agent/路径计数调用；queued 检查不影响 starting/running。真实容器回归核 ready=false、lane_no=null、contract_not_ready、lane.released、另一文档共享 Agent 的补位，以及恢复原 run ID/plan_json。
- B2：读取 container.ts:659、wrapup.ts:822、834、985、1223、1242 与 worktree.ts:734。归属只有 isReused===false；受理事务提交后 admitted=true。生产回收入口未传 force，M5 非强制检查登记失败即停止，Git remove 拒绝脏树，分支删除使用 -d，全仓 prune 已移除。
- B3：读取 dispatch.ts:2015/2048、document-execution.ts:581 及 M4 容器可用性数据来源。只选当前计划 wrapupRunIds 内 queued 的冻结 agent_id；已验收任务原 Agent 离线本身不重新阻断。精确回归核恢复原 run ID、plan 不改、只有一次物理尝试。
- 一层前置接缝：核 M3 提交前来源校验、M4 availability 注入、M5 回收接口、M7 收口服务入口、共享 lane.released 原因枚举与前端缓存失效，不重审历史任务。
- 已读取 B1 修复前变为 running/lane=1、B2 真 Git 撤销后残留登记、B3 离线后错误 failed、登记扫描失败仍删除分支的真实失败日志。当前精确回归全部通过。
- 初审发现 M8-T13 回填的 7 处新 wrapup.ts 行号漂移，已报告主代理。主代理定点改为 889/974/994/986/1261/1272/1556，现已逐处按语义复查；M8-T13 的 112 个代码引用无缺失/空白行。M8-T13、M5-T1、M5-T4 相对基线均只更改 code/notes 保护区块，验收定义未改。

## Diff Summary / Code Scope

运行时代码为 container.ts、dispatch.ts、document-execution.ts、wrapup.ts、workspace/worktree.ts。新增真实容器与真实 Git 归属回归位于 document-execution-routes.test.ts，M5 owning tests 为 worktree.test.ts 与 landing.test.ts。

M8-T13 的 supportPaths 精确新增三处：packages/daemon/src/workspace/worktree.ts、packages/daemon/test/unit/worktree.test.ts、packages/daemon/test/unit/landing.test.ts。wrapup.ts 大量行差异来自新 try/catch 的必要缩进，忽略空白后的差异保持在三处根因。

## Evaluation

- **Correctness**：当前完整 check 日志与独立最小测试均为绿；未发现剩余修复代码阻断。
- **Adequacy**：B1/B2/B3 的等待、占用释放、归属保护、恢复及权威 blocker 均由真实生产容器入口连接，真实 Git 测试覆盖撤销后的目录/登记/分支结果。整体 AC8 的最终现场交付仍留给主代理完成。
- **Excess**：未发现不必要的运行时重构或无关修改；M5 三处支持文件与保护区块回填均与修复直接相关。
- **Edge Cases**：覆盖暂停、源撤销、复用资源、脏目录、清理失败、已受理资源、Agent 离线恢复、已 landed Agent 离线、readiness 恢复及已运行阶段继续。非强制分支删除拒绝未合并引用，登记读取失败不会继续删除。

## Build & Test Results

以下独立命令在 WSL 工作树 /mnt/d/xiangmu/agent-scheduler-batch-19 执行，PATH=/mnt/d/xiangmu/.codex-plans/agent-scheduler-batch-19/bin:/usr/bin:/bin，未传 GIT_DIR/GIT_WORK_TREE，未改依赖平台、.git 指针、测试断言或超时。

1. `/usr/bin/node node_modules/vitest/vitest.mjs run packages/daemon/test/unit/worktree.test.ts packages/daemon/test/unit/landing.test.ts --maxWorkers=1 --minWorkers=1`
   - exit 0；2 files / 49 passed；86.33s。
   - 原始记录：m5-owning-units.log。
2. `/usr/bin/node node_modules/vitest/vitest.mjs run packages/daemon/test/integration/document-execution-routes.test.ts -t 'queued wrapup waits|real Git wrapup allocation|landed work does not remain blocked' --maxWorkers=1 --minWorkers=1`
   - exit 0；1 file / 9 passed，77 按名称未选；126.56s。
   - 9 条包含 B1、B3、B2 六种资源归属组合及已 landed Agent 离线相邻回归。
   - 原始记录：repairs-focused.log。
3. `/usr/bin/node node_modules/@biomejs/biome/bin/biome ci packages/daemon/src/boot/container.ts packages/daemon/src/service/dispatch.ts packages/daemon/src/service/document-execution.ts packages/daemon/src/service/wrapup.ts packages/daemon/src/workspace/worktree.ts packages/daemon/test/integration/document-execution-routes.test.ts packages/daemon/test/unit/worktree.test.ts packages/daemon/test/unit/landing.test.ts`
   - exit 0；Checked 8 files in 1227ms. No fixes applied.
   - 原始记录：biome-changed.log。
4. 独立运行 `git diff --check` 对上述运行时及测试差异检查，无错误。
5. 已直接读取主代理当前完整 `pnpm -w check --maxWorkers=2 --minWorkers=1` 记录 final-check-windows-rerun.log：完整错误码/样式/禁令/Biome/tsc/Vitest 串联到结尾，253 files / 3313 passed / 3 既有 skipped，444.34s。当前运行时代码修改时间均早于此完整检查，未把旧 red/中断日志当成现状。

边界：主代理完整 E2E 的批次 13/14 套件通过，另两个 45 秒冷启动套件失败待单独复查；没有把它们写成通过。它们及后续发布流程仍是整体批次收口的待办，本 verdict 仅覆盖本轮修复代码及必要支持路径。

本代理没有编辑生产文件、任务笔记、测试、依赖、分支或 .git，没有新建项目工作树/克隆、prune 或 GitHub 写操作；只在获准的 verifier 目录保存报告与独立验证日志。

VERDICT: PASS