import io
import json

P = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/_run/presentation.json"
d = json.load(io.open(P, encoding="utf-8"))
c = d["handoff"]["design"]

old = "primary 是唯一带 --glow 的且**全页只许出现一个**；"
new = ("**primary 的唯一性按容器算不按整屏算**——E-109 要求每条流各自内联审批卡，"
       "5 条流并置时同屏必然有 2–5 个「批准并继续」，"
       "准确规则是每个可见容器内至多一个 primary（左栏派发面板 1 个、每条泳道 1 个），"
       "而 **--glow 只允许出现在左栏那个派发按钮上**，审批卡里的 primary 用实底无 glow；")
if old not in c["components"]:
    raise SystemExit("ANCHOR MISSING: design.components glow rule")
c["components"] = c["components"].replace(old, new, 1)

# 主题解析：tokens 只给了深色一套，必须说清 system 不能直接写进 DOM
theme_note = (
    "**主题**：store 存 system|dark|light 三值，"
    "但 theme-provider 解析后只往 html 元素的 data-theme 属性写 dark 或 light 之一，"
    "system 靠 matchMedia('(prefers-color-scheme: dark)') 解析并订阅其变化；"
    "**把 system 原样写进 DOM 会让两个 [data-theme] 块都不匹配、只剩 :root 生效 → 永远深色**，"
    "与 E-15 直接冲突。color-scheme 随解析结果切换，不恒为 dark light。"
    "浅色是独立一套色值不是反色，取值见 11-UI 的 tokens。\n"
)
if "主题**：store 存" not in c["components"]:
    c["components"] = theme_note + c["components"]

json.dump(d, io.open(P, "w", encoding="utf-8", newline="\n"),
          ensure_ascii=False, indent=1)
print("presentation.json design 块已与 11-UI 对齐")
