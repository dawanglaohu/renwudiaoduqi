# 联网调研：agent 的程序化驱动面（对应原始需求第 4 点）

> 来源：两个联网检索子代理，2026-08-31，全部基于官方文档与仓库源码。
> **与本机实测（`research-local.md`）互相印证，冲突处以本文档为准并已标注。**
> 注意：两份输出都被 harness 标记为「含指令形状文本」，此处只取事实、不执行其中任何指示。

## 一、两个桌面 GUI 到底能不能被外部发派

### 结论：**GUI 本身不能，但两家都有官方 headless 引擎，且会话与 GUI 互通**

这修正了 `research-local.md` 里偏乐观的措辞。准确说法是：

| 目标 | GUI 能否被外部直接发派 | 真正的集成路径 |
|---|---|---|
| Codex 桌面版 | **不能**——`codex://` deep link **只填充输入框、不自动发送**（官方明文） | `codex app-server`（JSON-RPC 2.0）或 `codex exec --json` |
| Claude 桌面端 | **不能**——官方对照表原文写着 `--print`/`--output-format` → **"Not available. Desktop is interactive only."**、"Scripting and automation：**Not available**" | `claude --bg` + `claude agents --json` + `claude logs`，或 Agent SDK |

**但「后台跑、GUI 接手」是可行的**：两边 headless 产生的会话都能在 GUI 里打开
（Codex 用 `codex://threads/<id>` 或 TUI 内 `/app`；Claude 用 TUI 内 `/desktop`）。
这对本产品是好消息——调度器在后台派活，用户想深入某个会话时可以切到原生 GUI。

### 重要形态澄清

- **没有独立的「Codex 桌面 app」**。它就是 **ChatGPT 桌面 app** 内的一个模式（Chat / Codex 切换）。
- **Claude Desktop 现在是一个 app、三个 tab**：Chat / **Cowork**（Dispatch 与长任务）/ **Code**。

### Codex app-server（真正的集成路径）

