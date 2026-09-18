#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""分阶段运行器：文档生成分 S1–S6 六个阶段，一阶段一个会话。

只做三件事：判每个阶段的关卡（只读，不改任何文档）、把通过的阶段记进 _run/stage.json、
打印下一阶段的启动提示词。提示词模板内嵌在本文件里，装进项目 _run/ 之后不依赖技能目录。

用法:
    python stage.py <文档目录>                报告六阶段状态、下一阶段还缺什么，并打印下一阶段提示词
    python stage.py <文档目录> --done S<n>    先跑 S<n> 的关卡：过了才写 stage.json 并打印下一阶段提示词；
                                            不过就列出缺什么，退出码 1，stage.json 不动
    python stage.py <文档目录> --prompt S<n>  只打印 S<n> 的启动提示词

<文档目录> 不存在时只允许 --prompt S1。

退出码: 0 通过或已打印；1 关卡未过；2 用法错误。
stage.json: {"schemaVersion": 1, "stages": {"S1": {"done": "<ISO>", "sourceVersion": "<指纹>"}}, "next": "S2"}
"""
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

SCHEMA_VERSION = 1
STAGES = ('S1', 'S2', 'S3', 'S4', 'S5', 'S6')
TITLES = {'S1': '需求裁决', 'S2': '架构与契约', 'S3': 'UI/UX', 'S4': '质量与运维',
          'S5': '任务拆分与契约', 'S6': '审查、编排、知识库、交付'}
# 每个阶段拥有的章节号。review.py 报在这些章节上的缺章节/空节/不适用无理由/放错目录/占位符才算本阶段的事；
# 报在别的章节上的（多半是还没写的后面章节）在本阶段属正常，忽略。
OWNED = {'S1': (1, 2, 3, 4, 5), 'S2': (6, 7, 8, 9, 10), 'S3': (11, 12),
         'S4': (13, 14, 15, 16, 17, 18), 'S5': (19, 20, 21, 22, 23, 24), 'S6': ()}
COMMON_CODES = ('S1', 'S2', 'S3', 'S5', 'P1')
# 各阶段额外要清零的 review 代码（review.py 里多数只是 WARN，在拥有它的阶段升为关卡）
STAGE_CODES = {'S1': ('X1',),
               'S2': ('X5', 'X6', 'X7', 'X8', 'X9', 'X10', 'X11', 'X12', 'X15'),
               'S3': ('X13', 'X14'),
               'S4': ('X2', 'X16', 'X18', 'E1', 'E2', 'E3', 'E5'),
               'S5': (), 'S6': ()}
SHARED_KEYS = ('errors', 'env', 'types', 'naming')
DESIGN_KEYS = ('register', 'dials', 'tokens', 'components')
from handoff_contract import WIRING_KEYS, path_valid, wiring_registry
MIN_BYTES = 200
HANDOFF_BEGIN = '<!-- handoff:begin -->'
EDGE_LINE = re.compile(r'^\s*\|?\s*(E-\d{1,3})\b')
USER_WORDS = '<在此粘贴用户原话>'
# 11 节不得出现的字样（目视确认 / 真页 / 真屏）：方向由代理用户裁决，S3 不设让用户回来看图的闸门。
# 写成 \u 转义是为了让本文件在任何终端编码下都能原样匹配。
FORBIDDEN_11 = ('\u76ee\u89c6\u786e\u8ba4', '\u771f\u9875', '\u771f\u5c4f')
PREVIEW_DIR = '_preview'

# ---------- 提示词模板：占位符 <docs> / <skill> / <root> 由 render_prompt 填 ----------

LINE2 = '技能不可用时：读技能目录 SKILL.md 与 references/stages.md 的 {s} 段照做。'
LINE3 = ('本会话只做 {s}：开工先 `python "<docs>/_run/stage.py" "<docs>"`，'
         '做完 `python "<docs>/_run/stage.py" "<docs>" --done {s}`，然后停止会话。')

PROMPTS = {
    'S1': '\n'.join([
        '/unattended-run S1 <docs>',
        LINE2.format(s='S1'),
        '本会话只做 S1：开工先建目录并安装工具 `python "<skill>/scripts/install_project.py" "<docs>" --root "<root>"`'
        '（装完 `<docs>/_run/stage.py` 才存在），再 `python "<docs>/_run/stage.py" "<docs>"` 看报告；'
        '做完 `python "<docs>/_run/stage.py" "<docs>" --done S1`，然后停止会话。',
        '只读输入：下面这段用户原话。逐字固化进 `_run/context.md`，一个字不改。',
        '产出：`_run/context.md`、`_run/candidates.md`、`_run/decisions.md`、`_run/edges.md`、01–05 节；'
        '不写 06 节之后的任何文件，不提前切模块。',
        '原始需求：',
        USER_WORDS,
    ]),
    'S2': '\n'.join([
        '/unattended-run S2 <docs>',
        LINE2.format(s='S2'),
        LINE3.format(s='S2'),
        '只读输入：`_run/context.md`、`_run/decisions.md`、01/02/05 节全文、03/04 节的标题行；'
        '引用其中的取值一律打开文件读，不凭记忆复述。',
        '产出：06–10 节；`_run/presentation.json` 的 `handoff.architecture`（`shared` 四键 errors/env/types/naming 齐，'
        '07/08 非「不适用」时 `frontend`/`backend` 非空）与 `handoff.wiring`（接线注册表，至少一键）；'
        '架构师交回的 OPEN_CHOICES / CONFLICTS 经代理用户裁决后追加进 `decisions.md`、`edges.md`。',
        '不写 11 节之后的任何文件，不拆任务。',
    ]),
    'S3': '\n'.join([
        '/unattended-run S3 <docs>',
        LINE2.format(s='S3'),
        LINE3.format(s='S3'),
        '只读输入：`_run/context.md`（观感相关的原话逐字取）、`_run/decisions.md`、01 节、06 节模块表、07 节、'
        '10 节接口总表、`_run/edges.md`。',
        '产出：11–12 节；`handoff.design`（register/dials/tokens/components 四键齐）与 `handoff.frontendModules`。'
        '无界面项目：11/12 节写「不适用 + 一句理由」后直接 `--done S3`。',
        '本阶段禁止生成任何 HTML/页面文件：不建 `_preview/`、不做变体、不写 PRODUCT.md；'
        '11 节不得出现「目视确认」「真页」「真屏」——方向由代理用户裁决，不设让用户回来看图的闸门。',
        '不写 13 节之后的任何文件。',
    ]),
    'S4': '\n'.join([
        '/unattended-run S4 <docs>',
        LINE2.format(s='S4'),
        LINE3.format(s='S4'),
        '只读输入：`_run/edges.md`、`_run/decisions.md`、04/05 节全文、06 节模块表、09 节实体与状态机、'
        '10 节接口总表与错误码表、07/08 节的目录树小节。',
        '产出：13–18 节。13 节的 E-XX 与 `edges.md` 一一对应（编号照抄不重排）；15 节要么有数字要么写「未评估」；'
        '17 节含端到端冒烟；18 节含「分发形态」小节。',
        '不写 19 节之后的任何文件。',
    ]),
    'S5': '\n'.join([
        '/unattended-run S5 <docs>',
        LINE2.format(s='S5'),
        LINE3.format(s='S5'),
        '只读输入：06/09/10/13 节与 `_run/edges.md` 全文；07/08/11/12 节只读目录树与页面清单小节，不读正文；'
        '`_run/decisions.md`（22 节照抄，低置信行进 21 节）。',
        '产出：19–24 节；`handoff.taskPaths`（每个任务都有）、`taskSkills`（按需）、`_run/task-contracts.json`；'
        '`python "<docs>/_run/review.py" "<docs>"` 跑到 0 阻断（含 X17：验收标准不许写占位/桩/待接入；'
        'H12/H13 是提醒，逐条核对谁接线、提供方是否在前置）。',
        '不跑 build、不建知识库、不写审查记录。',
    ]),
    'S6': '\n'.join([
        '/unattended-run S6 <docs>',
        LINE2.format(s='S6'),
        LINE3.format(s='S6'),
        '只读输入：`_run/decisions.md`、19 节任务表、`_run/review.json`（build 之后）；'
        '三位审查员按 references/review-process.md 各读自己的范围。',
        '产出：审查记录（`_run/review-log.md`、逐任务 `verify` 的 `task-reviews.json`）、`presentation.json` 的 blocks 编排、'
        '`maintain_docs.py build` 的阅读器与派发包、知识库（`图谱/`、`_MOC.md`）、`README.md`、'
        '`install_project.py --root` 渲染进项目根 AGENTS.md/CLAUDE.md 的 handoff 段。',
        '`--done S6` 通过后按 SKILL.md 第 9 步交付；交付里「怎么开工」之前先报六阶段全 done。',
    ]),
}


# ---------- 小工具 ----------

def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_pres(docs):
    from handoff_contract import read_json
    pres = read_json(Path(docs) / '_run/presentation.json', {})
    return pres if isinstance(pres, dict) else {}


def handoff(pres):
    ho = pres.get('handoff')
    return ho if isinstance(ho, dict) else {}


def section_path(docs, num):
    from handoff_contract import source_file
    found = source_file(str(docs), num)
    return found[0] if found else None


def section_body(docs, num):
    p = section_path(docs, num)
    return p.read_text(encoding='utf-8-sig').strip() if p else None


def is_na(body):
    """与 review.py 的 S3/S4 同一条件：开头 40 字内出现「不适用」。"""
    return bool(body) and '不适用' in body[:40]


def rel(docs, path):
    try:
        return Path(path).relative_to(docs).as_posix()
    except ValueError:
        return Path(path).as_posix()


def table_rows(text):
    """markdown 表格的数据行（去掉分隔行）；`\\|` 不算分列。"""
    rows = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s.startswith('|'):
            continue
        cells = [c.strip() for c in s.replace('\\|', '\x00').strip('|').split('|')]
        if all(re.fullmatch(r':?-{2,}:?', c) for c in cells if c):
            continue
        rows.append([c.replace('\x00', '|') for c in cells])
    return rows


def edge_ids(text):
    """首列（或行首）是 E-XX 的行，按出现顺序。"""
    return [m.group(1) for m in (EDGE_LINE.match(ln) for ln in text.splitlines()) if m]


def edge_num(eid):
    return int(eid.split('-')[1])


def task_ids(docs):
    import build_docs
    _, by_num = build_docs.collect(str(docs))
    return [t['id'] for t in build_docs.extract(by_num)['tasks']]


def project_root(docs):
    from maintain_docs import project_root as _root
    return _root(Path(docs))


def review_items(docs):
    import review
    return review.review(str(docs)).items


def item_section(item):
    m = re.search(r'章节 (\d{1,2})\.', item.get('msg') or '')
    if m:
        return int(m.group(1))
    m = re.search(r'(?:^|/)(\d{1,2})[-_.][^/]*\.md', item.get('where') or '')
    return int(m.group(1)) if m else None


def fmt_item(item):
    where = item.get('where')
    return '[%s] %s%s' % (item.get('code'), where + '  ' if where else '', item.get('msg'))


def review_failures(items, stage):
    owned, codes = OWNED[stage], COMMON_CODES + STAGE_CODES[stage]
    out = []
    for it in items:
        code = it.get('code')
        if code in ('S0', 'S6'):
            out.append(fmt_item(it))
        elif code in codes and item_section(it) in owned:
            out.append(fmt_item(it))
    return out


# ---------- 关卡：全部只读 ----------

def gate_s1(docs, items):
    problems = []
    run = docs / '_run'
    for name in ('context.md', 'candidates.md', 'decisions.md', 'edges.md'):
        p = run / name
        if not p.is_file():
            problems.append('缺 _run/' + name)
        elif name == 'context.md' and p.stat().st_size <= MIN_BYTES:
            problems.append('_run/context.md 只有 %d 字节（要 > %d）：原话要逐字固化，不是一句摘要'
                            % (p.stat().st_size, MIN_BYTES))
    for name in ('stage.py', 'maintain_docs.py', 'tool-version.json'):
        if not (run / name).is_file():
            problems.append('缺 _run/' + name + '：先跑 install_project.py <docs> --root <项目根> 安装工具')
    for num in OWNED['S1']:
        p = section_path(docs, num)
        if p is not None and p.stat().st_size <= MIN_BYTES:
            problems.append('%s 只有 %d 字节（要 > %d）' % (rel(docs, p), p.stat().st_size, MIN_BYTES))
    problems += review_failures(items, 'S1')
    dec = run / 'decisions.md'
    if dec.is_file():
        rows = table_rows(dec.read_text(encoding='utf-8-sig'))
        data = [r for r in rows if r and re.fullmatch(r'\d{1,3}', r[0])]
        if not data:
            problems.append('_run/decisions.md 没有序号开头的决策行（8 列：# | 问题 | 评审 | 选定 | 理由 | 边界编号 | 隐含假设 | 置信）')
        bad = [r[0] for r in data if len(r) != 8]
        if bad:
            problems.append('_run/decisions.md 有 %d 行不是 8 列（单元格里的竖线写成 \\|）：# %s'
                            % (len(bad), '、'.join(bad[:10]) + ('…' if len(bad) > 10 else '')))
    edg = run / 'edges.md'
    if edg.is_file():
        ids = edge_ids(edg.read_text(encoding='utf-8-sig'))
        if not ids:
            problems.append('_run/edges.md 没有首列为 E-XX 的表格行')
        else:
            nums = [edge_num(i) for i in ids]
            if len(set(nums)) != len(nums):
                problems.append('_run/edges.md 编号重复：' + '、'.join(sorted({i for i in ids if ids.count(i) > 1})))
            if sorted(set(nums)) != list(range(1, len(set(nums)) + 1)):
                problems.append('_run/edges.md 编号不是从 E-01 连续：共 %d 条，最大 E-%02d' % (len(set(nums)), max(nums)))
    return problems


def gate_s2(docs, items):
    problems = review_failures(items, 'S2')
    ho = handoff(load_pres(docs))
    arch = ho.get('architecture')
    arch = arch if isinstance(arch, dict) else {}
    shared = arch.get('shared')
    if not isinstance(shared, dict):
        problems.append('presentation.json 缺 handoff.architecture.shared（对象，四键 errors/env/types/naming）')
    else:
        miss = [k for k in SHARED_KEYS if not shared.get(k)]
        if miss:
            problems.append('handoff.architecture.shared 缺 ' + '/'.join(miss))
    for num, key in ((7, 'frontend'), (8, 'backend')):
        body = section_body(docs, num)
        if body is not None and not is_na(body) and not arch.get(key):
            problems.append('%02d 节不是「不适用」，但 handoff.architecture.%s 为空：这类任务的提示词不会带目录与分层约束'
                            % (num, key))
    wiring = ho.get('wiring')
    if not (isinstance(wiring, dict) and any(v for v in wiring.values())):
        problems.append('presentation.json 缺 handoff.wiring（接线注册表，至少一键：' + '/'.join(WIRING_KEYS) + '）')
    else:
        try:
            registry = wiring_registry(ho)
            for key, paths in registry.items():
                if key not in WIRING_KEYS:
                    problems.append('[H14] wiring 未知类别 ' + key)
                for path in paths:
                    if not path_valid(path):
                        problems.append('[H03] handoff.wiring.' + key + ' 范围须为无通配符的仓库相对路径：' + path)
        except ValueError as exc:
            problems.append(str(exc))
    return problems


def gate_s3(docs, items):
    problems = review_failures(items, 'S3')
    body = section_body(docs, 11)
    if body is not None and not is_na(body):
        ho = handoff(load_pres(docs))
        design = ho.get('design')
        if not isinstance(design, dict):
            problems.append('presentation.json 缺 handoff.design（对象，四键 register/dials/tokens/components）')
        else:
            miss = [k for k in DESIGN_KEYS if not design.get(k)]
            if miss:
                problems.append('handoff.design 缺 ' + '/'.join(miss))
        if not ho.get('frontendModules'):
            problems.append('handoff.frontendModules 为空：design 不会发给任何任务')
    if body:
        for word in FORBIDDEN_11:
            if word in body:
                problems.append('11 节出现「%s」：方向由代理用户裁决，不设目视确认闸门（doc-structure.md 的 S3 专节）' % word)
    for base in preview_roots(docs):
        if (base / PREVIEW_DIR).exists():
            problems.append('存在 %s：S3 只出取值不出预览页，删掉它' % (base / PREVIEW_DIR).as_posix())
    return problems


def preview_roots(docs):
    """要查 _preview/ 的两个位置：文档目录与项目根（同一目录只算一次）。"""
    roots = [Path(docs).resolve()]
    try:
        root = project_root(docs)
    except (OSError, ValueError):
        root = None
    if root and root not in roots:
        roots.append(root)
    return roots


def gate_s4(docs, items):
    problems = review_failures(items, 'S4')
    body13 = section_body(docs, 13)
    edges_file = docs / '_run/edges.md'
    if body13 is not None and edges_file.is_file():
        doc_ids = set(edge_ids(body13))
        run_ids = set(edge_ids(edges_file.read_text(encoding='utf-8-sig')))
        if doc_ids != run_ids:
            only_doc = sorted(doc_ids - run_ids, key=edge_num)
            only_run = sorted(run_ids - doc_ids, key=edge_num)
            bits = []
            if only_doc:
                bits.append('只在 13 节：' + '、'.join(only_doc[:10]) + ('…' if len(only_doc) > 10 else ''))
            if only_run:
                bits.append('只在 edges.md：' + '、'.join(only_run[:10]) + ('…' if len(only_run) > 10 else ''))
            problems.append('13 节的 E-XX（%d 条）与 _run/edges.md（%d 条）不一致；%s'
                            % (len(doc_ids), len(run_ids), '；'.join(bits)))
    # X18 与 review.py 共用分发形态判定，避免两套关键词互相冲突。
    return problems


def gate_s5(docs, items):
    problems = [fmt_item(it) for it in items if it.get('level') == 'BLOCK']
    counts = {code: sum(it.get('code') == code and it.get('level') == 'WARN' for it in items)
              for code in ('H12', 'H13')}
    print('接线提示（不阻断）：H12 %d 条，H13 %d 条；review.py 查看明细' % (counts['H12'], counts['H13']))
    tasks = task_ids(docs)
    tp = handoff(load_pres(docs)).get('taskPaths')
    if not isinstance(tp, dict):
        problems.append('presentation.json 缺 handoff.taskPaths（任务 ID → 路径数组）')
    else:
        missing = [t for t in tasks if not tp.get(t)]
        if missing:
            problems.append('handoff.taskPaths 缺任务：' + '、'.join(missing[:12])
                            + ('…共 %d 个' % len(missing) if len(missing) > 12 else ''))
    return problems


def gate_s6(docs, items):
    from handoff_contract import read_json, source_version, stale_reasons
    problems = []
    manifest = read_json(docs / '_run/build-manifest.json', {}) or {}
    if not manifest:
        problems.append('缺 _run/build-manifest.json：先跑 python "<docs>/_run/maintain_docs.py" "<docs>" build'
                        .replace('<docs>', docs.as_posix()))
    else:
        if manifest.get('sourceVersion') != source_version(docs):
            problems.append('_run/build-manifest.json 的 sourceVersion 不是当前源：改过文档或配置后没重跑 build')
        problems += ['产物过期：' + r for r in stale_reasons(docs) if r.startswith('产物')]
    tasks = task_ids(docs)
    notes_dir = docs / '图谱' / '任务'
    notes = sorted(p for p in notes_dir.glob('*.md')) if notes_dir.is_dir() else []
    if len(notes) != len(tasks):
        problems.append('图谱/任务/ 有 %d 篇，19 节任务 %d 个：重跑 build（含 build_vault.py）' % (len(notes), len(tasks)))
    root = project_root(docs)
    agents = root / 'AGENTS.md'
    if not agents.is_file() or HANDOFF_BEGIN not in agents.read_text(encoding='utf-8-sig'):
        problems.append('项目根 %s 的 AGENTS.md 没有 handoff 标记段：跑 install_project.py "%s" --root "%s"'
                        % (root.as_posix(), docs.as_posix(), root.as_posix()))
    return problems


GATES = {'S1': gate_s1, 'S2': gate_s2, 'S3': gate_s3, 'S4': gate_s4, 'S5': gate_s5, 'S6': gate_s6}


def gate(docs, stage):
    docs = Path(docs)
    try:
        items = review_items(docs) if stage != 'S6' else []
        return GATES[stage](docs, items)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        return ['关卡无法执行：' + str(exc)]


# ---------- 状态与提示词 ----------

def next_stage(state):
    for s in STAGES:
        if s not in state['stages']:
            return s
    return 'done'


def load_state(docs):
    from handoff_contract import read_json
    state = read_json(Path(docs) / '_run/stage.json', None)
    if not isinstance(state, dict) or not isinstance(state.get('stages'), dict):
        state = {'schemaVersion': SCHEMA_VERSION, 'stages': {}}
    state.setdefault('schemaVersion', SCHEMA_VERSION)
    state['next'] = next_stage(state)
    return state


def render_prompt(stage, docs):
    docs = Path(docs)
    text = PROMPTS[stage].replace('<docs>', docs.resolve().as_posix())
    if stage == 'S1':
        skill = HERE.parent if (HERE.parent / 'SKILL.md').is_file() else None
        text = text.replace('<skill>', skill.as_posix() if skill else '<技能目录>')
        root = '<项目根>'
        if docs.is_dir():
            try:
                root = project_root(docs).as_posix()
            except (OSError, ValueError):
                pass
        text = text.replace('<root>', root)
    return text


def print_prompt(stage, docs, lead):
    print()
    print(lead)
    print('-' * 40)
    print(render_prompt(stage, docs))


def report(docs):
    from handoff_contract import source_version
    state = load_state(docs)
    current = source_version(docs)
    print('文档生成阶段：' + docs.as_posix())
    changed = []
    for s in STAGES:
        rec = state['stages'].get(s)
        if rec:
            drift = rec.get('sourceVersion') != current
            if drift:
                changed.append(s)
            print('  %s %s：done %s%s' % (s, TITLES[s], rec.get('done', ''), '（该阶段之后源已变化）' if drift else ''))
        else:
            print('  %s %s：pending%s' % (s, TITLES[s], '  ← 下一步' if s == state['next'] else ''))
    if changed:
        print('提示：%s 之后源已变化；如改了它们的产出，请对该阶段重新 --done（已记录的状态不撤销）。' % '、'.join(changed))
    if state['next'] == 'done':
        print('六阶段全部完成；交付时在「怎么开工」之前报这一行。')
        return 0
    problems = gate(docs, state['next'])
    if problems:
        print('关卡 %s 现在还缺（%d 项）：' % (state['next'], len(problems)))
        for p in problems:
            print('  - ' + p)
    else:
        print('关卡 %s 已满足，可直接 --done %s。' % (state['next'], state['next']))
    print_prompt(state['next'], docs, '下一阶段提示词（原样发给新会话）：')
    return 0


def done(docs, stage):
    from handoff_contract import source_version, write_json
    state = load_state(docs)
    earlier = [s for s in STAGES[:STAGES.index(stage)] if s not in state['stages']]
    if earlier:
        print('%s 之前还有阶段没有 --done：%s；先完成它们（stage.json 未改）。' % (stage, '、'.join(earlier)))
        return 1
    problems = gate(docs, stage)
    if problems:
        print('%s 关卡未过（%d 项），stage.json 未改：' % (stage, len(problems)))
        for p in problems:
            print('  - ' + p)
        return 1
    state['stages'][stage] = {'done': now_iso(), 'sourceVersion': source_version(docs)}
    state['next'] = next_stage(state)
    write_json(docs / '_run/stage.json', state)
    print('%s 关卡通过，已记入 _run/stage.json；下一阶段：%s' % (stage, state['next']))
    if state['next'] == 'done':
        print('六阶段全部完成。按 SKILL.md 第 9 步交付；交付里「怎么开工」之前先报这一行。')
    else:
        print_prompt(state['next'], docs, '下一阶段提示词（原样报给用户，然后结束本会话）：')
    return 0


def main(argv=None):
    try:
        sys.stdout.reconfigure(errors='replace')
    except (AttributeError, ValueError):
        pass
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0].startswith('-'):
        print(__doc__)
        return 2
    docs, rest = Path(args[0]), args[1:]
    mode, stage = 'report', None
    if len(rest) == 2 and rest[0] in ('--done', '--prompt'):
        mode, stage = rest[0][2:], rest[1].upper()
    elif rest:
        print(__doc__)
        return 2
    if stage is not None and stage not in STAGES:
        print('阶段只能是 S1–S6：' + rest[1])
        return 2
    if not docs.is_dir():
        if mode == 'prompt' and stage == 'S1':
            print(render_prompt('S1', docs))
            return 0
        print('文档目录不存在：%s（不存在的目录只允许 --prompt S1）' % docs)
        return 2
    docs = docs.resolve()
    if mode == 'prompt':
        print(render_prompt(stage, docs))
        return 0
    if mode == 'done':
        return done(docs, stage)
    return report(docs)


if __name__ == '__main__':
    sys.exit(main())
