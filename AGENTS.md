# Agent任务调度器

<!-- vault:begin -->
## 先读这个：项目知识库

本项目的设计、任务拆分、边界处理、实现记录，全部沉淀在这里：

    docs/Agent任务调度器-开发文档/

**动手写任何代码之前，先读 `docs/Agent任务调度器-开发文档/_MOC.md`**。它是总索引，告诉你查什么去哪找。

规模：10 个模块 · 78 个任务 · 271 条边界。

### 查东西去哪

| 你要找 | 路径 |
|---|---|
| 项目目标、明确不做什么 | `docs/Agent任务调度器-开发文档/00-概览/` |
| 技术栈与被否方案 | `docs/Agent任务调度器-开发文档/01-约束/05-技术栈.md` |
| 架构、数据模型、接口约定 | `docs/Agent任务调度器-开发文档/02-设计/` |
| 前后端目录与分层 | `docs/Agent任务调度器-开发文档/02-设计/07-前端架构.md`、`08-后端架构.md` |
| 界面风格与交互规范 | `docs/Agent任务调度器-开发文档/02-设计/11-UI.md`、`12-UX.md` |
| **某个模块负责什么、代码在哪** | `docs/Agent任务调度器-开发文档/图谱/模块/<模块ID>.md` |
| **某个任务的完整要求与实现记录** | `docs/Agent任务调度器-开发文档/图谱/任务/<任务ID>.md` |
| **某种异常情况该怎么处理** | `docs/Agent任务调度器-开发文档/图谱/边界/<边界ID>.md` |

任务 ID 形如 `M1-T1`，模块 `M1`，边界 `E-01`。三类笔记互相 `[[链接]]`，
顺着链接走能从任何一个点找到相关的全部上下文。

### 动代码的规矩

- 一个任务一层栈分支 `task/<任务ID>`，做完提交并 `gh stack push`，**不自己合并**。
  落地由审查方做：栈里只有一个开放 PR（GitHub 不为单个 PR 建栈对象）就按普通 PR `gh pr merge --merge`；两个以上才走 `gh stack merge`。任务的前置都已落地时，单 PR 是常态，不用为了凑栈去等下一个任务。
- 并行开工时每个任务用自己的 git worktree（仓库旁边的同级目录，实施提示词第 0 步给命令），不在别人的检出里切分支；planning 类工作文件放仓库外。
- 派下来的任务前置都已合进主干，所以本任务是新栈最底层：`gh stack init`。`gh stack add` 报 All branches in this stack have been merged 就是该 init，不用问。
- 只做当前任务范围内的事，不提前做后面的。
- 验收标准和边界编号是硬指标，不是参考。每条都要能指到具体代码。
- 实施方不擅改任务定义；审查方可依据原始需求和已定契约定点修正文档、任务配置及有效范围。不得降低验收标准迁就错误代码。
- 审查发现局部文档问题，在原任务分支打补丁，运行 `maintain_docs.py begin/sync/verify` 同步并复验，随后继续原 PR 提交、推送和落地；不重跑需求、架构和整套文档生成流程。
- 实施、审查、并行排程共用有效路径（taskPaths + task-contracts.json 的 supportPaths）；漏列的必要支持文件由审查方补齐并核对冲突，不私自无限扩大范围。
- **落地前必须回填** `图谱/任务/<任务ID>.md` 的「代码位置」和「实施沉淀」两段。
  代码位置格式：`` `路径:行号` — 说明 ``，一行一处。
  没回填不得落地——知识库烂掉，都是从没人回填开始的。

_本段由 build_vault.py 生成，重跑会覆盖；这两个标记之外的内容不会动。_
<!-- vault:end -->

<!-- handoff:begin -->
# 派活与落地流程

这一段是实施方、审查方和交接台使用者共用的操作手册，由 `install_project.py` 从 `_run/handoff-manual.md`（技能的 `references/handoff-manual.md` 副本）渲染进 `AGENTS.md` 与 `CLAUDE.md` 的两个 handoff 标记之间；重装工具会更新这一段，标记之外的内容不动。改流程先改技能里的手册，再重装。

