#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""项目知识库构建器（Obsidian vault）

用法:
    python build_vault.py <文档目录>
    python build_vault.py <文档目录> --check          # 只校验，一个字不写
    python build_vault.py <文档目录> --root <项目根>   # 手动指定 AGENTS.md 的落点
    python build_vault.py <文档目录> --mode brownfield # 强制存量模式（默认自动判）

两种模式:
    新建 greenfield   先有文档、再有代码。19 节任务表是主干，笔记面向「即将开工」：
                      验收标准、栈分支、落地前回填。unattended-run 走的是这条。

    存量 brownfield   代码已经在跑，文档是补的。19 节任务表可以为空，主干换成
                      模块笔记 + 边界笔记，「代码位置」是最要紧的一段；项目根的
                      引导文件也换成「改之前先读、改之后就更新」的规矩。

    不传 --mode 时按 19 节判：抽到任务走新建，抽不到走存量。存量项目后续要开工，
    往 19 节加任务行即可，自动切回新建那套派活流程。

做什么:
    把 24 节文档里的表格反编译成一层原子笔记，让文档变成能用 Obsidian 打开的知识库。

    图谱/模块/M1.md      职责、依赖、下辖任务、代码位置
    图谱/任务/M1-T1.md   任务卡、验收标准、边界、代码位置、实施沉淀
    图谱/边界/E-01.md    触发与期望、被哪些任务兜底、验证记录
    _MOC.md              总索引，人和模型的统一入口
    .obsidian/app.json   把 _run/ 排除出图谱（已存在则不动）

    <项目根>/AGENTS.md   告诉 codex 之类的 CLI「这个项目的知识在哪」
    <项目根>/CLAUDE.md   同上

三类笔记全部由本脚本从表格派生，互相 [[wikilink]]。Obsidian 的 Graph View
会直接显示「模块 ← 任务 → 边界」的网络，不用手画。

★ 受保护区块 ★
    笔记里 <!-- code:begin --> … <!-- code:end --> 和
           <!-- notes:begin --> … <!-- notes:end -->
    之间的内容是人和模型回填的，重跑时原样保留，只重写区块之外的部分。
    没有这个机制，跑一次冲一次，就没人愿意回填了——知识库都是这么烂掉的。

    AGENTS.md / CLAUDE.md 同理：只替换 <!-- vault:begin --> … <!-- vault:end -->
    这一段，已有内容不动。

数据来源（靠表格解析，所以文档必须按约定用表格）:
    06 架构      | M1 | 职责 | 依赖 |
    13 边界      | E-01 | 场景 | 触发条件 | 期望行为 | 模块 |
    19 任务拆分  | M1-T1 | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |
                 （存量模式下这张表可以为空）

    _run/code_map.json   可选，由同目录的 scan_repo.py 生成：
                 {"M1": ["- `src/order/` — 模块根目录", …]}
                 模块笔记的「代码位置」还没人回填时，拿它当初始内容。
                 一旦回填过，以回填的为准，这里的内容不再顶上去。

退出码:
    0  正常
    1  --check 发现问题
    2  用法/读取错误
