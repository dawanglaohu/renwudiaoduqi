import io

D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            print("  SKIP (anchor missing): " + a[:70])
            continue
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)

# ─────────────────── 07 前端架构 ───────────────────
patch("02-设计/07-前端架构.md", [
    # 联合类型被我自己的修复脚本改坏了（\| 变成了 /）
    ("| `connection-store` | `status: 'online'/'reconnecting'/'offline'`、`lastSyncedAt`、`lastEventId`、`needsPairing`",
     "| `connection-store` | `status`（取值 `online` \\| `reconnecting` \\| `offline`）、`lastSyncedAt`、`lastEventId`、`needsPairing`"),
    ("| `ui-prefs-store` | `theme`、`density: 'full'/'dense'`、`expandedRunId`、`lastDocId` |",
     "| `ui-prefs-store` | `theme`（`system` \\| `dark` \\| `light`）、`densityTier`、`expandedRunId`、`lastDocId` |"),
    # 档位枚举统一命名（三处曾用了不同词汇）
    ("`hooks/`             纯 UI 行为：use-breakpoint / use-follow-tail / use-hotkey / use-copy",
     "`hooks/`             纯 UI 行为：use-density-tier / use-follow-tail / use-hotkey / use-copy"),
    # 持久化白名单改成显式键表
    ("**持久化白名单**：只有 `ui-prefs-store` 的 `theme` / `density` / `lastDocId` 三个字段进\n`localStorage`（key `agsched.ui.v1`，手写 30 行读写，**不用 persist 中间件**）；\n**令牌绝不进 localStorage**（走 shell，见下）；\n**事件、运行、日志、快照一律不持久化**（E-01 重开从 daemon 全量拉）。",
     "**持久化白名单是一张显式键表，表外的任何 `localStorage.setItem` 由 `check-forbidden.ts` 判失败：**\n\n| 键 | 存储 | 内容 | 何时写 |\n|---|---|---|---|\n| `agsched.ui.v1` | localStorage | `theme` / `densityTier` / `lastDocId` | 用户改设置时（手写 30 行读写，**不用 persist 中间件**） |\n| `agsched.host` | localStorage | 用户手填的 daemon 地址（E-06 的兜底） | 手填时 |\n| `agsched.token` | **sessionStorage** | 设备令牌，**仅在无壳的浏览器模式下**（决策 45） | 配对成功时；有壳时以壳的安全存储为唯一真相源并清掉会话副本（E-227） |\n\n**令牌绝不进 localStorage**；\n**事件、运行、日志、快照一律不持久化**（E-01 重开从 daemon 全量拉）。"),
])

# ─────────────────── 11 UI ───────────────────
patch("02-设计/11-UI.md", [
    # 主题：必须显式处理 system
    ("主题走 `html` 元素上的 `data-theme` 属性，默认 `system`，\n**禁止锁根字号、禁止 `text-size-adjust:none`、禁止 zoom**（E-15）；",
     "主题走 `html` 元素上的 `data-theme` 属性。store 里存三值 `system` \\| `dark` \\| `light`，\n但 **`theme-provider` 解析后只往 `<html>` 写 `dark` 或 `light` 两个值之一**，\n并监听 `matchMedia('(prefers-color-scheme: dark)')` 跟随系统切换——\n若把 `system` 直接写进 DOM，两个 `[data-theme]` 块都不匹配、只剩 `:root` 生效，\n结果是**永远深色**，与 E-15「跟随系统主题」直接冲突。`color-scheme` 随之切换而不是恒为 `dark light`。\n**禁止锁根字号、禁止 `text-size-adjust:none`、禁止 zoom**（E-15）；"),
    # 字形表降级为语义来源
    ("**矩形不是药丸**。**永远是「字形 + 文字」，颜色是第三层信息。**",
     "**矩形不是药丸**。**永远是「字形 + 文字」，颜色是第三层信息。**\n\n> ⚠️ **下表的 Unicode 字符是「语义来源与 `aria-label` 文案来源」，不是渲染实现。**\n> 实际渲染一律用 `lib/spine-shape.ts` 里的**内联 SVG path**（决策 46）——\n> Android WebView 的中文回退字体不保证有 `⬡` / `▤` / `⌁` 的字形，\n> 缺字形会显示成豆腐块，而那正是「不能只靠颜色」时的唯一替代信息（E-233）。\n> 另需为「失联」「审查未完成」「未识别／降级」各补一个**专属形状**，绝不复用 `✕`（E-230）。"),
    # primary 唯一性改成按容器
    ("`background:var(--needs); color:var(--on-needs); font:600 13px/1 var(--font-ui)`；`box-shadow:var(--glow)` **全屏只此一处** |",
     "`background:var(--needs); color:var(--on-needs); font:600 13px/1 var(--font-ui)` |"),
    ("状态：`hover` 底提亮 4% + 边框升 `--border-strong`，`transition:var(--dur-fast)`，**不放大不弹跳**；",
     "**primary 的唯一性按容器算，不按整屏算**——整屏只允许一个 primary 这条规则在本产品下自相矛盾：\nE-109 要求每条流各自内联一张审批卡，5 条流并置时同屏必然出现 2–5 个「批准并继续」。\n准确规则是：**每个可见容器内至多一个 primary**（左栏派发面板 1 个、每条泳道 1 个），\n而 **`--glow` 只允许出现在左栏那个派发按钮上**，审批卡里的 primary 用实底无 glow。\n\n状态：`hover` 底提亮 4% + 边框升 `--border-strong`，`transition:var(--dur-fast)`，**不放大不弹跳**；"),
])
print("done")
