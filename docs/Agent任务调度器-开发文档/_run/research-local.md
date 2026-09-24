# 本机实测：agent 到底能不能被外部发派（第一手证据）

> 用户原话第 4 点：「难度： 需要确认 agents 桌面版，是否可以从外部发派任务给 agents ？」
> 这份是**在本机直接跑 `--help` 得到的一手结论**，不是网上搜来的。
> 实测环境：Windows 10，2026-08-31。

## 装机情况

五个目标里 **4 个已装在本机**，可直接验证：

| agent | 可执行文件 | 实测 |
|---|---|---|
| claude | `/d/Program Files/nodejs/node_global/claude` | ✅ 已验证 |
| codex | `/d/Program Files/nodejs/node_global/codex` | ✅ 已验证 |
| pi | `/d/Program Files/nodejs/node_global/pi` | ✅ 已验证 |
| grok | `/c/Users/example/.grok/bin/grok` | ✅ 已验证 |
| DeepSeek Harness | 未安装 | ⏳ 待联网调研确认 |

## 总结论：**能，而且比预想的好得多**

四个都同时具备下面五件事，这正好是做调度器需要的全部：

1. **非交互执行**（headless）
2. **结构化输出**（JSON / NDJSON 流）
3. **会话 ID + 恢复 / 分叉**
4. **会话记录落本地磁盘、可读**
5. **某种 socket / daemon，可被外部驱动**

用户担心的「桌面版是不是黑盒」——**不成立**。codex 和 claude 都自带
**remote control** 子命令，codex 甚至有 `pair` 生成配对码，
那本来就是给远程客户端（比如手机）用的。

---

## codex

```
codex exec [PROMPT]                    非交互执行；PROMPT 也可从 stdin 读
codex exec resume <id> / fork          恢复 / 分叉会话
codex queue --thread <UUID> --message  往正在跑的会话里塞消息
       └ 支持 --remote ws://host:port + --remote-auth-token-env（远程 websocket + bearer token）
codex app-server daemon start|stop|restart      本地 app-server 常驻进程
codex app-server daemon bootstrap               「为 SSH 驱动场景安装持久化管理」
codex app-server daemon enable-remote-control   打开远程控制
codex app-server proxy                          把 stdio 代理到运行中 daemon 的 control socket
codex app-server generate-json-schema           协议有 JSON Schema（可机读，说明是正式协议）
codex app-server generate-ts                    还能生成 TypeScript 绑定
codex remote-control start|stop|pair            pair = 生成短时效配对码
codex agents                                    浏览「共享本地 app-server daemon」上的所有会话
codex mcp-server                                把 codex 当 MCP server（stdio）跑
codex app                                       启动桌面 app
```

**关键点**：`codex agents` 的说明是「浏览**共享本地 app-server daemon** 上的
所有 agent 会话」——桌面 app 和 CLI 共用同一个 daemon。所以外部程序连上这个
daemon，就同时看得见桌面 app 里的会话。这直接回答了用户的问题 4。

会话存储：`~/.codex/sessions/{2025,2026}/…`，另有 `session_index.jsonl`、`history.jsonl`。

## claude

```
-p / --print                          非交互
--output-format text|json|stream-json  结构化输出
--input-format text|stream-json        实时流式输入（可持续喂消息）
--include-partial-messages             增量分片
--replay-user-messages                 回显用户消息用于确认
--session-id <uuid>                    指定会话 ID
-r/--resume, -c/--continue, --fork-session
--bg / --background                    起后台 agent 并立即返回
claude agents --json                   把活跃会话打成 JSON 数组输出，**不需要 TTY**
--remote-control [name]                起带远程控制的会话
--remote-control-session-name-prefix
--json-schema <schema>                 结构化输出约束
--permission-mode                      权限模式
```

**关键点**：`claude agents --json` 明说「for scripting; does not require a TTY」，
就是给外部程序轮询用的。`--input-format stream-json` 让调度器能**持续喂消息**，
不只是发一次就完。

会话存储：`~/.claude/projects/<路径编码>/<session-uuid>.jsonl`（JSONL，可直接读）。
另有 `~/.claude/daemon`、`daemon.lock`、`daemon.status.json`——claude 也有本地 daemon。

## pi

```
-p / --print                非交互
--mode text|json|rpc        **rpc 模式**
--session-id <id>           指定会话 ID，不存在就建
--session <path|id>, --fork, --session-dir, --continue, --resume, --no-session
--name <name>
```

