import io

D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"


def patch(path, pairs):
    p = D + path
    s = io.open(p, encoding="utf-8").read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit("ANCHOR MISSING in %s:\n---\n%s\n---" % (path, a[:200]))
        s = s.replace(a, b, 1)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
    print("patched " + path)


# ─── 07 前端架构：档位钩子统一为 E-235 / M9-T9 的规范名 useDensityTier ───
patch("02-设计/07-前端架构.md", [
    ("hooks/             纯 UI 行为：use-breakpoint / use-follow-tail / use-hotkey / use-copy",
     "hooks/             纯 UI 行为：use-density-tier / use-follow-tail / use-hotkey / use-copy"),
])

# ─── 11 UI：主题解析（system 不能直接写进 DOM）+ glow 注释与容器规则对齐 ───
patch("02-设计/11-UI.md", [
    ("### tokens（可直接粘贴）",
     "### 主题解析（写 DOM 之前必须做的一步）\n\n"
     "store 里的 `theme` 存三个值 `system` \\| `dark` \\| `light`，\n"
     "但 **`theme-provider` 解析后只往 `<html data-theme>` 写 `dark` 或 `light` 两者之一**。\n"
     "`system` 的解析依据是 `matchMedia('(prefers-color-scheme: dark)')`，并**订阅它的变化**跟随系统切换。\n\n"
     "> ⚠️ 若把 `system` 原样写进 DOM，下面两个 `[data-theme]` 块都不匹配、只剩 `:root` 生效，\n"
     "> 结果是**永远深色**——与 E-15「跟随系统主题」直接冲突，而且在浅色系统下毫无征兆。\n\n"
     "`color-scheme` 同样随解析结果切换（`dark` 或 `light`），不恒为 `dark light`，\n"
     "否则原生滚动条与表单控件会与页面主题脱节。\n\n"
     "### tokens（可直接粘贴）"),
    ("  --glow: 0 6px 20px rgba(240,176,60,.28);   /* 全屏只许出现一次：主按钮 */",
     "  --glow: 0 6px 20px rgba(240,176,60,.28);   /* 只许用在左栏那个派发按钮上，见「按钮」一节 */"),
])

print("done")
