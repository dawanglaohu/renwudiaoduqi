import io, re

BS = chr(92)
D = "D:/xiangmu/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

# ---------- regenerate section 13 from the edge ledger ----------
src = io.open(D + "_run/edges.md", encoding="utf-8").read()

DEC2MOD = {
 1:'M1',2:'M2',3:'M9',4:'M3',5:'M6',6:'M4',7:'M4',8:'M4',9:'M8',10:'M8',
 11:'M7',12:'M5',13:'M3',14:'M3',15:'M4',16:'M6',17:'M9',18:'M6',19:'M6',
 20:'M2',21:'M1',22:'M4',23:'M1',24:'M9',25:'M10',26:'M1',27:'M2',28:'M9',
 29:'M9',30:'M9',31:'M9',32:'M9',33:'M9',34:'M4',35:'M4',36:'M4',37:'M9',38:'M4',
 39:'M6',40:'M10',41:'M1',42:'M2',43:'M6',44:'M9',45:'M9',46:'M9',47:'M9',
}
OVERRIDE = {
 'E-11':'M10','E-12':'M9','E-13':'M9','E-14':'M10','E-15':'M9',
 'E-24':'M1','E-25':'M2','E-42':'M1','E-53':'M9','E-57':'M2','E-58':'M9','E-59':'M7',
 'E-61':'M7','E-67':'M7','E-96':'M6','E-98':'M6','E-99':'M9','E-100':'M9','E-101':'M9',
 'E-102':'M9','E-103':'M1','E-104':'M1','E-119':'M1','E-129':'M1','E-130':'M1','E-131':'M1',
 'E-132':'M1','E-138':'M1','E-139':'M1','E-140':'M1','E-141':'M1','E-142':'M1',
 'E-146':'M10','E-147':'M10','E-148':'M10','E-149':'M1','E-150':'M1','E-151':'M1','E-152':'M1',
 'E-153':'M2','E-154':'M2','E-155':'M2','E-156':'M2','E-157':'M9','E-158':'M9',
 'E-174':'M9','E-175':'M9','E-176':'M9','E-200':'M9','E-203':'M4',
 'E-205':'M1','E-206':'M1','E-212':'M1','E-218':'M9','E-226':'M2',
}
rows = []
for line in src.splitlines():
    m = re.match(r"^\|\s*(E-\d{1,3})\s*\|(.+)\|\s*([\d,\s]+)\s*\|\s*$", line)
    if not m:
        continue
    eid, body, decs = m.group(1), m.group(2), m.group(3)
    body = body.replace(BS + "|", "/")           # no escaped pipes inside cells
    first = int(re.findall(r"\d+", decs)[0])
    rows.append("| %s |%s| %s |" % (eid, body, OVERRIDE.get(eid) or DEC2MOD.get(first, "M1")))

nums = [int(r.split("|")[1].strip().split("-")[1]) for r in rows]
assert nums == list(range(1, len(nums) + 1)), "edge numbering not consecutive"

hdr13 = """# 边界问题与异常处理

**这是全套文档里最有价值的一节。** 每一条都是「什么条件下 → 期望什么行为」，
期望行为必须可执行——写不出可执行行为的，说明那个决策还没想清楚。

编号 `E-01` 起连续，**贯穿本表、19 节的验收标准与阅读器的覆盖矩阵**。
19 节每个任务的验收标准必须引用它涉及的编号；
确实本周期不处理的，必须在 21 节写明编号与原因，否则机械校验会拦下。

第五列是**主责模块**——出了问题先找它。

| 编号 | 场景 | 触发条件 | 期望行为 | 模块 |
|---|---|---|---|---|
"""
io.open(D + "03-质量/13-边界问题与异常处理.md", "w", encoding="utf-8", newline="\n").write(
    hdr13 + "\n".join(rows) + "\n")

# ---------- regenerate section 22 from the decision ledger ----------
dec = io.open(D + "_run/decisions.md", encoding="utf-8").read().replace(BS + "|", "/")
hdr22 = """# 决策记录

用户一次性描述需求后全程未被追问，下面每一条都是**代理用户**代替他做的裁决。
两列值得先看：

- **评审列 = `flawed`** —— 问题本身被驳回，采纳的是代理用户的反提案。
  **这意味着我最初的理解是错的**，这些行最该复核。
- **置信列 = `low`** —— 交付后最值得回头看的那批。

本次运行 47 条：18 条 `sound`、15 条 `flawed`、14 条 `incomplete`；
**无 `low`**，`medium` 两条（决策 10 的闸门分界、决策 11 的审查者选择）。

表格与 `_run/decisions.md` 逐字同源；边界编号列指向 13 节。

"""
io.open(D + "05-附录/22-决策记录.md", "w", encoding="utf-8", newline="\n").write(hdr22 + dec)

print("regenerated 13 (%d edges) and 22" % len(rows))

# ---------- spot-check known backslash sites ----------
for path, needle in [
    ("01-约束/04-开发条件.md", "Program Files"),
    ("02-设计/09-数据模型.md", "APPDATA"),
    ("02-设计/10-接口约定.md", "worktreePath"),
    ("04-执行/18-部署与运维.md", "APPDATA"),
]:
    txt = io.open(D + path, encoding="utf-8").read()
    for ln in txt.splitlines():
        if needle in ln:
            print("[%s] %s" % (path, ln.strip()[:120]))
            break