"""

import json
import os
import re
import sys

FENCE = chr(96) * 3
GROUP_ORDER = ["00-概览", "01-约束", "02-设计", "03-质量", "04-执行", "05-附录"]

DIR_MOD, DIR_TASK, DIR_EDGE = "图谱/模块", "图谱/任务", "图谱/边界"

# 受保护区块：重跑时区块内的内容原样搬过来
BLOCK_RE = re.compile(r"<!--\s*([a-z]+):begin\s*-->\n?(.*?)<!--\s*\1:end\s*-->", re.S)

PH_CODE = "_（实施后回填。一行一处，格式：`路径:行号` — 说明）_"
PH_CODE_TASK = "_（**落地前必须回填**。一行一处，格式：`路径:行号` — 说明）_"
PH_CODE_MOD_BF = "_（**存量项目必填**：这个模块的代码在哪。一行一处，格式：`路径:行号` — 说明）_"
PH_NOTES_MOD = "_（本模块的设计取舍、踩过的坑。没有就留空。）_"
PH_NOTES_MOD_BF = "_（这个模块为什么长成现在这样、哪里不能碰、踩过什么坑。存量项目里这段最值钱。）_"
PH_NOTES_TASK = "_（**落地前必须回填**：怎么实现的、为什么这么选、踩了什么坑）_"
PH_NOTES_EDGE = "_（这条边界实测怎么验的、验过没有）_"


# ---------- 基础工具 ----------

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, text):
    d = os.path.dirname(p)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    if os.path.exists(p) and read(p) == text:
        return False
    import tempfile
    fd, temp = tempfile.mkstemp(prefix=".vault-", dir=d or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(temp, p)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return True


def tables(text):
    """抽出所有表格（已去掉分隔行）"""
    out, cur = [], []
    for ln in text.split("\n"):
        s = ln.strip()
        if s.startswith("|"):
            cs = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cs if c):
                continue
            cur.append(cs)
        elif cur:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def rows_by_id(text, pat):
    return [r for tb in tables(text) for r in tb if r and re.fullmatch(pat, r[0])]


def cell(r, i):
    return r[i].strip() if len(r) > i else ""


def est_days(s):
    m = re.search(r"(\d+(?:\.\d+)?)\s*[dD天]", s or "")
    return float(m.group(1)) if m else 0.0


def num(v):
    """3.0 → 3，1.5 → 1.5，省得笔记里到处是 .0"""
    return int(v) if float(v) == int(v) else v


def mid(s):
    """mermaid 节点 ID 不能带连字符，M1-T1 → M1_T1"""
    return s.replace("-", "_")


def cut(s, n):
    """节点标签要短，否则图会宽到没法看。括号里的补充说明一律砍掉"""
    s = re.sub(r"[（(].*$", "", s or "").strip().replace('"', "'")
    return s if len(s) <= n else s[:n - 1] + "…"


def task_dag(tasks, modules, limit=28):
    """按模块分组的任务依赖图。任务太多就不画——糊成一团不如不画，
    那种规模去看阅读器里可点、可高亮关键路径的交互式图"""
    if not tasks:
        return None
    if len(tasks) > limit:
        return False
    by_mod = {}
    for t in tasks:
        by_mod.setdefault(t["module"], []).append(t)
    roles = {m["id"]: m["role"] for m in modules}
    L = ["graph LR"]
    for m in sorted(by_mod):
        L.append('  subgraph %s["%s　%s"]'
                 % (mid(m), m, cut(roles.get(m, "").split("：")[0], 10)))
        for t in sorted(by_mod[m], key=lambda x: x["id"]):
            L.append('    %s["%s<br/>%s"]' % (mid(t["id"]), t["id"], cut(t["title"], 12)))
        L.append("  end")
    ids = {t["id"] for t in tasks}
    for t in sorted(tasks, key=lambda x: x["id"]):
        for d in t["deps"]:
            if d in ids:
                L.append("  %s --> %s" % (mid(d), mid(t["id"])))
    return L


# ---------- 采集文档 ----------

def collect(root):
    """扫出各节正文，按节号建索引；同时记下节的文件名（wikilink 要用）"""
    by_num, titles = {}, {}
    names = [d for d in sorted(os.listdir(root))
             if os.path.isdir(os.path.join(root, d))
             and not d.startswith("_") and not d.startswith(".") and d != "图谱"]
    names.sort(key=lambda n: (GROUP_ORDER.index(n) if n in GROUP_ORDER else 99, n))
    groups = []
    for g in names:
        gd = os.path.join(root, g)
        docs = []
        for f in sorted(x for x in os.listdir(gd) if x.endswith(".md")):
            m = re.match(r"^(\d{1,2})[-_.]?\s*(.+)\.md$", f)
            if not m:
                continue
            n = int(m.group(1))
            by_num[n] = read(os.path.join(gd, f))
            titles[n] = f[:-3]          # 不含扩展名的文件名，即 wikilink 目标
            docs.append((n, f[:-3]))
        if docs:
            groups.append((g, docs))
    return by_num, titles, groups


def extract(by_num):
    """表格 → 结构化数据。与 build_docs.py 的契约保持一致"""
    t6, t13, t19 = by_num.get(6, ""), by_num.get(13, ""), by_num.get(19, "")

    modules = [{"id": cell(r, 0), "role": cell(r, 1),
                "deps": re.findall(r"\bM\d{1,2}\b", cell(r, 2))}
               for r in rows_by_id(t6, r"M\d{1,2}")]

    tasks = [{"id": cell(r, 0), "title": cell(r, 1), "module": cell(r, 2),
              "deps": re.findall(r"M\d{1,2}-T\d{1,3}", cell(r, 3)),
              "input": cell(r, 4), "output": cell(r, 5),
              "accept": cell(r, 6), "est": est_days(cell(r, 7)),
              "edges": sorted(set(re.findall(r"E-\d{1,3}", cell(r, 6))))}
             for r in rows_by_id(t19, r"M\d{1,2}-T\d{1,3}")]

    edges = [{"id": cell(r, 0), "scene": cell(r, 1), "trigger": cell(r, 2),
              "expect": cell(r, 3), "module": cell(r, 4)}
             for r in rows_by_id(t13, r"E-\d{1,3}")]

    return modules, tasks, edges


def accept_lines(s):
    """「1) … 2) …」挤在一格，拆回逐条。
    编号只认行首或空白之后的，否则「（E-04）」里的「4）」会被当成条目编号"""
    t = re.sub(r"<br\s*/?>", "\n", s or "", flags=re.I)
    t = re.sub(r"(^|[\s;；])\s*([1-9][)）、])", r"\1\n\2", t)
    parts = [x.strip() for x in re.split(r"[\n;；]", t)]
    parts = [x for x in parts if len(x) > 2]
    return parts or [(s or "").strip() or "（文档里没写验收标准）"]


def layers(items, deps_of):
    """按依赖算层级；有环就地截断，不死循环"""
    ids = [x["id"] for x in items]
    lv = {}

    def walk(i, stack):
        if i in lv:
            return lv[i]
        if i in stack:
            return 0
        m = 0
        for p in deps_of(i):
            if p in ids:
                m = max(m, walk(p, stack + [i]) + 1)
        lv[i] = m
        return m

    for i in ids:
        walk(i, [])
    return lv


# ---------- 受保护区块 ----------

def harvest(path):
    """从已有笔记里收割受保护区块的内容"""
    if not os.path.exists(path):
        return {}
    return {m.group(1): m.group(2) for m in BLOCK_RE.finditer(read(path))}


def keep(kept, name, placeholder):
    """还原受保护区块。没回填过就放占位说明"""
    body = kept.get(name, "")
    if not body.strip() or body.strip() == placeholder.strip():
        body = placeholder
    return "<!-- %s:begin -->\n%s\n<!-- %s:end -->" % (name, body.strip("\n"), name)


def filled(kept, name, placeholder):
    """这个区块到底回填过没有"""
    body = kept.get(name, "")
    return bool(body.strip()) and body.strip() != placeholder.strip()


# ---------- 笔记生成 ----------

def fm(pairs):
    """YAML frontmatter。值原样写，调用方保证格式"""
    out = ["---"]
    for k, v in pairs:
        out.append("%s: %s" % (k, v))
    out.append("---")
    return "\n".join(out)


def ylist(xs):
    return "[%s]" % ", ".join(xs) if xs else "[]"


def mermaid(lines):
    return FENCE + "mermaid\n" + "\n".join(lines) + "\n" + FENCE


def module_note(m, tasks, edges, modules, titles, kept, mode="greenfield", seed=None):
    mine = [t for t in tasks if t["module"] == m["id"]]
    days = round(sum(t["est"] for t in mine), 1)
    rdeps = [x["id"] for x in modules if m["id"] in x["deps"]]
    my_edges = sorted({e for t in mine for e in t["edges"]} |
                      {e["id"] for e in edges if e["module"] == m["id"]},
                      key=lambda x: int(x.split("-")[1]))
    by_id = {e["id"]: e for e in edges}
    bf = mode == "brownfield"

    g = ["graph LR"]
    for d in m["deps"]:
        g.append("  %s[%s] --> %s[%s]" % (mid(d), d, mid(m["id"]), m["id"]))
    for d in rdeps:
        g.append("  %s[%s] --> %s[%s]" % (mid(m["id"]), m["id"], mid(d), d))
    if len(g) == 1:
        g.append("  %s[%s]" % (mid(m["id"]), m["id"]))
    g.append("  style %s stroke-width:3px" % mid(m["id"]))

    L = [fm([("type", "module"), ("id", m["id"]),
             ("depends_on", ylist(m["deps"])), ("required_by", ylist(rdeps)),
             ("task_count", len(mine)), ("est_days", num(days))]),
         "",
         "# %s　%s" % (m["id"], m["role"]),
         ""]

    # 存量项目里「代码在哪」比「有什么任务」重要，提到最前面
    if bf:
        L += ["## 代码位置", "",
              "> 要改这个模块，从这里进去。", "",
              keep(kept, "code", seed or PH_CODE_MOD_BF), ""]

    L += ["## 依赖关系",
          "",
          "- 本模块依赖：" + ("、".join("[[%s]]" % d for d in m["deps"])
                          or ("无" if bf else "无，可最先开工")),
          "- 被依赖：" + ("、".join("[[%s]]" % d for d in rdeps) or "无，没有模块等它"),
          "",
          mermaid(g),
          "",
          "## %s（%d 个 · %s 人天）" % ("待办任务" if bf else "下辖任务",
                                    len(mine), num(days)),
          ""]

    if mine:
        L += ["| 任务 | 标题 | 预估 | 覆盖边界 |", "|---|---|---|---|"]
        for t in sorted(mine, key=lambda x: x["id"]):
            L.append("| [[%s]] | %s | %s | %s |" % (
                t["id"], t["title"], (str(num(t["est"])) + "d") if t["est"] else "—",
                "、".join("[[%s]]" % e for e in t["edges"]) or "—"))
    elif bf:
        L.append("_没有待办。要改这个模块时，往 19 节加一行任务，"
                 "重跑脚本就会在这里出现任务卡。_")
    else:
        L.append("_这个模块一个任务都没有——回 19 节补上，否则它没人做。_")

    L += ["", "## 涉及的边界", ""]
    if my_edges:
        for e in my_edges:
            L.append("- [[%s]]　%s" % (e, by_id[e]["scene"] if e in by_id else ""))
    elif bf:
        L.append("_还没从代码里捞过这个模块的边界。去看它的错误分支、重试、"
                 "超时、空值兜底和并发保护，每找到一处就往 13 节记一条。_")
    else:
        L.append("_没有边界挂到这个模块。八类边界不太可能一条都不沾，回 13 节看看。_")

    if not bf:
        L += ["", "## 代码位置", "", keep(kept, "code", seed or PH_CODE)]

    L += ["", "## 备注", "",
          keep(kept, "notes", PH_NOTES_MOD_BF if bf else PH_NOTES_MOD), ""]
    return "\n".join(L)


def task_note(t, tasks, edges, modules, repo, main_branch, kept):
    by_edge = {e["id"]: e for e in edges}
    by_mod = {m["id"]: m for m in modules}
    unlocks = [x["id"] for x in tasks if t["id"] in x["deps"]]
    mod = by_mod.get(t["module"])

    L = [fm([("type", "task"), ("id", t["id"]), ("module", t["module"]),
             ("depends_on", ylist(t["deps"])), ("unlocks", ylist(unlocks)),
             ("edges", ylist(t["edges"])), ("est_days", num(t["est"])),
             ("branch", "task/" + t["id"]), ("status", "todo")]),
         "",
         "# %s　%s" % (t["id"], t["title"]),
         "",
         "- 所属模块：[[%s]]%s" % (t["module"], "　" + mod["role"] if mod else ""),
         "- 前置依赖：" + ("、".join("[[%s]]" % d for d in t["deps"]) or "无，可直接开工"),
         "- 完成后解锁：" + ("、".join("[[%s]]" % d for d in unlocks) or "无，它不卡别人"),
         "",
         "## 输入 / 产出",
         "",
         "- **输入**：" + (t["input"] or "无"),
         "- **产出**：" + (t["output"] or "见验收标准"),
         "",
         "## 验收标准",
         "",
         "> 逐条都要满足，这是验收时的唯一依据。",
         ""]
    for line in accept_lines(t["accept"]):
        L.append(re.sub(r"(E-\d{1,3})", r"[[\1]]", line))

    L += ["", "## 必须处理的边界", ""]
    if t["edges"]:
        for e in t["edges"]:
            d = by_edge.get(e)
            if d:
                L.append("- [[%s]]　%s" % (e, d["scene"]))
                L.append("    - 触发：%s" % (d["trigger"] or "—"))
                L.append("    - 期望：%s" % (d["expect"] or "—"))
            else:
                L.append("- [[%s]]　_文档里没找到这条边界的定义_" % e)
    else:
        L.append("_验收标准没挂边界编号。仍要按常识处理空输入、失败路径和重复提交。_")

    L += ["", "## 代码位置", "", keep(kept, "code", PH_CODE_TASK),
          "", "## 实施沉淀", "", keep(kept, "notes", PH_NOTES_TASK),
          "",
          "---",
          "",
          "栈分支 `task/%s` @ `%s`　落地进 `%s`"
          % (t["id"], repo, main_branch), ""]
    return "\n".join(L)


def edge_note(e, tasks, kept, mode="greenfield"):
    cover = [t for t in tasks if e["id"] in t["edges"]]
    L = [fm([("type", "edge"), ("id", e["id"]), ("module", e["module"] or "-"),
             ("covered_by", ylist([t["id"] for t in cover]))]),
         "",
         "# %s　%s" % (e["id"], e["scene"]),
         "",
         "| | |",
         "|---|---|",
         "| 触发条件 | %s |" % (e["trigger"] or "—"),
         "| 期望行为 | %s |" % (e["expect"] or "—"),
         "| 归属模块 | %s |" % ("[[%s]]" % e["module"] if re.fullmatch(r"M\d{1,2}", e["module"] or "") else (e["module"] or "—")),
         "",
         "## 被这些任务兜底",
         ""]
    if cover:
        for t in sorted(cover, key=lambda x: x["id"]):
            L.append("- [[%s]]　%s" % (t["id"], t["title"]))
    elif mode == "brownfield":
        L.append("_没有任务引用它。存量项目里这很正常——代码可能早就处理了。_")
        L.append("**「验证记录」要写清：现在的代码到底处理了没有、在哪一行、怎么验的。**"
                 " 如果发现根本没处理，往 19 节加一条任务。")
    else:
        L.append("**没有任何任务的验收标准引用这条边界。**")
        L.append("开发时没人负责它——要么挂到某个任务上，要么在 21 节写明为什么本期不处理。")

    L += ["", "## 验证记录", "", keep(kept, "notes", PH_NOTES_EDGE), ""]
    return "\n".join(L)


def sec(titles, n):
    """指向某节的 wikilink。那一节还没写就不要生成链接——
    Obsidian 会把指向不存在笔记的链接画成幽灵节点，比缺个链接更糟"""
    t = titles.get(n)
    return "[[%s]]" % t if t else "_（第 %02d 节还没写）_" % n


def moc_note(project, modules, tasks, edges, titles, groups, mode="greenfield", seeds=None):
    days = round(sum(t["est"] for t in tasks), 1)
    covered = len({e for t in tasks for e in t["edges"]} & {e["id"] for e in edges})
    rate = round(100 * covered / len(edges)) if edges else 0
    by_mod = {m["id"]: m for m in modules}
    by_edge = {e["id"]: e for e in edges}
    bf = mode == "brownfield"
    seeds = seeds or {}

    g = ["graph LR"]
    for m in modules:
        g.append('  %s["%s %s"]' % (mid(m["id"]), m["id"], m["role"].split("：")[0][:12]))
    for m in modules:
        for d in m["deps"]:
            if d in by_mod:
                g.append("  %s --> %s" % (mid(d), mid(m["id"])))

    L = ["# %s　项目知识库" % project,
         "",
         "> 这是本项目的入口。**任何人或模型要动这个项目，从这一页开始。**",
         ""] + ([
         "_这是一个已经在跑的项目，文档是补出来的。"
         "以代码为准：文档和代码打架时，先信代码，然后把文档改对。_",
         ""] if bf else []) + [
         "## 查东西去哪",
         "",
         "| 你想知道 | 去哪 |",
         "|---|---|",
         "| 项目干什么、不干什么 | %s、%s |" % (sec(titles, 1), sec(titles, 2)),
         "| 用什么技术、否掉过什么 | %s |" % sec(titles, 5),
         "| 某个模块负责什么、代码在哪 | `图谱/模块/<模块ID>.md` |",
         "| 某个任务怎么做、做完没有 | `图谱/任务/<任务ID>.md` |",
         "| 某种异常该怎么处理 | `图谱/边界/<边界ID>.md` |",
         "| 代码怎么摆、分几层 | %s、%s |" % (sec(titles, 7), sec(titles, 8)),
         "| 接口长什么样 | %s |" % sec(titles, 10),
         "| 界面该长什么样 | %s、%s |" % (sec(titles, 11), sec(titles, 12)),
         "| 为什么这么设计 | %s |" % sec(titles, 22),
         "| 有什么风险没解决 | %s |" % sec(titles, 21),
         "",
         "## 规模",
         "",
         ("%d 个模块 · %d 条边界 · %d 个待办任务"
          % (len(modules), len(edges), len(tasks))) if bf else
         ("%d 个模块 · %d 个任务 · %s 人天 · %d 条边界（%d%% 被任务覆盖）"
          % (len(modules), len(tasks), num(days), len(edges), rate)),
         "",
         "## 模块地图",
         "",
         mermaid(g),
         ""]

    # 存量项目：一眼看到哪个模块对应哪块代码
    if bf and seeds:
        L += ["## 代码位置速查", "", "| 模块 | 代码在哪 |", "|---|---|"]
        for m in sorted(modules, key=lambda x: x["id"]):
            first = ""
            for ln in (seeds.get(m["id"]) or "").split("\n"):
                hit = re.search(r"`([^`]+)`", ln)
                if hit:
                    first = "`%s`" % hit.group(1)
                    break
            L.append("| [[%s]] | %s |" % (m["id"], first or "_见模块笔记_"))
        L += ["", "_完整清单在各模块笔记的「代码位置」一段，那里才是可回填的。_", ""]

    L += ["## 模块", ""]
    for m in sorted(modules, key=lambda x: x["id"]):
        mine = [t for t in tasks if t["module"] == m["id"]]
        if bf and not mine:
            L.append("- [[%s]]　%s" % (m["id"], m["role"]))
            continue
        L.append("- [[%s]]　%s　· %d 任务 · %s 人天"
                 % (m["id"], m["role"], len(mine),
                    num(round(sum(t["est"] for t in mine), 1))))

    if not tasks and bf:
        L += ["", "## 待办任务", "",
              "_目前没有待办。要动这个项目时，往 %s 加一行，重跑 `build_vault.py` "
              "就会生成任务卡，接上和全新项目一样的派活与回填流程。_" % sec(titles, 19), ""]

    lv = layers(tasks, lambda i: next((t["deps"] for t in tasks if t["id"] == i), []))
    buckets = {}
    for t in tasks:
        buckets.setdefault(lv[t["id"]], []).append(t)

    if tasks:
        L += ["", "## %s（按开工批次）" % ("待办任务" if bf else "任务"), "",
              "同一批内互不依赖，可以并行派活；跨批必须等前面落地。", ""]
    for k in sorted(buckets):
        g2 = sorted(buckets[k], key=lambda x: x["id"])
        L.append("### 第 %d 批　%d 个 · %s 人天%s"
                 % (k + 1, len(g2), num(round(sum(t["est"] for t in g2), 1)),
                    "　（无前置依赖，可立即开工）" if k == 0 else ""))
        for t in g2:
            L.append("- [[%s]]　%s" % (t["id"], t["title"]))
        L.append("")

    dag = task_dag(tasks, modules)
    if dag:
        L += ["### 依赖全景", "",
              "箭头指向被阻塞的一方；同一列内的任务互不依赖。", "", mermaid(dag), ""]
    elif dag is False:
        L += ["### 依赖全景", "",
              "任务共 %d 个，画成一张图会糊。去阅读器 `index.html` 概览页看"
              "可点、可高亮关键路径的交互式依赖图。" % len(tasks), ""]

    L += ["## 边界", ""]
    if edges:
        for e in sorted(edges, key=lambda x: int(x["id"].split("-")[1])):
            cover = [t["id"] for t in tasks if e["id"] in t["edges"]]
            tail = "、".join("[[%s]]" % c for c in cover)
            if not tail:
                tail = "_见验证记录_" if bf else "**没有任务兜底**"
            L.append("- [[%s]]　%s　→ %s" % (e["id"], e["scene"], tail))
    elif bf:
        L.append("_还没从代码里捞过边界。这是存量项目补文档时最容易跳过、"
                 "也最容易出事的一步——去 13 节。_")
    else:
        L.append("_13 节没抽到边界表。_")

    L += ["", "## 章节目录", ""]
    for gname, docs in groups:
        L.append("**%s**" % gname.split("-", 1)[-1])
        L.append("　".join("[[%s]]" % t for _, t in docs))
        L.append("")

    L += ["---", "",
          "_`图谱/` 下的笔记由 `build_vault.py` 从 24 节的表格派生。"
          "改这些笔记的正文没用，下次重跑会被覆盖——"
          "要改内容请改对应章节的表格，再重跑脚本。"
          "只有「代码位置」「实施沉淀」「验证记录」这几段是受保护的，重跑不动它们。_", ""]
    return "\n".join(L)


# ---------- 项目根的模型引导文件 ----------

VAULT_BEGIN, VAULT_END = "<!-- vault:begin -->", "<!-- vault:end -->"


def agents_block(project, doc_rel, modules, tasks, edges, mode="greenfield"):
    bf = mode == "brownfield"
    L = [VAULT_BEGIN,
         "## 先读这个：项目知识库",
         "",
         "本项目的设计、任务拆分、边界处理、实现记录，全部沉淀在这里：",
         "",
         "    %s/" % doc_rel,
         "",
         "**动手写任何代码之前，先读 `%s/_MOC.md`**。它是总索引，告诉你查什么去哪找。"
         % doc_rel,
         ""] + ([
         "这是一个**已经在跑的项目**，文档是补出来的。文档和代码打架时以代码为准，"
         "然后把文档改对——别反过来改代码迁就文档。",
         "",
         "规模：%d 个模块 · %d 条边界 · %d 个待办任务。"
         % (len(modules), len(edges), len(tasks))] if bf else [
         "规模：%d 个模块 · %d 个任务 · %d 条边界。"
         % (len(modules), len(tasks), len(edges))]) + [
         "",
         "### 查东西去哪",
         "",
         "| 你要找 | 路径 |",
         "|---|---|",
         "| 项目目标、明确不做什么 | `%s/00-概览/` |" % doc_rel,
         "| 技术栈与被否方案 | `%s/01-约束/05-技术栈.md` |" % doc_rel,
         "| 架构、数据模型、接口约定 | `%s/02-设计/` |" % doc_rel,
         "| 前后端目录与分层 | `%s/02-设计/07-前端架构.md`、`08-后端架构.md` |" % doc_rel,
         "| 界面风格与交互规范 | `%s/02-设计/11-UI.md`、`12-UX.md` |" % doc_rel,
         "| **某个模块负责什么、代码在哪** | `%s/图谱/模块/<模块ID>.md` |" % doc_rel,
         "| **某个任务的完整要求与实现记录** | `%s/图谱/任务/<任务ID>.md` |" % doc_rel,
         "| **某种异常情况该怎么处理** | `%s/图谱/边界/<边界ID>.md` |" % doc_rel,
         "",
         "任务 ID 形如 `M1-T1`，模块 `M1`，边界 `E-01`。三类笔记互相 `[[链接]]`，",
         "顺着链接走能从任何一个点找到相关的全部上下文。",
         "",
         "### 动代码的规矩",
         ""] + ([
         "**改之前：**",
         "",
         "- 先定位到模块。不知道改哪就看 `_MOC.md` 的「代码位置速查」。",
         "- 读那篇模块笔记的「代码位置」和「备注」——「备注」写的是哪里不能碰、"
         "为什么长成这样，比读代码省时间。",
         "- 看这个模块「涉及的边界」。改动最容易踩掉的就是某条已有的兜底。",
         "",
         "**改之后（同一次提交里做完，不留到下次）：**",
         "",
         "- 代码位置变了（挪了文件、拆了函数、加了入口），更新对应模块笔记的"
         "「代码位置」。**过期的路径比没有路径更坏。**",
         "- 做了非显而易见的取舍，写进「备注」。标准是：三个月后有人要动这块，"
         "这句话能不能拦住他踩同一个坑。",
         "- 发现新的边界情况，往 `%s/03-质量/13-边界问题与异常处理.md` 加一行，"
         "重跑 `build_vault.py`。" % doc_rel,
         "",
         "**成规模的改动**（重构、新功能、迁移）先立任务：往 "
         "`%s/04-执行/19-模块任务拆分.md` 加任务行，重跑脚本生成任务卡，再按任务卡开工。"
         "这样验收标准、覆盖的边界、最后落在哪几行，全都留得下来。" % doc_rel,
         "",
         "- 模块划分要和真实目录对得上。**目录动了，06 节的表也要跟着动**，"
         "否则笔记里每一条代码位置都会错位。"] if bf else [
         "- 一个任务一层栈分支 `task/<任务ID>`，做完提交并 `gh stack push`，**不自己合并**。",
         "  落地由审查方做：栈里只有一个开放 PR（GitHub 不为单个 PR 建栈对象）就按普通 PR `gh pr merge --merge`；"
         "两个以上才走 `gh stack merge`。任务的前置都已落地时，单 PR 是常态，不用为了凑栈去等下一个任务。",
         "- 并行开工时每个任务用自己的 git worktree（仓库旁边的同级目录，实施提示词第 0 步给命令），不在别人的检出里切分支；planning 类工作文件放仓库外。",
         "- 派下来的任务前置都已合进主干，所以本任务是新栈最底层：`gh stack init`。`gh stack add` 报 All branches in this stack have been merged 就是该 init，不用问。",
         "- 只做当前任务范围内的事，不提前做后面的。",
         "- 验收标准和边界编号是硬指标，不是参考。每条都要能指到具体代码。",
         "- 实施方不擅改任务定义；审查方可依据原始需求和已定契约定点修正文档、任务配置及有效范围。不得降低验收标准迁就错误代码。",
         "- 审查发现局部文档问题，在原任务分支打补丁，运行 `maintain_docs.py begin/sync/verify` 同步并复验，随后继续原 PR 提交、推送和落地；不重跑需求、架构和整套文档生成流程。",
         "- 实施、审查、并行排程共用有效路径（taskPaths + task-contracts.json 的 supportPaths）；漏列的必要支持文件由审查方补齐并核对冲突，不私自无限扩大范围。",
         "- **落地前必须回填** `图谱/任务/<任务ID>.md` 的「代码位置」和「实施沉淀」两段。",
         "  代码位置格式：`` `路径:行号` — 说明 ``，一行一处。",
         "  没回填不得落地——知识库烂掉，都是从没人回填开始的。"]) + [
         "",
         "_本段由 build_vault.py 生成，重跑会覆盖；这两个标记之外的内容不会动。_",
         VAULT_END]
    return "\n".join(L)


def upsert_block(path, block, header):
    """把 vault 段插进去或就地更新，不碰文件里别的内容"""
    if os.path.exists(path):
        old = read(path)
        if VAULT_BEGIN in old and VAULT_END in old:
            new = re.sub(re.escape(VAULT_BEGIN) + r".*?" + re.escape(VAULT_END),
                         lambda _: block, old, flags=re.S)
            return new, "更新"
        return old.rstrip() + "\n\n" + block + "\n", "追加"
    return header + "\n\n" + block + "\n", "新建"


# ---------- 校验 ----------

def lint(modules, tasks, edges, root, mode="greenfield"):
    """只报客观可判定的问题"""
    out = []
    bf = mode == "brownfield"
    mids = {m["id"] for m in modules}
    tids = {t["id"] for t in tasks}
    eids = {e["id"] for e in edges}

    if not modules:
        out.append("06 节没抽到模块表（应为 | M1 | 职责 | 依赖 |），知识库会是空的")
    if not tasks and not bf:
        out.append("19 节没抽到任务表（应为 8 列，首列 M1-T1 形式）")

    for m in modules:
        if bf and re.match(r"^\s*TODO", m["role"] or ""):
            out.append("模块 %s 的职责还是 TODO——读代码把它填了，"
                       "否则笔记标题和总索引里全是 TODO" % m["id"])
        for d in m["deps"]:
            if d not in mids:
                out.append("模块 %s 依赖了不存在的模块 %s" % (m["id"], d))
    for t in tasks:
        if t["module"] not in mids:
            out.append("任务 %s 的模块 %s 在 06 节没有定义" % (t["id"], t["module"]))
        for d in t["deps"]:
            if d not in tids:
                out.append("任务 %s 依赖了不存在的任务 %s" % (t["id"], d))
        for e in t["edges"]:
            if e not in eids:
                out.append("任务 %s 的验收标准引用了不存在的边界 %s" % (t["id"], e))
    for e in edges:
        if not any(e["id"] in t["edges"] for t in tasks) and not bf:
            out.append("边界 %s 没有被任何任务兜底，知识库里会是孤儿节点" % e["id"])

    # 存量模式下，「代码位置」空着才是真问题——那是这类项目的主干
    if bf:
        blank = []
        for m in modules:
            p = os.path.join(root, DIR_MOD, m["id"] + ".md")
            if os.path.exists(p) and not filled(harvest(p), "code", PH_CODE_MOD_BF):
                blank.append(m["id"])
        if blank:
            out.append("这些模块笔记的「代码位置」还是空的：%s"
                       "——存量项目里这一段是主干，空着等于没建知识库" % "、".join(blank))
        if not edges:
            out.append("边界表一条都没有。存量项目里边界不是不存在，是还没人去代码里捞"
                       "——错误分支、重试、超时、并发保护都在那")

    # 回填情况——不是错，是进度
    done, total = 0, 0
    for t in tasks:
        p = os.path.join(root, DIR_TASK, t["id"] + ".md")
        if os.path.exists(p):
            total += 1
            k = harvest(p)
            if filled(k, "code", PH_CODE_TASK) and filled(k, "notes", PH_NOTES_TASK):
                done += 1
    return out, done, total


# ---------- 主流程 ----------

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = [a for a in sys.argv[1:] if a.startswith("--")]
    check_only = "--check" in flags

    root = None
    if "--root" in sys.argv:
        i = sys.argv.index("--root")
        if i + 1 < len(sys.argv):
            root = sys.argv[i + 1]
            if root in args:
                args.remove(root)

    selected = None
    if "--tasks" in sys.argv:
        i = sys.argv.index("--tasks")
        if i + 1 >= len(sys.argv):
            print("--tasks 后跟逗号分隔的任务 ID")
            return 2
        value = sys.argv[i + 1]
        selected = set(value.split(","))
        if value in args:
            args.remove(value)

    forced_mode = None
    if "--mode" in sys.argv:
        i = sys.argv.index("--mode")
        if i + 1 < len(sys.argv):
            forced_mode = sys.argv[i + 1]
            if forced_mode in args:
                args.remove(forced_mode)
            if forced_mode not in ("greenfield", "brownfield"):
                print("--mode 只认 greenfield 或 brownfield")
                return 2

    if len(args) != 1:
        print(__doc__)
        return 2
    doc = args[0]
    if not os.path.isdir(doc):
        print("需要传一个文档目录：" + doc)
        return 2

    doc_abs = os.path.abspath(doc)
    if root is None:
        parent = os.path.dirname(doc_abs)
        root = os.path.dirname(parent) if os.path.basename(parent).lower() == "docs" else parent
    doc_rel = os.path.relpath(doc_abs, os.path.abspath(root)).replace("\\", "/")

    by_num, titles, groups = collect(doc_abs)
    if not by_num:
        print("目录下没找到 NN-名称.md 形式的文档文件")
        return 2
    modules, tasks, edges = extract(by_num)
    project = os.path.basename(doc_abs).replace("-开发文档", "")

    # 抽到任务就是新建项目，抽不到就是存量仓库在补文档
    mode = forced_mode or ("greenfield" if tasks else "brownfield")
    bf = mode == "brownfield"
    mode_cn = "存量仓库补文档" if bf else "新建项目"

    # scan_repo.py 留下的模块→代码位置，只在没人回填过时当初始内容用
    seeds = {}
    cm = os.path.join(doc_abs, "_run", "code_map.json")
    if os.path.exists(cm):
        try:
            raw = json.loads(read(cm)) or {}
            seeds = {k: ("\n".join(v) if isinstance(v, list) else str(v))
                     for k, v in raw.items()}
        except ValueError:
            print("  _run/code_map.json 不是合法 JSON，忽略")

    repo, main_branch = os.path.basename(os.path.abspath(root)), "main"
    pp = os.path.join(doc_abs, "_run", "presentation.json")
    if os.path.exists(pp):
        try:
            ho = (json.loads(read(pp)) or {}).get("handoff") or {}
            repo = ho.get("repo") or repo
            main_branch = ho.get("mainBranch") or main_branch
        except ValueError:
            pass

    problems, done, total = lint(modules, tasks, edges, doc_abs, mode)

    if check_only:
        print("校验 %s　[%s]" % (doc_rel, mode_cn))
        print("  模块 %d / 任务 %d / 边界 %d" % (len(modules), len(tasks), len(edges)))
        if total:
            print("  实施沉淀已回填 %d/%d 个任务" % (done, total))
        if problems:
            print("\n发现 %d 个问题：" % len(problems))
            for p in problems:
                print("  - " + p)
            return 1
        print("  没发现问题")
        return 0

    if selected is not None:
        unknown = selected - {t["id"] for t in tasks}
        if unknown:
            print("--tasks 包含未知任务：" + ", ".join(sorted(unknown)))
            return 2

    # ── 写笔记；正文未变不写磁盘，局部同步保留无关任务笔记 ──
    written, protected_kept = 0, 0
    for m in modules:
        p = os.path.join(doc_abs, DIR_MOD, m["id"] + ".md")
        k = harvest(p)
        body = module_note(m, tasks, edges, modules, titles, k, mode, seeds.get(m["id"]))
        protected_kept += sum(1 for n, ph in
                              (("code", PH_CODE_MOD_BF if bf else PH_CODE),
                               ("notes", PH_NOTES_MOD_BF if bf else PH_NOTES_MOD))
                              if filled(k, n, ph))
        write(p, body)
        written += 1

    for t in tasks:
        p = os.path.join(doc_abs, DIR_TASK, t["id"] + ".md")
        if selected is not None and t["id"] not in selected and os.path.exists(p):
            continue
        k = harvest(p)
        body = task_note(t, tasks, edges, modules, repo, main_branch, k)
        # status 是人手维护的，重跑不覆盖
        if os.path.exists(p):
            old = re.search(r"^status:\s*(\S+)", read(p), re.M)
            if old:
                body = re.sub(r"^status:\s*\S+", "status: " + old.group(1), body, count=1, flags=re.M)
        protected_kept += sum(1 for n, ph in (("code", PH_CODE_TASK), ("notes", PH_NOTES_TASK))
                              if filled(k, n, ph))
        write(p, body)
        written += 1

    for e in edges:
        p = os.path.join(doc_abs, DIR_EDGE, e["id"] + ".md")
        k = harvest(p)
        body = edge_note(e, tasks, k, mode)
        protected_kept += 1 if filled(k, "notes", PH_NOTES_EDGE) else 0
        write(p, body)
        written += 1

    write(os.path.join(doc_abs, "_MOC.md"),
          moc_note(project, modules, tasks, edges, titles, groups, mode, seeds))

    # ── .obsidian：把 _run/ 排除出图谱，已存在就不动 ──
    ob = os.path.join(doc_abs, ".obsidian", "app.json")
    if not os.path.exists(ob):
        write(ob, json.dumps({"userIgnoreFilters": ["_run/"],
                              "attachmentFolderPath": "./"},
                             ensure_ascii=False, indent=2) + "\n")

    # ── 项目根的模型引导文件 ──
    block = agents_block(project, doc_rel, modules, tasks, edges, mode)
    notes = []
    for fn, head in (("AGENTS.md", "# %s" % project),
                     ("CLAUDE.md", "# %s" % project)):
        p = os.path.join(root, fn)
        text, how = upsert_block(p, block, head)
        write(p, text)
        notes.append("%s（%s）" % (fn, how))

    print("知识库已构建：%s　[%s]" % (doc_rel, mode_cn))
    print("  笔记 %d 篇：模块 %d / 任务 %d / 边界 %d"
          % (written, len(modules), len(tasks), len(edges)))
    print("  总索引 _MOC.md")
    print("  项目根：" + "、".join(notes))
    if seeds:
        print("  从 _run/code_map.json 取了 %d 个模块的代码位置作为初始内容" % len(seeds))
    if protected_kept:
        print("  保留了 %d 处已回填的内容（代码位置 / 实施沉淀 / 验证记录）" % protected_kept)
    if total:
        print("  实施沉淀完成度 %d/%d 个任务" % (done, total))
    if problems:
        print("\n  这些问题会让图谱出现断链或孤儿节点：")
        for p in problems:
            print("    - " + p)
    print("\n  用 Obsidian 打开 %s 这个目录即可（Open folder as vault）" % doc_rel)
    if bf:
        print("  存量模式：模块笔记的「代码位置」和「备注」是主干，空着等于没建")
    return 0


if __name__ == "__main__":
    sys.exit(main())