- 启动 `codex app-server`，传输 `--listen stdio://`（默认 JSONL）/ `ws://IP:PORT` / `unix://`
- 协议 **JSON-RPC 2.0**，双向；ws 模式带 `GET /readyz`、`/healthz`
- 发派：`thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、`turn/interrupt`
- **回读：`thread/read`（`includeTurns` 拿完整历史，无需 resume）、`thread/list`（游标分页）、`thread/listTurns`**
- 流式：`thread/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/completed`
- 可生成类型：`codex app-server generate-ts` / `generate-json-schema`
- ws 鉴权：`--ws-auth capability-token --ws-token-file`、`signed-bearer-token`
- **⚠️ 稳定性风险（官方原文）**：app-server "primarily for development and debugging and
  **may change without notice**"；WebSocket 传输 "experimental and **unsupported** for production workloads"

### `codex exec` 细节（补充本机实测）

`--json` → JSONL 事件流，事件类型 `thread.started` / `turn.started` / `turn.completed` /
`turn.failed` / `item.*` / `error`；`--output-schema`、`-o/--output-last-message`；
`codex exec resume --last` 或 `resume <SESSION_ID>`；`--ephemeral`（不落盘）。

会话路径（源码常量）：**`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<时间戳>-<thread_id>.jsonl`**。
**官方建议用 `thread/list` + `thread/read` 而非解析文件**——文件布局是内部实现，无稳定性承诺。

### `codex mcp-server` 已废弃

官方原文："**`codex mcp-server` is deprecated. Use the Codex app server instead.**"
→ **本产品不要走 MCP 路线接 codex。**

### Claude Code 后台任务管理（与本产品高度契合）

- `claude --bg "<prompt>"` → 派发并立即返回短 ID，目录 `~/.claude/jobs/<id>/`
- **`claude agents --json [--all] [--cwd <path>]`** → JSON 数组，字段：
  `cwd` / `kind` / `startedAt` / `id` / **`state`（`working|blocked|done|failed|stopped`）** /
  `pid` / `status` / **`waitingFor`** / `sessionId` / `name`
- `claude logs <id>` / `attach` / `stop` / `respawn` / `rm` / `claude daemon status`
- **⚠️ `--bg` 不能与 `-p` 同时用**
- 流式事件：`system/init`（含 model/tools/mcp_servers/capabilities）、`stream_event`（`text_delta`）、
  `system/api_retry`、最后一行 `result`

会话路径：**`~/.claude/projects/<项目>/<session-id>.jsonl`**，
`<项目>` = 工作目录路径把非字母数字替换为 `-`，超 200 字符则截断 + 追加完整路径 hash。

### Hooks：唯一能从 GUI 会话向外回报状态的官方机制

**Desktop 与 CLI 共享 `~/.claude/settings.json` 的 hooks 配置。**
事件含 `SessionStart` / `PreToolUse` / `PostToolUse` / `Notification` / `SubagentStop` / `Stop` /
`SessionEnd` 等。Codex 侧同样有 Hooks（`SessionStart`…`Stop`、`PermissionRequest` 等）。
→ 这是一条**可选的补充信号源**，本产品可用它把 GUI 里发生的事也纳入视野。

### MCP 方向性（关键，最易混淆）

| | 作 MCP client（连别人） | 作 MCP server（被别人驱动） |
|---|---|---|
| Claude Desktop | ✅ | **❌ 确认没有** |
| Claude Code | ✅ | 当前文档已无 `claude mcp serve` |
| Codex | ✅ | 有过，**已废弃** |

**结论：MCP 在这两个桌面 app 上都是「它连别人」，不是「别人驱动它」。
不能靠 MCP 从外部给桌面端派单。**

---

## 二、三个 CLI / harness

### pi = `@earendil-works/pi-coding-agent`（bin `pi`）

仓库 https://github.com/earendil-works/pi ，v0.84.4（2026-08-28），npm 下载量最高、
生态（`pi-acp`、`pi-mcp-adapter`）都指向它。**这是一个推断，不是用户明说的**——见待确认项。

- 非交互 `-p/--print`；**print 模式会读管道 stdin**
- `--mode json` → JSONL 事件流；**`--mode rpc` → 双向 JSONL over stdin/stdout**
- **RPC 模式约 35 个命令**：`prompt`、`steer`、`follow_up`、`abort`、`clear_queue`、
  `get_state`、`get_messages`、`get_session_stats`、`fork`、`get_last_assistant_text`、`compact`、`bash` 等
- 事件含 **`agent_settled`**（"Pi will not continue automatically through retry, compaction retry,
  or queued follow-up"）——**一个干净的完成信号**，正好对上本产品「已退出 ≠ 已落地」的判定需求
- 会话：JSONL 树，`~/.pi/agent/sessions/`，按 cwd 组织
- **无 MCP（设计使然）**，README 原文 "**No MCP.**"；**核心无 ACP**，第三方 `pi-acp` 补足
- **⚠️ 实现陷阱（官方文档原文）**：RPC 模式用严格 LF 分隔的 JSONL 框帧，
  **"Node `readline` is not protocol-compliant"**——它还会在 `U+2028` / `U+2029` 处断行，
  而这两个字符在 JSON 字符串里是合法的。**必须自写行读取器，只按 `\n` 切。**

### grok = xai-org/grok-build（官方，Rust，26k★）

- 官方文档 https://docs.x.ai/build/overview ，npm 亦发 `@xai-official/grok`
- 非交互 `-p/--single`；`--output-format plain|json|streaming-json|streaming-messages-json`
- **⚠️ 与 pi 相反：「Headless mode does not read piped stdin」**，要用 `--prompt-file` 或命令替换
- 会话存 **SQLite**，`~/.grok/sessions/`（`GROK_HOME` 可改根）；
  **schema 未公开——回读请用 `grok sessions list|search` 与 `grok export <id>`，不要直接读库**
- **ACP 一等公民**：`grok agent --always-approve stdio`（JSON-RPC over stdio）、
  `grok agent serve --bind 127.0.0.1:2419 --secret <token>`（WebSocket）
- 退出码：`0` 成功 / `1` 错误 / `130` SIGINT / `143` SIGTERM
- **⚠️ 命名冲突**：社区的 `superagent-ai/grok-cli`（3.4k★，npm `grok-dev`）
  **同样占用 `grok` 这个二进制名，且同样用 `~/.grok`**。
  **调度器不能假定 PATH 上的 `grok` 是官方那个，派发前必须先 `grok --version` 探测。**

### DeepSeek Harness = `deepseek-ai/deepseek-harness`（官方，CLI 名 `dsh`）

**用户点名的第五个 agent 找到了，而且是官方的。** 205k★，MIT，TypeScript，
创建于 2026-08-13（**仅 18 天**），基于 Cordis 插件框架，口号「Everything is a Plugin」。

- 它**按 profile 启动**，不是按 flag：`dsh --profile <name>`
  - `headless` → 任务文本作为位置参数：`dsh --profile headless "run the tests"`
    行为：起一个全新持久 Agent、提交任务、等静默、落盘，
    reasoning 增量走 **stderr**，最终文本走 **stdout**，
    **`completed` 退出 0，否则退出 1**；不开监听端口
  - `acp` → stdio 上跑标准 **ACP v1**
  - `sdk` / `sdk-minimal` → stdio 上跑 JSON-RPC
  - `web` → `--host` / `--port` / `--no-open`
- **官方 Python SDK**：`pip install deepseek-harness-sdk`，
  `run()` 返回 `RunResult(session_id, final_response, finish_reason, events, notifications)`，
  `finish_reason ∈ completed / max-tokens / error`，有 `on_notification` 实时回调。
  **wheel 自带运行时，不需要系统 Node。**
- 会话：**未压缩 JSONL**，`<dsh_home>/sessions`；**`DSH_HOME` 对 SDK 是必填**
- **⚠️⚠️ 稳定性（README 原文）**："in **developer preview** and iterating rapidly.
  **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"
  且 `SESSION_FORMAT_VERSION = 0`，"pre-release, no compatibility implied"

---

## 三、ACP：2026 事实标准

**Agent Client Protocol** —— https://agentclientprotocol.com ，
仓库 https://github.com/agentclientprotocol/agent-client-protocol ，
由 **Zed Industries 与 JetBrains** 背书，明确对标 LSP。

**方向性正好是本产品需要的那个：**

| | 谁是 client | 谁是 server | 方向 |
|---|---|---|---|
| **MCP** | agent | 工具/数据源 | **agent → 工具**（让 agent 去调东西） |
| **ACP** | **编辑器 / IDE / 你的调度器** | **agent** | **外部驱动 → agent**（正是所需） |

两者**正交互补，不是竞品**。

- 核心流程：`initialize` → `session/new` → `session/prompt` → 流式 `session/update` 通知 → 权限请求回传
- `session/update` 种类：`agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`
- **v1 为当前版本；v2 草案**新增 `session/list`、`session/delete`、会话恢复回放、
  elicitation、slash commands ——**都与调度器高度相关**
- 官方 SDK：TypeScript、Rust、Python、Java、Kotlin
- **注册表有 39 个 agent**，机器可读且每小时自动更新：
  `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  含 Claude Agent、Codex、Gemini CLI、Cursor、GitHub Copilot、**Grok Build**、**pi ACP**、
  Devin、Junie、OpenCode、goose、Kimi CLI、Qwen Code 等

