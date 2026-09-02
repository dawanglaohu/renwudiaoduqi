import io

P = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/00-概览/01-概述与目标.md"
s = io.open(P, encoding="utf-8").read()

# 决策 48/49 已推翻决策 9 的前提：docs-data.js 的 payload 里没有批次、也没有窗口数，
# 交接台的「第 N 批」是浏览器现算的。能力表这两行还留着旧前提，
# 照它实现会去读一个根本不存在的字段。
pairs = [
    ("| 从 `docs-data.js` 读入任务、依赖、验收标准、边界编号、批次与并行窗口 |"
     " 原话「根据文档产出的 任务交接台中的任务」 | 4 |",
     "| 从 `docs-data.js` 读入任务、依赖、验收标准与边界编号"
     "（**批次不在 payload 里，本产品按 `deps` 自己拓扑分层，规则与交接台逐字一致，"
     "保证「第 3 批」两边指同一批任务**） |"
     " 原话「根据文档产出的 任务交接台中的任务」 | 4, 48 |"),
    ("| 按批次派活，按交接台已算好的并行窗口数限流，路径冲突的任务自动排队 |"
     " 补充需求「按批次派活」 | 9 |",
     "| 按批次派活，按**本产品自己的并行窗口设置**限流（默认 2，可调 1–6，"
     "**不移植阅读器的 `bestLanes()`**——它要读阅读器的进度 localStorage），"
     "路径冲突的任务自动排队 |"
     " 补充需求「按批次派活」 | 9, 48, 49 |"),
]
for a, b in pairs:
    if a not in s:
        raise SystemExit("ANCHOR MISSING:\n---\n%s\n---" % a)
    s = s.replace(a, b, 1)

io.open(P, "w", encoding="utf-8", newline="\n").write(s)
print("patched 01-概述与目标.md（能力表与决策 48/49 对齐）")
