import io, re

BS = chr(92)
BAD = "\ufffd"
D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

# (file, 行内用于定位的上下文片段, 用来替换那串 U+FFFD 的正确文字)
FIXES = [
    ("00-概览/02-非目标.md", "云端或外网", "账"),
    ("02-设计/06-系统架构与模块划分.md", "本产品唯一的任务真相源", "成"),
    ("02-设计/11-UI.md", "屏幕上最重要的东西是", "而"),
    ("02-设计/12-UX.md", "排队 E-46", "者"),
    ("03-质量/17-测试策略.md", "| 位置 | 是否", "做"),
    ("04-执行/20-里程碑与交付顺序.md", "官方 grok 与社区", "分"),
    ("04-执行/20-里程碑与交付顺序.md", "第四批", "看"),
    ("_run/edges.md", "并记违规日志", "行"),
]

for path, ctx, good in FIXES:
    p = D + path
    lines = io.open(p, encoding="utf-8").read().split("\n")
    hit = False
    for i, ln in enumerate(lines):
        if BAD in ln and ctx in ln:
            lines[i] = re.sub(BAD + "+", good, ln, count=1)
            hit = True
            break
    if not hit:
        print("  (skip, already clean or not found) %s :: %s" % (path, ctx))
        continue
    io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    print("fixed %-40s -> %s" % (path, good))

# 10 节里那个被损坏的正则（全仓唯一一处此类残留）
p = D + "02-设计/10-接口约定.md"
s = io.open(p, encoding="utf-8").read()
old = '"expected": "^grok /d+/./d+/./d+",'
new = '"expected": "^grok %sd+%s.%sd+%s.%sd+",' % (BS + BS, BS + BS, BS + BS, BS + BS, BS + BS)
if old in s:
    io.open(p, "w", encoding="utf-8", newline="\n").write(s.replace(old, new))
    print("fixed regex in 10-接口约定.md")
else:
    print("  (regex anchor not found)")
print("done")