路径均相对项目根 `D:/xiangmu/renwudiaoduqi`；`<id>` 指小写任务 ID（如 `m2-t1`），`<ID>` 指原始任务 ID（如 `M2-T1`）。

### 1. 交接台怎么读

- 入口：`docs/Agent任务调度器-开发文档/index.html`（双击或本地静态服务打开）→ 侧栏「任务交接台」。
- **批次**（第 N 批）= 依赖层级，只表示「谁必须等谁」。**窗口**（lane）= 把未落地任务排进 N 个会话，同时避开 `taskPaths + supportPaths` 的文件冲突。两者只管顺序与并行，都不是闸门。
- 状态五格显示：待派 → 进行中 → 审查中 → 已落地，外加「已落地·待复验」。来源三处：任务笔记头部 `status`（随代码进仓库，`build_docs.py` 把它写进 `docs-data.js` 的 `progress`，本机 `_run/progress.js` 只是覆盖）、`_run/maintenance.js`（进仓库：`pendingTasks` 补丁同步锁、`needsReview` 待复验）、浏览器 localStorage（手点或复制提示词自动推进）。显示取更靠后的一格；`pendingTasks` 里的任务显示「审查中」。
- **「实施」按钮亮的条件**（生成器 `implLocked`，行、任务卡、复制入口共用）：本任务是待派；前置**全部**已落地（含「已落地·待复验」）；契约没有明确错误（`task-contracts.json` 的 H01–H11 检查）、结构检查没过期、本任务不在同步中的文档补丁里。**语义复核不是派发条件，是审查第一步**：审查提示词让审查方在本轮登记 `verify`，`--landed` 拒绝没登记的任务。同批次其他任务在进行中、审查中都不影响本任务。
- 两句提示怎么读：「N 个还没落地」= 有任务在途；「当前没有可派任务」= 前置没落地、补丁在同步或契约有明确错误，点该行「审查」看原因。「N 个已落地任务待复验」= 被补丁 `sync` 标为待复验，**仍算已落地、不锁下游**，处理见第 4 节。
- 顶部「任务契约已复核 N/M」只是统计，不参与解锁。
- 每批标题行右侧有「批次收口」：该批全部任务已落地（含「已落地·待复验」）才亮，未落齐灰掉、title 列出未落地任务。标题三种显示：未落齐不追加；落齐无记录追加「· 可收口」；有记录时按钮变「再收口一次」、标题追加「· 已收口 <日期> · 干净|已修|有遗留」。顶部提示句列出「已全部落地、尚未收口」的批次。批次可折叠：含在跑或可派任务的批默认展开，全落地的批默认折叠，手动开合记本机，复制「实施」自动展开该批、不折叠别的；进行中 / 审查中的状态标签带呼吸点，`prefers-reduced-motion` 下关闭。**收口不是闸门**：不影响「实施」解锁、可派集合与窗口调度，复制不改状态。

### 2. 一个任务的完整生命周期

