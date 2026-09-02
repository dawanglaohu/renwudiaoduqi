#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""开发文档审查器（机械校验层）

用法:
    python review.py <文档目录>        # 多文件模式（推荐）
    python review.py <文档.md>         # 单文件模式（兼容旧格式）
    python review.py <路径> --json     # 机器可读，供 build_docs.py 读取审查状态

退出码:
    0  无阻断项
    1  有阻断项（BLOCK）
    2  用法/读取错误

多文件模式下，每个 `NN-名称.md` 文件算一节，编号取文件名前缀。
只做客观可判定的检查。语义质量由审查员子代理负责，两者配合使用。
"""

import json
import os
import re
import sys
from collections import defaultdict

# ---------- 约定 ----------

REQUIRED_SECTIONS = [
    # (编号, 名称, 关键词, 排除词)
    (1, "概述与目标", ["概述", "目标"], ["非目标"]),
    (2, "非目标", ["非目标"], []),
    (3, "术语表", ["术语", "词汇"], []),
    (4, "开发条件", ["开发条件", "前置"], []),
    (5, "技术栈", ["技术栈", "选型"], []),
    # 6 排在 7/8 之前且关键词含「架构」，不排除前后端就会在 06 缺失时认领 07
    (6, "系统架构与模块划分", ["架构", "模块划分"], ["前端", "后端"]),
    (7, "前端架构", ["前端架构", "前端框架", "前端"], []),
    (8, "后端架构", ["后端架构", "后端框架", "后端"], []),
    (9, "数据模型", ["数据模型", "数据结构"], []),
    (10, "接口约定", ["接口"], []),
    (11, "UI", ["UI", "界面"], []),
    (12, "UX", ["UX", "交互", "体验"], []),
    (13, "边界问题与异常处理", ["边界", "异常"], []),
    (14, "安全与权限", ["安全", "权限"], []),
    (15, "性能与容量假设", ["性能", "容量"], []),
    (16, "可观测性", ["可观测", "监控"], []),
    (17, "测试策略", ["测试"], []),
    (18, "部署与运维", ["部署", "运维", "发布"], []),
    (19, "模块任务拆分", ["任务拆分", "任务分解"], []),
    (20, "里程碑与交付顺序", ["里程碑", "交付顺序"], []),
    (21, "风险与未决事项", ["风险", "未决"], []),
    (22, "决策记录", ["决策记录"], []),
    (23, "变更记录", ["变更"], []),
    (24, "参考资料", ["参考"], []),
]

# 章节所属分组（多文件模式下的目录名），用于校验文件摆放
SECTION_GROUP = {
    1: "00-概览", 2: "00-概览", 3: "00-概览",
    4: "01-约束", 5: "01-约束",
    6: "02-设计", 7: "02-设计", 8: "02-设计", 9: "02-设计",
    10: "02-设计", 11: "02-设计", 12: "02-设计",
    13: "03-质量", 14: "03-质量", 15: "03-质量", 16: "03-质量", 17: "03-质量",
    18: "04-执行", 19: "04-执行", 20: "04-执行", 21: "04-执行",
    22: "05-附录", 23: "05-附录", 24: "05-附录",
}

# 各节的语义锚点：编号 → 边界表所在节 / 任务表所在节 等
SEC_EDGES, SEC_TASKS, SEC_ARCH = 13, 19, 6
SEC_STACK, SEC_PERF, SEC_RISK, SEC_DEC = 5, 15, 21, 22
SEC_FE_ARCH, SEC_BE_ARCH, SEC_API = 7, 8, 10
SEC_UI = 11

# build_vault.py 的派生物。它们不是源文件，不参与本脚本的任何检查
DERIVED_DIRS = {"图谱"}
DERIVED_FILES = {"_moc.md"}

VALID_ESTIMATES = {0.5, 1.0, 1.5, 2.0}

VAGUE_WORDS = [
    "良好", "合理", "流畅", "友好", "美观", "尽量", "适当", "优化",
    "稳定", "快速", "方便", "完善", "健壮", "清晰", "正常工作", "体验好",
]

BANNED_TITLE_PATTERNS = [
    (r"^实现\S{0,12}模块$", "「实现X模块」是模块不是任务"),
    (r"^\S{0,12}模块$", "光写模块名不是任务"),
    (r"^完成(后端|前端|开发|整体)", "「完成后端/前端」粒度过粗"),
    (r"^(后端|前端|全栈)开发$", "按角色划分不是按产出划分"),
    (r"^做\S*页面$", "「做X页面」没有可验收产出"),
    (r"(全部|所有|整个)(功能|页面|接口|模块)", "包含「全部/整个」说明没拆开"),
]

PLACEHOLDER_PATTERNS = [
    # 尖括号占位符，但放过 HTML 标签和 <http...> 这类正常写法
    (r"<(?!/?(?:br|b|i|u|s|em|strong|code|span|div|p|a|img|sub|sup)\b)(?!https?:)[^>\n]{1,40}>",
     "尖括号占位符"),
    (r"\bTODO\b", "TODO 残留"),
    (r"\bXXX\b", "XXX 残留"),
    (r"待补充", "「待补充」残留"),
    (r"待定(?!事项)", "「待定」残留"),
    (r"占位符", "「占位符」残留"),
    (r"\.\.\.\s*$", "省略号结尾，内容未写完"),
]

BLOCK, WARN, INFO = "BLOCK", "WARN", "INFO"


class Report:
    def __init__(self):
        self.items = []

    def add(self, level, code, msg, where=None):
        self.items.append({"level": level, "code": code, "msg": msg, "where": where})

    def block(self, code, msg, where=None):
        self.add(BLOCK, code, msg, where)

    def warn(self, code, msg, where=None):
        self.add(WARN, code, msg, where)

    def info(self, code, msg, where=None):
        self.add(INFO, code, msg, where)

    def count(self, level):
        return sum(1 for i in self.items if i["level"] == level)


# ---------- 解析 ----------

HEADING_RE = re.compile(r"^(#{1,4})\s*(?:第?\s*)?(\d{1,2})?[\.、\s]*(.+?)\s*$")
FILE_RE = re.compile(r"^(\d{1,2})[-_.]?\s*(.+)\.md$")


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def sections_from_text(lines, fname=""):
    """单文件模式：按 markdown 标题切节"""
    heads, in_fence = [], False
    for i, ln in enumerate(lines):
        if ln.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = HEADING_RE.match(ln)
        if m and ln.startswith("#"):
            heads.append({"num": int(m.group(2)) if m.group(2) else None,
                          "title": m.group(3).strip(), "start": i, "file": fname})
    for idx, h in enumerate(heads):
        end = heads[idx + 1]["start"] if idx + 1 < len(heads) else len(lines)
        h["body"] = "\n".join(lines[h["start"] + 1:end]).strip()
    return heads


def sections_from_dir(root):
    """多文件模式：每个 NN-名称.md 算一节，返回 (sections, units)"""
    sections, units = [], []
    for dirpath, dirnames, filenames in os.walk(root):
        # 除了 _run/ 与 .obsidian/，还要跳开 build_vault.py 的派生物：
        # 图谱/ 里的 <!-- code:begin --> 是受保护区块标记，_MOC.md 里的 <模块ID> 是占位说明，
        # 两者都会被占位符检查当成待填的坑。建过知识库之后重跑，那是几十条假阻断。
        dirnames[:] = [d for d in dirnames
                       if not d.startswith("_") and not d.startswith(".")
                       and d not in DERIVED_DIRS]
        for fn in sorted(filenames):
            if not fn.endswith(".md") or fn.lower() in DERIVED_FILES:
                continue
            rel = os.path.relpath(os.path.join(dirpath, fn), root).replace("\\", "/")
            text = read(os.path.join(dirpath, fn))
            units.append({"file": rel, "lines": text.split("\n")})
            if fn.lower() == "readme.md":
                continue
            m = FILE_RE.match(fn)
            if not m:
                continue
            sections.append({
                "num": int(m.group(1)), "title": m.group(2).strip(),
                "body": text.strip(), "start": 0, "file": rel,
                "group": os.path.dirname(rel).split("/")[0] if "/" in rel else "",
            })
    sections.sort(key=lambda s: s["num"])
    return sections, units


def title_matches(title, kws, negs):
    t = title.lower()
    if any(n.lower() in t for n in negs):
        return False
    for k in kws:
        k = k.lower()
        if k.isascii():
            if re.search(r"(?<![a-z])" + re.escape(k) + r"(?![a-z])", t):
                return True
        elif k in t:
            return True
    return False


def map_required(sections):
    """把必备章节映射到实际章节。

    按关键词认领、编号只做消歧，并保证一个章节不被两个需求同时认领——
    否则少写一节导致后面编号左移时，会出现张冠李戴（拿里程碑当任务拆分）。
    """
    claimed, result = set(), {}
    for num, _name, kws, negs in REQUIRED_SECTIONS:
        cands = [s for s in sections
                 if id(s) not in claimed and title_matches(s["title"], kws, negs)]
        if not cands:
            result[num] = None
            continue
        exact = [s for s in cands if s["num"] == num]
        chosen = exact[0] if exact else cands[0]
        claimed.add(id(chosen))
        result[num] = chosen
    return result


def parse_tables(body):
    """从一段 markdown 里抽出所有表格，返回 [[cells,...],...]（已去掉分隔行）"""
    tables, cur = [], []
    for ln in body.split("\n"):
        s = ln.strip()
        if s.startswith("|"):
            cells = [c.strip() for c in s.strip("|").split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue
            cur.append(cells)
        else:
            if cur:
                tables.append(cur)
                cur = []
    if cur:
        tables.append(cur)
    return tables


def rows_matching(body, id_pattern):
    out = []
    for tb in parse_tables(body):
        for cells in tb:
            if cells and re.fullmatch(id_pattern, cells[0].strip()):
                out.append(cells)
    return out


def col(cells, idx, default=""):
    return cells[idx].strip() if len(cells) > idx else default


def loc(sec, line=None):
    if not sec:
        return None
    f = sec.get("file") or ""
    return "%s:%d" % (f, line) if line else (f or None)


# ---------- 检查 ----------

def check_sections(rep, smap, multi):
    for num, name, _kws, _negs in REQUIRED_SECTIONS:
        sec = smap.get(num)
        if sec is None:
            hint = "（应放在 %s/%02d-%s.md）" % (SECTION_GROUP[num], num, name) if multi else ""
            rep.block("S1", "缺少章节 %d. %s%s" % (num, name, hint))
            continue
        body = sec["body"]
        if len(re.sub(r"[\s|:\-#]", "", body)) < 15:
            rep.block("S2", "章节 %d. %s 是空的" % (num, name), loc(sec))
        elif "不适用" in body[:40]:
            reason = body.split("不适用", 1)[1]
            if len(re.sub(r"[\s，。：:,\.]", "", reason)) < 6:
                rep.warn("S3", "章节 %d. %s 写了不适用但没给理由" % (num, name), loc(sec))
            else:
                rep.info("S4", "章节 %d. %s 标记为不适用（已说明理由）" % (num, name), loc(sec))
        if multi and sec.get("group") and sec["group"] != SECTION_GROUP[num]:
            rep.warn("S5", "章节 %d. %s 放在 %s，按约定应在 %s"
                     % (num, name, sec["group"], SECTION_GROUP[num]), loc(sec))


def check_placeholders(rep, units, risk_file):
    for u in units:
        in_fence = False
        for i, ln in enumerate(u["lines"]):
            if ln.lstrip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            for pat, desc in PLACEHOLDER_PATTERNS:
                if re.search(pat, ln):
                    rep.block("P1", "%s：%s" % (desc, ln.strip()[:60]),
                              "%s:%d" % (u["file"], i + 1))
                    break
            if re.search(r"\bTBD\b", ln) and u["file"] != risk_file:
                rep.warn("P2", "TBD 出现在风险章节之外，需同步登记：%s" % ln.strip()[:60],
                         "%s:%d" % (u["file"], i + 1))


def check_edges(rep, sec):
    if sec is None:
        return {}
    edges, seen = {}, set()
    for cells in rows_matching(sec["body"], r"E-\d{1,3}"):
        eid = col(cells, 0)
        if eid in seen:
            rep.block("E1", "边界编号重复：%s" % eid, loc(sec))
        seen.add(eid)
        expect = col(cells, 3) or col(cells, -1)
        if len(re.sub(r"[\s\-—]", "", expect)) < 4:
            rep.block("E2", "%s 没写期望行为" % eid, loc(sec))
        edges[eid] = cells
    if not edges:
        rep.block("E3", "边界章节里没有 E-XX 编号的表格行，无法与任务验收标准挂钩", loc(sec))
    elif len(edges) < 5:
        rep.warn("E4", "边界只有 %d 条，八类边界不太可能这么少，很可能漏扫了" % len(edges), loc(sec))
    nums = sorted(int(e.split("-")[1]) for e in edges)
    if nums and nums != list(range(1, len(nums) + 1)):
        rep.warn("E5", "边界编号不连续：%s" % nums, loc(sec))
    return edges


def check_tasks(rep, sec, module_ids, edges, risk_body):
    if sec is None:
        return
    where = loc(sec)
    rows = rows_matching(sec["body"], r"M\d{1,2}-T\d{1,3}")
    if not rows:
        rep.block("T0", "任务拆分章节里没有 M<数字>-T<数字> 格式的任务表", where)
        return

    tasks, by_module, referenced = {}, defaultdict(list), set()
    for cells in rows:
        tid = col(cells, 0)
        if tid in tasks:
            rep.block("T1", "任务 ID 重复：%s" % tid, where)
        if len(cells) < 8:
            rep.block("T2", "%s 任务卡字段不全（需 8 列：ID/标题/模块/依赖/输入/产出/验收标准/预估），"
                            "实际 %d 列" % (tid, len(cells)), where)
        title, dep = col(cells, 1), col(cells, 3)
        accept, est = col(cells, 6), col(cells, 7)
        tasks[tid] = {"title": title, "dep": dep, "accept": accept, "est": est}
        by_module[tid.split("-")[0]].append(tid)

        for pat, why in BANNED_TITLE_PATTERNS:
            if re.search(pat, title):
                rep.block("T3", "%s 标题不合格（%s）：%s" % (tid, why, title), where)
                break
        if len(title) < 6:
            rep.warn("T4", "%s 标题过短，看不出产出：%s" % (tid, title), where)

        m = re.search(r"(\d+(?:\.\d+)?)\s*[dD天]", est)
        if not m:
            rep.block("T5", "%s 预估格式不对（应为 0.5d/1d/1.5d/2d）：%s" % (tid, est or "空"), where)
        else:
            v = float(m.group(1))
            if v > 2:
                rep.block("T6", "%s 预估 %sd 超过 2 天上限，必须继续拆" % (tid, v), where)
            elif v not in VALID_ESTIMATES:
                rep.warn("T7", "%s 预估 %sd 不在 0.5/1/1.5/2 档位内" % (tid, v), where)

        parts = [p for p in re.split(r"[1-9][)）\.、]|；|;|<br\s*/?>|\n", accept) if len(p.strip()) > 3]
        if len(parts) < 2:
            rep.block("T8", "%s 验收标准少于 2 条" % tid, where)
        for w in VAGUE_WORDS:
            if w in accept:
                rep.block("T9", "%s 验收标准含无法客观判定的词「%s」：%s" % (tid, w, accept[:50]), where)
                break
        found = re.findall(r"E-\d{1,3}", accept)
        if not found:
            rep.warn("T10", "%s 验收标准没有引用任何边界编号" % tid, where)
        referenced.update(found)

    # 依赖完整性与成环
    graph = {}
    for tid, t in tasks.items():
        deps = re.findall(r"M\d{1,2}-T\d{1,3}", t["dep"])
        for d in deps:
            if d not in tasks:
                rep.block("T11", "%s 依赖了不存在的任务 %s" % (tid, d), where)
        graph[tid] = [d for d in deps if d in tasks]

    color, reported = {}, set()

    def dfs(n, path):
        color[n] = 1
        for nxt in graph.get(n, []):
            if color.get(nxt) == 1:  # 回边，真环
                cyc = path[path.index(nxt):] + [nxt] if nxt in path else [n, nxt]
                key = frozenset(cyc)
                if key not in reported:
                    reported.add(key)
                    rep.block("T12", "依赖成环：" + " → ".join(cyc), where)
            elif color.get(nxt, 0) == 0:
                dfs(nxt, path + [nxt])
        color[n] = 2  # 必须收尾，否则后续从别处走到它会被误判成环

    for tid in tasks:
        if color.get(tid, 0) == 0:
            dfs(tid, [tid])

    if not any(not graph[t] for t in tasks):
        rep.block("T13", "所有任务都有前置依赖，第一批无法开工", where)

    for mid in sorted(by_module):
        if len(by_module[mid]) < 3:
            rep.block("T14", "模块 %s 只拆出 %d 个任务（要求至少 3 个）"
                      % (mid, len(by_module[mid])), where)
    for mid in sorted(module_ids):
        if mid not in by_module:
            rep.block("T15", "架构章节里的模块 %s 没有任何任务" % mid, where)
    for mid in sorted(by_module):
        if module_ids and mid not in module_ids:
            rep.warn("T16", "任务表里的模块 %s 在架构章节没有定义" % mid, where)

    uncovered = sorted(set(edges) - referenced, key=lambda e: int(e.split("-")[1]))
    for eid in uncovered:
        if eid in risk_body:
            rep.info("T17", "%s 未被任务覆盖，但已在风险与未决事项中说明" % eid)
        else:
            rep.block("T18", "%s 没有被任何任务的验收标准覆盖，也没登记进风险章节" % eid, where)
    if edges:
        lost = len([e for e in uncovered if e not in risk_body])
        rate = 100 * (len(edges) - lost) / len(edges)
        rep.info("T19", "边界覆盖率 %.0f%%（%d 条边界，%d 条被任务直接覆盖）"
                 % (rate, len(edges), len(referenced & set(edges))))


def is_na(sec):
    """章节标了「不适用」。后续的内容校验一律跳过——纯后端项目的前端架构本来就该是空的，
    每次都告警一遍，真正的告警就被淹没了。判定与 check_sections 的 S3/S4 保持同一条件。"""
    return bool(sec) and "不适用" in sec["body"][:40]


def has_tree(body):
    """目录结构的三种常见写法：代码围栏、树形字符、带斜杠的路径清单（表格里列路径也算）"""
    if "```" in body or re.search(r"[├└│]", body):
        return True
    return len(re.findall(r"[\w.-]+/[\w.*-]*", body)) >= 3


def check_extras(rep, smap, root, multi):
    stack = smap.get(SEC_STACK)
    if stack and "被否" not in stack["body"] and "否决" not in stack["body"]:
        rep.warn("X1", "技术栈章节缺少「被否方案」，后续容易重复讨论已决问题", loc(stack))
    perf = smap.get(SEC_PERF)
    if perf and not re.search(r"\d", perf["body"]) and "未评估" not in perf["body"]:
        rep.warn("X2", "性能与容量假设里既没有数字也没写「未评估」", loc(perf))
    dec = smap.get(SEC_DEC)
    if dec and not parse_tables(dec["body"]):
        rep.warn("X3", "决策记录是空的，无法追溯代答过程", loc(dec))
    if multi and not os.path.exists(os.path.join(root, "README.md")):
        rep.warn("X4", "缺少 README.md，读者没有入口说明")

    # 架构与接口：这三节缺内容不阻断交付，但派活时 codex 会各自即兴发挥
    arch = smap.get(SEC_ARCH)
    if arch and not is_na(arch):
        miss = []
        if not re.search(r"错误码|错误体系|错误类型", arch["body"]):
            miss.append("错误体系")
        if not re.search(r"环境变量|env\b|process\.env", arch["body"], re.I):
            miss.append("环境变量")
        if miss:
            rep.warn("X10", "架构章节没写全项目共用约定（缺 %s）。这几条前后端必须一致，"
                            "分开写进 07/08 迟早写出两套" % "、".join(miss), loc(arch))

    fe = smap.get(SEC_FE_ARCH)
    if fe and not is_na(fe):
        if not has_tree(fe["body"]):
            rep.warn("X5", "前端架构没给目录结构，每个前端任务会各自定一套目录", loc(fe))
        gaps = [n for n, pat in (("组件库", r"组件库|UI 库|shadcn|antd|element|mui"),
                                 ("状态管理", r"状态管理|全局态|服务端态|store|state"),
                                 ("工具层", r"工具|utils|lib/"))
                if not re.search(pat, fe["body"], re.I)]
        if gaps:
            rep.warn("X11", "前端架构没写 %s，不定死的那几项每个任务会各写一套"
                     % "、".join(gaps), loc(fe))

    be = smap.get(SEC_BE_ARCH)
    if be and not is_na(be):
        if not has_tree(be["body"]):
            rep.warn("X6", "后端架构没给目录结构，每个后端任务会各自定一套目录", loc(be))
        if not re.search(r"分层|层次|调用方向|调用链", be["body"]):
            rep.warn("X7", "后端架构没写分层与调用方向，跨层调用拦不住", loc(be))
        gaps = [n for n, pat in (("数据层", r"数据层|ORM|裸 ?SQL|迁移|repo"),
                                 ("事务边界", r"事务|transaction"))
                if not re.search(pat, be["body"], re.I)]
        if gaps:
            rep.warn("X12", "后端架构没写 %s，落到代码里就是每个任务自己决定在哪开事务、"
                            "在哪拼 SQL" % "、".join(gaps), loc(be))

    api = smap.get(SEC_API)
    if api and not is_na(api):
        if "```" not in api["body"]:
            rep.warn("X8", "接口约定里没有请求/响应示例，字段级契约只能靠猜", loc(api))
        if not re.search(r"错误码|错误代码|error\s*code", api["body"], re.I):
            rep.warn("X9", "接口约定缺少错误码表", loc(api))

    # UI：register 是后面每条 UI 决策的前提，而它判错了不会以任何形式报错——
    # 界面每一项都对，做出来是另一个产品。所以这里只查「判没判」，判得对不对
    # 交给前端架构师审查员。找的是标签词而不是「后台」这种正文里本就会出现的词。
    ui = smap.get(SEC_UI)
    if ui and not is_na(ui):
        if not re.search(r"register|页面类型|设计语言", ui["body"], re.I):
            rep.warn("X13", "UI 章节没写 register 判定（后台/工作台、落地页、商详、H5 是四套"
                            "不同的设计语言）。不判就会按落地页那套做后台，且不会报错", loc(ui))
        if not re.search(r"--[\w-]+\s*:", ui["body"]):
            rep.warn("X14", "UI 章节没给可直接粘的 token（一段 CSS 变量声明）。只给色板和字体，"
                            "按钮多高、圆角几像素每个页面还是会各写一套", loc(ui))


def detect_legacy_layout(sections):
    """认出旧的 22 节结构。指纹是 11 号章节的标题——旧结构里它是边界，新结构里是 UI。

    命中时后面十几条必备章节会全部认领失败，刷出一屏 S1。直接说清该怎么迁移，
    比让人对着「缺少章节 13. 边界问题与异常处理」反推发生了什么有用。
    """
    t11 = next((s["title"] for s in sections if s["num"] == 11), "")
    return "边界" in t11 or "异常" in t11


def extract_module_ids(smap):
    sec = smap.get(SEC_ARCH)
    return set(re.findall(r"\bM\d{1,2}\b", sec["body"])) if sec else set()


# ---------- 主流程 ----------

def review(path):
    rep = Report()
    multi = os.path.isdir(path)
    if multi:
        sections, units = sections_from_dir(path)
        root = path
        if not sections:
            rep.block("S0", "目录下没找到 NN-名称.md 形式的文档文件")
            return rep
    else:
        text = read(path)
        lines = text.split("\n")
        sections = sections_from_text(lines, os.path.basename(path))
        units = [{"file": os.path.basename(path), "lines": lines}]
        root = os.path.dirname(path)

    if detect_legacy_layout(sections):
        rep.block("S6", "这是旧的 22 节结构（11 号还是边界章节）。本版在 02-设计 组里插入了 "
                        "07-前端架构 与 08-后端架构，原 07~22 顺延为 09~24——请先把 06 之后的"
                        "文件整体重编号再跑，否则下面全是「缺少章节」，看不出真正的问题")
        return rep

    smap = map_required(sections)
    check_sections(rep, smap, multi)

    risk = smap.get(SEC_RISK)
    check_placeholders(rep, units, risk.get("file") if risk else None)

    edges = check_edges(rep, smap.get(SEC_EDGES))
    check_tasks(rep, smap.get(SEC_TASKS), extract_module_ids(smap), edges,
                risk["body"] if risk else "")
    check_extras(rep, smap, root, multi)
    return rep


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    if len(args) != 1:
        print(__doc__)
        return 2
    try:
        rep = review(args[0])
    except OSError as e:
        print("读取失败: %s" % e)
        return 2

    if as_json:
        print(json.dumps({"block": rep.count(BLOCK), "warn": rep.count(WARN),
                          "info": rep.count(INFO), "items": rep.items},
                         ensure_ascii=False, indent=2))
        return 1 if rep.count(BLOCK) else 0

    label = {BLOCK: "阻断", WARN: "建议", INFO: "提示"}
    for lv in (BLOCK, WARN, INFO):
        group = [i for i in rep.items if i["level"] == lv]
        if not group:
            continue
        print("\n" + "=" * 64)
        print("%s（%d）" % (label[lv], len(group)))
        print("=" * 64)
        for i in sorted(group, key=lambda x: x["code"]):
            w = "  " + i["where"] if i["where"] else ""
            print("[%s]%s  %s" % (i["code"], w, i["msg"]))

    print("\n" + "-" * 64)
    if rep.count(BLOCK):
        print("未通过：%d 个阻断项必须修复，%d 个建议项" % (rep.count(BLOCK), rep.count(WARN)))
        return 1
    print("通过：无阻断项，%d 个建议项" % rep.count(WARN))
    return 0


if __name__ == "__main__":
    sys.exit(main())
