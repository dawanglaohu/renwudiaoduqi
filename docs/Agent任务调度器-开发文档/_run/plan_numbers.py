"""把阅读器交接台的排程算法照搬到 Python，用来给交付话术取三个数：
   第一批能立刻并行开工多少个任务、推荐几个窗口、该窗口数下的工期。
   规则必须与 build_docs.py 的 layerOf / tailLen / planLanes / clashOf 逐字一致，
   否则交付时说的数字和用户打开阅读器看到的对不上。"""
import io
import json
import re

D = "D:/workspace/renwudiaoduqi/docs/Agent任务调度器-开发文档/"

src = io.open(D + "docs-data.js", encoding="utf-8").read()
m = re.search(r"window\.DOCS\s*=\s*(\{.*\});?\s*$", src, re.S)
D_ALL = json.loads(m.group(1))
DT = D_ALL.get("data", {})
tasks = DT["tasks"]
by = {t["id"]: t for t in tasks}
HO = D_ALL.get("pres", {}).get("handoff", {})
PATHS = HO.get("taskPaths", {})


def under(a, b):
    a, b = a.rstrip("/"), b.rstrip("/")
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def clash(a, b):
    for x in PATHS.get(a, []):
        for y in PATHS.get(b, []):
            if under(x, y):
                return True
    return False


def layer_of():
    lv = {}

    def walk(i, stack):
        if i in lv:
            return lv[i]
        if i in stack:
            return 0
        mx = 0
        for p in by[i].get("deps", []):
            if p in by:
                mx = max(mx, walk(p, stack + [i]) + 1)
        lv[i] = mx
        return mx
    for t in tasks:
        walk(t["id"], [])
    return lv


def tail_len():
    kids = {t["id"]: [] for t in tasks}
    for t in tasks:
        for p in t.get("deps", []):
            if p in kids:
                kids[p].append(t["id"])
    memo = {}

    def walk(i, stack):
        if i in memo:
            return memo[i]
        if i in stack:
            return 0
        mx = 0
        for c in kids[i]:
            mx = max(mx, walk(c, stack + [i]))
        memo[i] = mx + (by[i].get("est") or 0)
        return memo[i]
    for t in tasks:
        walk(t["id"], [])
    return memo


def plan(n):
    tail = tail_len()
    finish, rest, placed = {}, list(tasks), []
    free = [0.0] * n
    guard = 0
    while rest and guard < 4000:
        guard += 1
        ready = [t for t in rest
                 if all(d not in by or d in finish for d in t.get("deps", []))]
        if not ready:
            break
        ready.sort(key=lambda t: (-(tail.get(t["id"], 0)),
                                  -(t.get("est") or 0), t["id"]))
        t = ready[0]
        est = t.get("est") or 0.5
        dep0 = max([finish[d] for d in t.get("deps", []) if d in finish] or [0])
        best = None
        for lane in range(n):
            s = max(free[lane], dep0)
            for _ in range(40):
                moved = False
                for p in placed:
                    if clash(t["id"], p["id"]) and s < p["end"] and p["start"] < s + est:
                        s = p["end"]
                        moved = True
                if not moved:
                    break
            if best is None or s < best[1]:
                best = (lane, s)
        lane, s = best
        placed.append({"id": t["id"], "start": s, "end": s + est})
        free[lane] = s + est
        finish[t["id"]] = s + est
        rest = [x for x in rest if x["id"] != t["id"]]
    return round(max(free), 1)


def best_lanes():
    best, prev = 1, None
    for n in range(1, 5):
        s = plan(n)
        if prev is None:
            prev = s
            continue
        if s < prev * 0.88:
            prev = s
            best = n
        else:
            break
    return best


lv = layer_of()
layer0 = sorted(i for i, v in lv.items() if v == 0)
# 同层但抢同一批文件的任务不能真并行，交接台会把它们错开
par, taken = [], []
for i in layer0:
    if not any(clash(i, j) for j in taken):
        par.append(i)
        taken.append(i)

nb = best_lanes()
print("任务总数 %d，串行 %.1f 人天" % (len(tasks), sum(t.get("est") or 0 for t in tasks)))
print("第 0 层（无前置，可立刻开工）%d 个：%s" % (len(layer0), "、".join(layer0)))
print("其中路径互不相撞、可真正同时开跑：%d 个 —— %s" % (len(par), "、".join(par)))
print("推荐窗口数 bestLanes = %d" % nb)
for n in range(1, 5):
    print("  %d 个窗口 → 工期 %.1f 人天" % (n, plan(n)))