**关键点**：`--mode rpc` 是个 RPC 通道。`--session-dir` 可以让调度器指定
会话落盘位置，便于隔离与回读。

## grok

```
-p / --single <PROMPT>      headless
--output-format plain|json|streaming-json|streaming-messages-json
    └ streaming-json = **NDJSON of the agent native ACP session updates**
    └ streaming-messages-json = Anthropic Messages API wire format
--leader-socket <PATH>      默认 ~/.grok/leader.sock ——**外部控制用的 socket**
--session-id, --fork-session, --resume, --continue
--worktree / --worktree-ref  **自带 git worktree 支持**
--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan
--json-schema, --include-partial-messages

grok agent      不带交互 UI 跑
grok leader     管理运行中的 leader 进程
grok sessions   列出 / 搜索 / 恢复会话
grok export     把会话导出成 Markdown
```

**关键点**：grok 原生说 **ACP（Agent Client Protocol）**。这是跨厂商协议，
意味着适配层可能不必每家写一套。而且它**自带 worktree**，
正好对上交接台的并行窗口模型。

---

## 对架构的直接影响

1. **不需要 UI 自动化 / 模拟点击**。四个都有正规程序化入口，
   靠截屏点按钮那种脆弱方案可以直接排除。
2. **适配层分三档**，不是五个各写一套：
   - 档 A「一等公民」：headless 子进程 + NDJSON 流（四个都支持）
   - 档 B「会话回读」：直接读本地会话文件（四个都落盘，格式不同）
   - 档 C「活会话接管」：daemon / socket（codex app-server、grok leader.sock、claude daemon）
3. **ACP 值得作为内部统一事件模型**——grok 原生就是它，
   其余的往这个模型上映射，比自创一套私有格式更可能长命。
4. **codex 的 `remote-control pair` 配对码模型**，可以直接照抄给
   本产品的「手机配对桌面」用，用户已经熟悉这个交互。
5. **`--session-id` 由调用方指定**（claude / pi / grok 都支持）——
   调度器可以用任务 ID 派生会话 ID，回读时不用猜。

## 仍需确认

- DeepSeek Harness 本机没装，形态未知 —— 等联网调研。
- codex 桌面 app 与 app-server daemon 的实际共享程度，help 文本这么写，
  但未实测桌面 app 开着时 `codex agents` 是否真能看见它的会话。
- 各 daemon/socket 协议的稳定性——codex 的 app-server 标着 `[experimental]`。

---

# 追加实测：agent 配置文件里的模型（对应用户追加需求）

用户追加需求说「可获取agents配置文件中的模型」。**实测四个全都成立**，
但**四家四种格式**，适配层要按 agent 写读取器：

| agent | 配置文件 | 模型字段 |
|---|---|---|
| codex | `~/.codex/config.toml`（TOML） | `model = "gpt-5.6-sol"`、`model_provider`、`model_reasoning_effort`、`[model_providers.custom]` |
| claude | `~/.claude/settings.json`（JSON） | `"model": "opus"`，另有 `env.ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` 覆盖 |
| grok | `~/.grok/config.toml`（TOML） | `[models]` 目录段 + `[model]` 当前段 + `[model."grok-4.6"]`，`model = "grok-4.6"` |
| pi | `~/.pi/agent/models.json` + `models-store.json` + `settings.json`（JSON） | 有**专门的模型目录文件** |

另外每家都有列模型的命令，可作为配置文件之外的第二来源：
`grok models`（List available models and exit）、`pi --models` / `pi update` 更新模型目录、
codex `-m/--model` 覆盖、claude `--model`。

**注意**：codex 的 `config.toml` 里有 `[desktop]` 段（含桌面 app 的主题字体配色），
说明**桌面 app 与 CLI 共用同一份 config.toml**——这进一步佐证「桌面版可被外部驱动」。

`~/.grok/active_sessions.json` 是活跃会话注册表，可直接读，
用来发现「现在有哪些 grok 会话在跑」。

## 对架构的影响

- 模型选择功能**可以做成真的**：读配置文件拿到候选清单 → 用户在调度器里选 →
  派发时用 `-m/--model`（codex）、`--model`（claude/grok）、`--model`（pi）覆盖。
  不需要用户手打模型名。
- 但**四种格式意味着四个读取器**，这属于 C-08「接入配置注册表化」的范畴，
  两件事应该合并设计，不要各做一套。
