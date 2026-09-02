# 竞品调研（对应原始需求第 3 点「可以先调研，有没有此类产品」）

> 来源：联网检索子代理，2026-08-31。产品 URL 均已给出；**关停/转型的时间点属检索所得，
> 未逐一二次核实**，引用时请按「调研结论」而非「既定事实」对待。

## 结论

**这类产品存在，但在 2026 年 2 月经历了一轮集中淘汰。**
活下来的两个最接近的产品各占一半，**没有任何一个产品同时具备三条轴**：
跨厂商 agent（含 Grok / DeepSeek）+ 从文档读出带依赖的任务清单 + 桌面端与手机端都有。

这个交集是真空的。

## 现存最接近的产品

| 产品 | URL | 支持哪些 agent | 手机端 | 任务从哪来 | 开/商 |
|---|---|---|---|---|---|
| **Conductor** | https://conductor.build/ | Claude Code、Codex、Cursor | ❌ Mac app + 云沙箱 | 手动建 workspace（每个一个 git worktree） | 商业（YC S24） |
| **Happy** ⭐ | https://github.com/slopus/happy · https://happy.engineering | **仅** Claude Code + Codex（`happy claude` / `happy codex`） | ✅ **iOS + Android + Web + macOS** | 无任务系统，纯会话遥控 | 开源 |
| **Vibe Kanban** ⚠️ | https://www.vibekanban.com/ | Claude Code、Codex、OpenCode 等 | ❌ | 手动 issue / sub-issue 看板 | 开源，官方已宣布 sunsetting |
| **claude-squad** | https://github.com/smtg-ai/claude-squad | Claude Code、Codex、Gemini CLI、Aider | ❌ 终端 TUI | 手动逐个开 session | 开源 |
| **Sculptor**（Imbue） | https://imbue.com/sculptor/ | 并行 coding agents 的 UI | ❌ 桌面 | 手动 | 商业 |
| **Crystal** ☠️ | https://github.com/stravu/crystal → https://nimbalyst.com/ | 已废弃，2026-02 转型为 Nimbalyst（AI 工作区/编辑器，不再是调度台） | — | — | — |
| **Terragon** ☠️ | https://www.terragonlabs.com/ | 调研称已于 2026-02-09 关停 | — | — | — |
| **Omnara** ⚠️ | https://omnara.com/ · https://github.com/omnara-ai/omnara | 已转型为「production agents 的 API 平台」（durable execution / approvals），model-agnostic | 仅 dashboard + Slack | 由你的应用调 API | 开源 |

**不建议对标**（属不同品类，是「单产品内多 agent」而非跨厂商调度台）：
Devin、OpenHands、Cursor、Warp、Zed。

## 手机端遥控本机 coding agent：存在，但很薄

- **唯一成熟的是 Happy**——App Store 与 Google Play 都有正式上架应用，端到端加密，
  CLI 只需把 `claude` 换成 `happy claude`。但**只支持两家**，且**没有任务/看板概念**，
  本质是「一个会话的远程终端」。
- 其余全是 GitHub 小项目，几乎都只管 Claude Code 一家：
  kojo（https://github.com/loppo-llc/kojo ，走 Tailscale，是少数提到 Grok 的）、
  ClauTunnel、termote（PWA）、claw、claude-remote-runner、DigitalMe（走飞书/TG/Slack）。
- **Omnara 曾是这条赛道最知名的产品，现已放弃该定位。** 这点很关键：
  说明「手机遥控」被主流玩家判断为不足以单独成产品，留下了真空。

## 从文档自动读出任务再派活：未找到成熟产品

- **商业产品里一个都没有。** Conductor / Vibe Kanban / Sculptor / claude-squad
  全部是人手工建卡片或手工开 workspace。Vibe Kanban 甚至把价值主张明确写成
  「加速人类的 planning 和 review」——即承认 planning 仍由人做。
- 只有实验性小仓库沾边，均无产品化 UI、无手机端：
  praetor（https://github.com/sid-valecha/praetor ，把大目标转成结构化任务图 + 依赖感知执行，
  最接近本项目的调度内核）、
  acp-bridge（https://github.com/allvegetable/acp-bridge ，走 **ACP 协议**管
  Codex/Claude/Gemini/OpenCode，有并行任务与依赖链）、
  mavericks-os、claude-agent-monitor、parallel-multi-agent-codegen。

## 五条空白

1. **任务来源全靠手工。** 没有任何产品能吃一份开发文档，自动产出带依赖关系的任务清单。
   这是最大空白，也是本项目的核心差异点。
2. **依赖关系被普遍忽略。** 现存产品是「并行开 N 个 worktree」，本质是**无序并发**而非**调度**；
   没有拓扑排序、没有「A 完成才能开 B」的门禁。只有几个百星以下的实验仓在做。
3. **厂商覆盖窄。** 事实标准是「Claude Code + Codex」两家；
   **Grok 只在一个小项目里出现，DeepSeek 全场零覆盖。**
4. **桌面与手机是割裂的两个世界。** 有任务板的全是纯桌面无手机；
   有手机的（Happy）全是纯会话无任务板。
   **「手机上看任务进度 + 回看某个 agent 的会话」这个组合不存在**——而这正是原始需求的第 1、2 点。
5. **赛道刚经历淘汰潮，窗口是打开的，但也是风险。**
   2026 年 2 月一个月内 Terragon 关停、Crystal 废弃、Vibe Kanban sunsetting、Omnara 转型，
   说明「纯并行 worktree 管理器」这个薄形态被证伪了，活下来的必须提供更上层的编排/规划价值——
   这恰好是本项目的方向。**但同一批事实也可能说明这个品类付费意愿低**，
   若本项目预期商业化需另行验证；若只是自用则不受影响（本项目已裁决为单人自用）。

## 对本项目的直接影响

- **定位得到印证**：差异点不在「能并行跑 agent」（那已被证伪为薄产品），
  而在「从文档吃任务 + 尊重依赖 + 跨厂商 + 两个端」。这三条恰好是空白。
- **ACP 值得关注**：acp-bridge 已用 ACP 统一管四家，与本机实测 grok 原生输出 ACP 相互印证，
  支持把 ACP 作为内部统一事件模型的设计取向。
- **Happy 是手机端形态的参照物**，其「CLI 前缀包装」（`happy claude`）是一种比子进程接管
  更轻的接入思路，可作为将来适配层的备选形态记入参考资料。
- **风险登记**：本品类 2026 年 2 月的集中淘汰应写进风险章节。