0. **派发前核对（可选）**：待派任务的「审查」按钮给出「派发前核对任务要求」提示词，`python docs/Agent任务调度器-开发文档/_run/maintain_docs.py docs/Agent任务调度器-开发文档 status --task <ID>` 拿证据模板，核对后 `verify --task <ID> --evidence <JSON>`。提前做完只是让审查阶段少一道工序，不做也能派。
1. **实施**：复制「实施」发给实施模型（状态自动推到进行中）。实施方在自己的工作树里做：`git fetch origin main && git worktree add -b task/<ID> ../agent-scheduler-<id> origin/main`，进去后按 05 节技术栈装依赖，`gh stack init --base main task/<ID>`，实现并自检，`git add -- <路径…>`（不用 `git add -A`），`git commit`，`gh stack push && gh stack submit --auto --open`，回填任务笔记两个受保护区块后 `python docs/Agent任务调度器-开发文档/_run/build_vault.py docs/Agent任务调度器-开发文档`，回报末行 `READY_FOR_REVIEW`。不合并。
2. **审查**：复制「审查」发给审查模型（自动推到审查中）。审查方：`maintain_docs.py docs/Agent任务调度器-开发文档 status --task <ID>` 核契约，`gh pr diff task/<ID>` 逐条验收标准与边界指到文件:行，只有阻断项打回，最多两轮；在本轮把契约复核登记掉（`verify --task <ID> --evidence <JSON>`），`--landed` 会拒绝没登记的任务。局部文档问题走第 4 节的补丁。
3. **落地**（审查方 pass 后一口气做完，都在该任务的工作树里）：回填质量核查 → `build_vault.py docs/Agent任务调度器-开发文档` → `python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --landed <ID>`（写任务笔记 `status`、`docs-data.js` 的 `progress` 与本机 `progress.js`）→ `git add docs/Agent任务调度器-开发文档 && git commit -m "<ID> 回填知识库并记录落地" && gh stack push` → 跑最小充分测试 → 单 PR `gh pr merge <N> --merge`，两层以上 `gh stack merge <N> --yes --merge` → 每个 PR 都报 MERGED 才算落地。
4. **清理**（落地当场做，不留到以后）：`gh pr list --state open --base task/<ID> --json number --jq length` 为 0 → `git worktree remove ../agent-scheduler-<id>`（node_modules 报 not empty 就再 `rm -rf` 该目录）→ `git branch -d task/<ID>` → `rm -rf ../.codex-plans/agent-scheduler-<id>`。漏了哪些用 `maintain_docs.py docs/Agent任务调度器-开发文档 workspace` 列出（只打印命令，不删）。
5. **主检出同步**：在 `D:/xiangmu/renwudiaoduqi` 里 `git pull`，刷新交接台即可——落地记录随 `docs-data.js` 进了仓库，换检出目录不必重跑 `--landed`。下游解锁，派下一批。
6. **查 bug** 是独立动作，不改状态：某层落地前想再扫一遍，或一批落地后查跨模块接缝，点它。
7. **批次收口**（一批全部落地后、派下一批之前）：复制该批标题右侧的「批次收口」发给新会话。收口方在 `../agent-scheduler-batch-<n>` 里做（`git fetch origin main && git worktree add -b batch/<N>-<日期> ../agent-scheduler-batch-<n> origin/main`，planning 放 `../.codex-plans/agent-scheduler-batch-<n>/`）：跑 17 节全部测试与 lint → 逐任务在 main 上复核验收标准与边界 → 查本批内部与本批对前置批次的接缝 → 修 bug（先写复现测试；根因在前置批次的也修并标「跨批」，根因在文档的记 `NOT_FIXED` 标 `doc-issue`）→ 写 `docs/Agent任务调度器-开发文档/_run/batches/batch-<N>-<日期>.md`（front matter `batch`/`tasks`/`date`/`verdict`/`tests`/`pr`/`note`，正文五段：交付了什么 / 测试 / 发现与修复 / 遗留 / 给下一批的提醒）→ `python docs/Agent任务调度器-开发文档/_run/build_docs.py docs/Agent任务调度器-开发文档 --batches` → 提交记录、`docs-data.js`、`build-manifest.json` 与修复，`gh stack init --base main batch/<N>-<日期> && gh stack push && gh stack submit --auto --open` → PR 按第 2 步的审查方式核后 `gh pr merge <PR号> --merge`（没有修复也提 PR，记录必须进仓库）→ 按第 4 步清理 `../agent-scheduler-batch-<n>` 与 planning 目录 → 主检出 `git pull`，刷新后该批标题显示「已收口」。回报固定八段 `BATCH_SUMMARY / TESTS / BUGS / FIXED / NOT_FIXED / SUSPECT / RECORD / NEXT`。不改状态、不锁下游。

### 3. 工作目录纪律