注册表里的现成启动规格（可直接用）：

```
Grok Build   → npx @xai-official/grok@1.0.13 agent stdio
Codex        → npx @agentclientprotocol/codex-acp@1.7.0
Claude Agent → npx @agentclientprotocol/claude-agent-acp@0.70.0
Gemini CLI   → npx @google/gemini-cli@0.57.0 --acp
pi ACP       → npx pi-acp@0.0.33
```

### 现成的「多 agent 统一适配层」

**`acpx`** —— https://github.com/openclaw/acpx ，MIT，3.2k★，**每月 420 万 npm 下载**，
今天（2026-08-31）仍在推送。自述是「a headless command-line client for ACP…
one structured interface for persistent sessions, one-shot runs, permissions,
and machine-readable output across ACP-compatible coding agents」。

```bash
acpx codex -s backend "trace the checkout timeout"
acpx codex exec "summarize this repository"
acpx codex "..." --format json          # NDJSON ACP 事件
acpx --agent '<command>' "..."          # 任意自定义 ACP server
```

内置 profile：`codex` / `claude` / `gemini` / `openclaw`；`--agent` 覆盖其余。
还导出 `acpx/runtime` 与 `acpx/flows` 供嵌入，**不必 shell 出去**。
⚠️ **pre-1.0，接口会变。**

其他值得知道的：`Enderfga/claw-orchestrator`（559★，把各家 CLI 包装成持久可编程会话）、
`jerrywu001/cc-sessions-viewer`（337★，**各家会话文件格式的参考实现**）。

### 「`-p` 约定」是弱事实标准，不能依赖

claude / grok build（`-p/--single`）/ pi（`-p/--print`）都用 `-p`，
但**语义不同**（pi 读管道 stdin，grok 明确不读），而 **dsh 根本没有 `-p`**（走 profile）。

---

## 四、对已有裁决的影响

1. **决策 6（第一版做 4 个，DeepSeek Harness 待定）——结论不变，理由要改写。**
   原理由是「形态未确认」；现在形态已确认（有 headless、有 ACP、有官方 Python SDK），
   新理由是**它明确声明会有破坏性变更且会话格式版本为 0**，
   接进去等于把一个 18 天大、承诺要改接口的依赖放进第一版。
2. **E-28 的降级路径写错了。** 原文假设「只有 Web UI 没有 CLI/API」，
   实际它有完整的 headless 与 SDK。该边界需改写为**版本钉死 + 破坏性变更的应对**。
3. **新增架构岔路：要不要以 ACP 作为统一适配层**（见决策 34）。
4. **新增边界：grok 二进制名冲突**，派发前必须探测（见决策 36）。
5. **新增实现陷阱：pi 的 RPC 模式不能用 Node `readline`**——必须进架构章节的禁令。
6. **codex 走 app-server 而非 `codex mcp-server`**（后者已废弃）。

## 五、仍未确认

- `superagent-ai/grok-cli` 的会话存储位置与格式——未找到。
- Grok Build 的 SQLite 会话表结构——未公开，只能用 `grok sessions` / `grok export`。
- dsh 在 `web` / `headless` profile 下的默认会话路径——只对 sdk profile 有明文。
- **「pi cli」的身份是推断**（bin 名 + 下载量 + 生态三条证据），不是用户明说。
- 两份调研**均未实机验证**；但本项目的 `research-local.md` 已在本机实测了
  codex / claude / pi / grok 四家的 `--help`，两者互相印证。