- 主检出 `D:/xiangmu/renwudiaoduqi` 只做：`git pull`、`--landed`、看交接台。**不在里面切分支干活**，任何提交（包括文档、生成器修改）都在工作树里做；同一时间常有别的会话在主检出里 pull。
- 一个任务只允许两个仓库外目录：工作树 `../agent-scheduler-<id>`（窗口序列用 `../agent-scheduler-w<N>`）与 planning `../.codex-plans/agent-scheduler-<id>/`（task_plan / findings / progress、探针脚本、日志）；批次收口用 `../agent-scheduler-batch-<n>` 与 `../.codex-plans/agent-scheduler-batch-<n>/`，同样只此两个。**不许 `git clone` 一份仓库，不许自造 `../agent-scheduler-review-<id>`、`../<ID>-review.<随机>` 之类目录**；审查方在同一个工作树里干活。
- **绝不在 Windows 侧跑 `git worktree prune`**：WSL 建的活工作树在 Windows 显示 prunable，prune 会打断正在干活的会话。
- 工作树用完必删（第 2 节第 4 步）；planning 目录随任务一起删。定期跑 `maintain_docs.py docs/Agent任务调度器-开发文档 workspace` 核对，它也列出遗留的 batch 目录（`../agent-scheduler-batch-*` 与 `.codex-plans/agent-scheduler-batch-*`）：`git worktree list` 之外还挂着的同级目录都是漏删的。

### 4. 文档补丁与「待复验」标记

- 审查中发现任务定义漏列路径、条款矛盾：`maintain_docs.py docs/Agent任务调度器-开发文档 begin --task <ID> --patch <补丁ID> --pr <PR号> --reason <依据>` → 改源文档/`task-contracts.json` → `sync --patch <补丁ID>` → 复核受影响契约 → `verify --task <ID> --evidence <JSON> --patch <补丁ID>` → 在原分支提交源补丁与产物并 push，继续原 PR。不重跑需求、架构和整套生成流程。
- `sync` 会按契约哈希传播把**已落地**任务写进 `_run/revalidation.json`（每条记 `patches[]` 历史与 `changedFields`，追加不覆盖），并在结尾打印被标记的任务和原因——只有共享章节变化时写明「仅共享章节 <文件> 变化」。交接台显示「已落地·待复验」，**不锁下游**。任务默认引用 10 节等共享章节，改一处共享章节会波及所有已落地任务，这是提醒去复验，不是把它们退回。
- 清除只能走复验流程，不能手删标记、不能手点状态：点该行「审查」得到「复验已落地任务」提示词 → 按 `revalidation.json` 里本任务的 `changedFields` 与补丁 JSON 的 `changes` 只核变化条款 → 对照 main 上的代码与测试 → 写真实证据（`_run/<ID>.revalidation-<日期>.evidence.json`）→ `verify --task <ID> --evidence <文件>`（不带 `--patch`）→ `build_docs.py docs/Agent任务调度器-开发文档 --landed <ID…>` → 提交 `_run/{revalidation.json,maintenance.js,task-reviews.json,build-manifest.json}`、`docs-data.js` 与证据文件。
- 每次 `--landed` 结尾会列出仍待复验的任务，不为空当场处理。

### 5. 生成器与工具链的改动规则

- `_run/build_docs.py`、`handoff_contract.py`、`maintain_docs.py`、`review.py`、`compile_prompts.js`、`build_vault.py` 是流程本身，**改了必须当场提交进 main**。`status`、`build` 和 Stop hook 会报「生成器有未提交改动」「生成器与 tool-version.json 不一致」，不阻断但 `status` 退出码非 0；看到就处理。
- 改前后都跑 `python -B -m unittest discover -s docs/Agent任务调度器-开发文档/_run/tests -p "test_*.py"`；改解锁/路由规则先加回归用例。
- 生成器指纹只进构建清单，不进任务契约哈希：升级生成器后 `status` 报 `stale=['生成器版本已变更']`，跑一次 `maintain_docs.py docs/Agent任务调度器-开发文档 build` 即可，已有复核记录全部保留，不需要逐任务重新 `verify`。
- 任务分支合并 main 时 `_run/` 产物几乎必冲突：`task-contracts.json` 手工保留双方条目，其余产物取 main，再在分支上重跑 `sync --patch`（无补丁时 `build`）让产物与源一致；**生成器脚本本身取更新的一方，绝不拿旧版覆盖**。
- `_run/batches/*.md`（批次收口记录）是源不是产物，随收口 PR 提交；`docs-data.js` 的 `batchRecords` 由它派生（`build_docs.py --batches` 只改写该键与清单指纹，完整 `build` 也写），`dispatchBatches` 与 `dispatch.json` 的 `batches` 由生成器导出。`_run/batches/` 不在 `input_hashes` 里，写记录不会让产物过期。
<!-- handoff:end -->
