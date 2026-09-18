#!/usr/bin/env python3
"""任务契约、范围、版本与原子写入。仅用标准库，不对自由文本作语义通过承诺。"""
import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

VERSION = '1.4.0'
SCHEMA_VERSION = 1
TASK_RE = re.compile(r'M\d{1,2}-T\d{1,3}')
# handoff.wiring 与任务 wiring 共用的类别。
WIRING_KEYS = ('backendRoutes', 'container', 'frontendRoutes', 'buildPipeline', 'sharedTypes',
               'eventKinds', 'migrations', 'jobs', 'shellBridge')
# H12 的关键词表：任务标题/产出/验收命中即「疑似接线任务」，大小写不敏感
WIRING_HINT_RE = re.compile(r'路由|接口|端点|/api/|页面|挂到|挂进|路由表|service|服务|job|后台任务|事件|kind|迁移|migration|壳|bridge', re.I)
SOURCE_EXCLUDES = {'_run', '图谱', '.obsidian'}
COMPILERS = ('handoff_contract.py', 'build_docs.py', 'compile_prompts.js', 'review.py', 'maintain_docs.py')


def read_json(path, default=None):
    p = Path(path)
    return json.loads(p.read_text(encoding='utf-8-sig')) if p.exists() else default


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def write_text(path, text):
    """内容不变则不碰 mtime；同目录临时文件 + replace，避免读到半份 JSON。"""
    p = Path(path)
    if p.exists() and p.read_text(encoding='utf-8-sig') == text:
        return False
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.' + p.name + '-', dir=str(p.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(text)
            f.flush()
        os.replace(tmp, p)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return True


def write_json(path, value):
    return write_text(path, json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n')


def input_hashes(root):
    root = Path(root)
    result = {}
    for p in sorted(root.rglob('*.md')):
        rel = p.relative_to(root)
        if any(part in SOURCE_EXCLUDES or part.startswith('.') for part in rel.parts[:-1]):
            continue
        if p.name == '_MOC.md':
            continue
        result[rel.as_posix()] = digest(p.read_text(encoding='utf-8-sig'))
    for name in ('presentation.json', 'task-contracts.json'):
        p = root / '_run' / name
        if p.exists():
            result['_run/' + name] = digest(read_json(p))
    return result


def compiler_hash():
    """生成器指纹只进 source_version / manifest / stale_reasons，提醒重跑 build；
    不进任务契约哈希——否则改一行生成器就让全部复核记录失配，逐任务重新 verify。"""
    here = Path(__file__).parent
    sources = {name: (here / name).read_text(encoding='utf-8-sig')
               for name in COMPILERS if (here / name).exists()}
    vault = here / 'build_vault.py'
    if not vault.exists():
        vault = here.parents[1] / 'obsidian-vault/scripts/build_vault.py'
    if vault.exists():
        sources['build_vault.py'] = vault.read_text(encoding='utf-8-sig')
    return digest(sources)


def source_version(root):
    return digest({'inputs': input_hashes(root), 'compiler': compiler_hash()})


def source_file(root, section):
    matches = sorted(p for p in Path(root).rglob('*.md')
                     if re.match(r'^' + str(section).zfill(2) + r'[-_.]', p.name)
                     and not any(part in SOURCE_EXCLUDES for part in p.relative_to(root).parts[:-1]))
    return matches


def ancestors(task_id, tasks):
    found, todo = set(), list(tasks.get(task_id, {}).get('deps', []))
    while todo:
        dep = todo.pop()
        if dep in found:
            continue
        found.add(dep)
        todo.extend(tasks.get(dep, {}).get('deps', []))
    return found - {task_id}


def path_valid(path):
    return (isinstance(path, str) and bool(path) and path == path.strip()
            and '\\' not in path and not path.startswith('/')
            and not re.match(r'^[A-Za-z]:', path)
            and not any(part in ('.', '..', '') for part in path.rstrip('/').split('/'))
            and not any(ch in path for ch in '*?[]{}'))


def under(path, scope):
    return path == scope or path.startswith(scope.rstrip('/') + '/')


def wiring_registry(ho):
    """handoff.wiring 归一成 {类别: [路径]}。未知类别由 analyze 报 H14；取值类型不对直接拒绝。"""
    raw = ho.get('wiring', {})
    if not isinstance(raw, dict):
        raise ValueError('handoff.wiring 必须是对象（类别 → 路径或路径数组）')
    registry = {}
    for key, value in raw.items():
        values = value if isinstance(value, list) else [value]
        if not all(isinstance(v, str) for v in values):
            raise ValueError('handoff.wiring.' + str(key) + ' 必须是路径或路径数组')
        registry[str(key)] = list(dict.fromkeys(values))
    return registry


def endpoint_paths(endpoints):
    """10 节接口总表的路径集合：去掉围住路径的反引号与空白，只收以 / 开头的。"""
    out = []
    for e in endpoints or []:
        path = (e.get('path') if isinstance(e, dict) else e) or ''
        path = str(path).strip().strip('`').strip()
        if path.startswith('/') and path not in out:
            out.append(path)
    return out


def mentions(text, path):
    """文本里出现了这条端点路径（后面不接路径字符，/api/x 不算提到 /api/x/y）。"""
    return re.search(r'(?<![A-Za-z0-9_/.:{}%~\-])' + re.escape(path)
                     + r'(?![A-Za-z0-9_/.:{}%~\-])', text or '') is not None


def analyze(root, tasks, pres, edges=None, endpoints=None):
    """可确定的关系作阻断；缺少结构化约束不编造通过，交逐任务语义复核。
    H12（疑似接线任务未列注册点）与 H13（消费端点但提供方不在前置）是 WARN，不锁派发；
    H14（wiring 未知类别）阻断。endpoints 是 10 节接口总表，缺省时不做 H13。"""
    root = Path(root)
    by_id = {t['id']: t for t in tasks}
    if not isinstance(pres, dict):
        raise ValueError('presentation.json 必须是对象')
    ho = pres.get('handoff') or {}
    if not isinstance(ho, dict):
        raise ValueError('handoff 必须是对象')
    if not isinstance(ho.get('taskPaths', {}), dict):
        raise ValueError('handoff.taskPaths 必须是任务 ID 到路径数组的对象')
    config = read_json(root / '_run/task-contracts.json', {})
    if not isinstance(config, dict) or config.get('schemaVersion', 1) != SCHEMA_VERSION:
        raise ValueError('task-contracts.json schemaVersion 必须为 1')
    definitions = config.get('tasks') or {}
    if not isinstance(definitions, dict):
        raise ValueError('task-contracts.json tasks 必须是对象')
    edge_map = {e['id']: e for e in (edges or [])}
    issues, contexts, paths, owners = [], {}, {}, {}
    section_cache = {}
    registry = wiring_registry(ho)
    api_paths = endpoint_paths(endpoints)

    def issue(code, text, ids, level='BLOCK'):
        issues.append({'level': level, 'code': code, 'msg': text,
                       'where': ', '.join(ids), 'taskIds': ids})

    for tid in sorted(set(definitions) - set(by_id)):
        issue('H01', '契约引用了不存在的任务 ' + tid, [tid])
    for key in sorted(set(registry) - set(WIRING_KEYS)):
        issue('H14', 'wiring 未知类别 ' + key + '（handoff.wiring 只允许 ' + '/'.join(WIRING_KEYS) + '）', [])
    registry_files = []
    for key in sorted(registry):
        for p in registry[key]:
            if not path_valid(p):
                issue('H03', 'handoff.wiring.' + key + ' 范围须为无通配符的仓库相对路径：' + str(p), [])
            elif key in WIRING_KEYS and p not in registry_files:
                registry_files.append(p)
    # 优先采用明确产出端点的任务；没有产出提供方时才从验收列回退识别。
    providers_of = {}
    for path in api_paths:
        providers_of[path] = ([t['id'] for t in tasks if mentions(t.get('output', ''), path)]
                              or [t['id'] for t in tasks if mentions(t.get('accept', ''), path)])
    for tid, spec in definitions.items():
        if not isinstance(spec, dict):
            raise ValueError(tid + ' 契约必须是对象')
        for key in ('provides', 'requires', 'supportPaths', 'outputPaths', 'sections', 'wiring'):
            if key in spec and not isinstance(spec[key], list):
                raise ValueError(tid + ' ' + key + ' 必须是数组')
        if not all(isinstance(c, str) for c in spec.get('wiring', [])):
            raise ValueError(tid + ' wiring 必须是类别字符串数组')
        if spec.get('stage') not in (None, 'primitive', 'integration'):
            raise ValueError(tid + ' stage 只允许 primitive/integration')
        if 'integrationTask' in spec and not isinstance(spec['integrationTask'], str):
            raise ValueError(tid + ' integrationTask 必须是任务 ID')
        for cap in spec.get('provides', []):
            if not isinstance(cap, str):
                raise ValueError(tid + ' provides 必须是字符串数组')
            owners.setdefault(cap, []).append(tid)
    for cap, ids in owners.items():
        if len(ids) > 1:
            issue('H02', '能力 ' + cap + ' 有多个提供方；必须指定唯一归属', ids)
    for t in tasks:
        tid, module = t['id'], t.get('module', '')
        spec = definitions.get(tid, {})
        declared = (ho.get('taskPaths') or {}).get(tid, [])
        support = spec.get('supportPaths', [])
        if not isinstance(declared, list) or not isinstance(support, list):
            raise ValueError(tid + ' taskPaths/supportPaths 必须是数组')
        effective = []
        for p in declared + support:
            if not path_valid(p):
                issue('H03', tid + ' 范围须为无通配符的仓库相对路径：' + str(p), [tid])
            elif p not in effective:
                effective.append(p)
        # 任务声明的接线类别：对应注册点并入有效范围（来源 wiring），并进契约 context
        wired = {}
        for cat in spec.get('wiring', []):
            if cat not in WIRING_KEYS:
                issue('H14', tid + ' wiring 未知类别 ' + cat + '（只允许 ' + '/'.join(WIRING_KEYS) + '）', [tid])
            elif not registry.get(cat):
                issue('H14', tid + ' wiring 类别 ' + cat + ' 未在 handoff.wiring 登记非空路径', [tid])
            else:
                wired[cat] = list(registry[cat])
                for p in registry[cat]:
                    if path_valid(p) and p not in effective:
                        effective.append(p)
        paths[tid] = sorted(effective)
        if not effective:
            issue('H04', tid + ' 未声明有效改动路径', [tid])
        closure = ancestors(tid, by_id)
        if registry_files and not spec.get('wiring'):
            hint_text = ' '.join((t.get('title', ''), t.get('output', ''), t.get('accept', '')))
            hits = sorted(set(m.group(0).lower() for m in WIRING_HINT_RE.finditer(hint_text)))
            if hits and not any(under(w, s) for w in registry_files for s in effective):
                issue('H12', tid + ' 疑似接线任务未列注册点（命中：' + '、'.join(hits) + '）', [tid], 'WARN')
        if api_paths:
            use_text = ' '.join((t.get('title', ''), t.get('input', ''), t.get('output', ''), t.get('accept', '')))
            for path in api_paths:
                if not mentions(use_text, path) or tid in providers_of[path]:
                    continue
                providers = providers_of[path]
                if providers and not any(p in closure for p in providers):
                    issue('H13', tid + ' 消费端点 ' + path + ' 但提供方 ' + providers[0] + ' 不在前置', [tid], 'WARN')
        # 输入列是已声明的供给；产出/验收提到的未来消费者不自动变成依赖。
        required = [{'task': x} for x in sorted(set(TASK_RE.findall(t.get('input', ''))) - {tid})]
        required += spec.get('requires', [])
        for req in required:
            if isinstance(req, str):
                req = {'task': req}
            if not isinstance(req, dict):
                raise ValueError(tid + ' requires 只接受任务 ID 或 task/capability 对象')
            provider = req.get('task')
            cap = req.get('capability')
            if not provider and cap and len(owners.get(cap, [])) == 1:
                provider = owners[cap][0]
            if provider != tid and (provider not in by_id or provider not in closure):
                issue('H05', tid + ' 缺少能力前置 ' + str(provider or cap), [tid])
            if cap and provider not in owners.get(cap, []):
                issue('H06', tid + ' 的能力 ' + cap + ' 未由 ' + str(provider) + ' 提供', [tid])
        if not all(isinstance(p, str) for p in spec.get('outputPaths', [])):
            raise ValueError(tid + ' outputPaths 必须为字符串数组')
        outputs = list(spec.get('outputPaths', []))
        # 只提取完整路径，绝不靠模块编号猜目录。
        outputs += re.findall(r'`((?:packages/|\.github/)[^`\s]+)`', t.get('output', ''))
        for p in sorted(set(outputs)):
            if not path_valid(p):
                issue('H07', tid + ' 产出路径非法：' + p, [tid])
            elif not p.endswith('/') and not any(under(p, s) for s in effective):
                issue('H08', tid + ' 产出文件未包含在有效范围：' + p, [tid])
            elif p in spec.get('outputPaths', []) and not any(under(p, s) for s in effective):
                issue('H08', tid + ' 结构化产出路径未包含在有效范围：' + p, [tid])
        integration = spec.get('integrationTask')
        if spec.get('stage') == 'primitive' and not integration:
            issue('H09', tid + ' 原语阶段必须指定后续集成验收任务', [tid])
        if integration and (integration not in by_id or tid not in ancestors(integration, by_id)):
            issue('H10', tid + ' 集成任务不存在或没有依赖该原语：' + integration, [tid])
        fe = module in ho.get('frontendModules', [])
        sections = spec.get('sections', [1, 2, 5, 6, 7 if fe else 8, 9, 10, 14, 15, 16, 17, 18] + ([11, 12] if fe else []))
        section_sources = {}
        for num in sections:
            if not isinstance(num, int) or num in (13, 19) or not 1 <= num <= 24:
                issue('H11', tid + ' sections 使用具体章节号，13/19 由任务/边界行自动引用', [tid])
                continue
            if num not in section_cache:
                section_cache[num] = {p.relative_to(root).as_posix(): digest(p.read_text(encoding='utf-8-sig'))
                                      for p in source_file(root, num)}
            section_sources.update(section_cache[num])
        architecture = ho.get('architecture') or {}
        if isinstance(architecture, dict):
            architecture = {k: architecture[k] for k in ('shared', 'frontend' if fe else 'backend') if k in architecture}
        contexts[tid] = {'task': t, 'effectivePaths': paths[tid], 'definition': spec,
                         'edges': [edge_map[e] for e in t.get('edges', []) if e in edge_map],
                         'sections': section_sources,
                         'architecture': architecture, 'design': ho.get('design') if fe else None,
                         'module': module, 'project': pres.get('project'),
                         'handoff': {k: ho.get(k) for k in ('stack', 'docsPath', 'repo', 'branchPrefix', 'mainBranch', 'conventions')},
                         'skills': (ho.get('taskSkills') or {}).get(tid)}
        # 不给旧任务增加空 wiring 键，保留原有契约哈希。
        if wired:
            contexts[tid]['wiring'] = wired
    bases = {k: digest(v) for k, v in contexts.items()}
    contracts = {}
    for tid, context in contexts.items():
        # 把供应者契约纳入消费者版本，局部修改沿真实依赖传播。
        supplied = {dep: bases[dep] for dep in sorted(ancestors(tid, by_id)) if dep in bases}
        contracts[tid] = {'hash': digest({'context': context, 'providers': supplied}),
                          'effectivePaths': paths[tid], 'context': context}
    return {'version': VERSION, 'schemaVersion': SCHEMA_VERSION, 'sourceVersion': source_version(root),
            'contracts': contracts, 'issues': issues, 'effectivePaths': paths}


def readiness(root, analysis, structural=None):
    records = read_json(Path(root) / '_run/task-reviews.json', {})
    checks = {}
    for tid, contract in analysis['contracts'].items():
        errors = [i['msg'] for i in analysis['issues'] if i['level'] == 'BLOCK'
                  and (not i.get('taskIds') or tid in i['taskIds'])]
        errors += [i['msg'] for i in (structural or []) if i['level'] == 'BLOCK'
                   and (not i.get('taskIds') or tid in i['taskIds']) and i['msg'] not in errors]
        # WARN（H12/H13）只进 reasons 提醒审查方，不进 blockers、不锁派发
        warnings = [i['msg'] for i in analysis['issues'] if tid in i.get('taskIds', []) and i['level'] == 'WARN']
        record = records.get(tid, {})
        verified = (record.get('contractHash') == contract['hash'] and record.get('verdict') == 'pass'
                    and bool(record.get('evidence')))
        # blockers 只收明确的契约错误；语义复核待办不在其中，由审查阶段登记，不锁派发。
        checks[tid] = {'ready': verified and not errors, 'contractHash': contract['hash'],
                       'blockers': list(errors),
                       'reasons': (list(errors) or ([] if verified else ['任务契约待语义复核；可在当前审查内完成，无需重跑生成流程'])) + warnings}
    return checks


def rehash_contracts(contracts):
    """按当前公式重算一组契约的哈希：去掉 1.1.x 塞进上下文的 compiler 字段，再沿真实依赖传播。
    补丁基线是升级前保存的时，用它归一，避免把全部任务误判成受影响。"""
    contexts = {tid: {k: v for k, v in (c.get('context') or {}).items() if k != 'compiler'}
                for tid, c in (contracts or {}).items()}
    tasks = {tid: ctx.get('task') or {} for tid, ctx in contexts.items()}
    bases = {tid: digest(ctx) for tid, ctx in contexts.items()}
    result = {}
    for tid, ctx in contexts.items():
        supplied = {dep: bases[dep] for dep in sorted(ancestors(tid, tasks)) if dep in bases}
        result[tid] = {**contracts[tid], 'hash': digest({'context': ctx, 'providers': supplied}), 'context': ctx}
    return result


def legacy_hashes(analysis, compiler):
    """1.1.x 的契约哈希把当时的生成器指纹算进每个任务上下文；给定那个指纹就能重算，
    用来证明旧复核记录对应的语义上下文没变，沿用原证据而不是逐任务重新 verify。"""
    contexts = {tid: {**c['context'], 'compiler': compiler} for tid, c in analysis['contracts'].items()}
    tasks = {tid: c['context']['task'] for tid, c in analysis['contracts'].items()}
    bases = {tid: digest(ctx) for tid, ctx in contexts.items()}
    return {tid: digest({'context': ctx, 'providers': {dep: bases[dep] for dep in sorted(ancestors(tid, tasks)) if dep in bases}})
            for tid, ctx in contexts.items()}


def file_digest(path):
    """生成器文件的指纹按 LF 归一：仓库 eol=lf 检出与技能源 CRLF 副本是同一份工具。"""
    raw = Path(path).read_bytes()
    return hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest(), hashlib.sha256(raw).hexdigest()


def runtime_drift(root):
    """生成器在项目 _run/ 里的两种漂移，各给一条原因：
    (a) 与 tool-version.json 登记的指纹不一致——本地补丁没登记，重装技能会覆盖；
    (b) 在 git 仓库内且有未提交改动——不当场提交就会随下一次检出/合并丢失。
    只报告，不阻断；调用方决定退出码。"""
    run = Path(root) / '_run'
    names = list(COMPILERS) + ['build_vault.py']
    reasons = []
    recorded = (read_json(run / 'tool-version.json', {}) or {}).get('files') or {}
    for name in names:
        p = run / name
        if not p.exists() or name not in recorded:
            continue
        if recorded[name] not in file_digest(p):
            reasons.append('生成器与 tool-version.json 不一致：' + name + '；本地补丁未登记，重装技能会覆盖')
    inside = subprocess.run(['git', '-C', str(run), 'rev-parse', '--is-inside-work-tree'],
                            capture_output=True, text=True, encoding='utf-8')
    if inside.returncode == 0 and inside.stdout.strip() == 'true':
        has_head = subprocess.run(['git', '-C', str(run), 'rev-parse', '--verify', '-q', 'HEAD'],
                                  capture_output=True, text=True, encoding='utf-8').returncode == 0
        for name in names:
            if not (run / name).exists():
                continue
            tracked = subprocess.run(['git', '-C', str(run), 'ls-files', '--error-unmatch', '--', name],
                                     capture_output=True, text=True, encoding='utf-8').returncode == 0
            if not tracked:
                dirty = True
            elif not has_head:
                dirty = True
            else:
                dirty = subprocess.run(['git', '-C', str(run), 'diff', '--quiet', 'HEAD', '--', name],
                                       capture_output=True, text=True, encoding='utf-8').returncode != 0
            if dirty:
                reasons.append('生成器有未提交改动：' + name + ('（未跟踪）' if not tracked else '')
                               + '；当场提交进主干，否则会随下一次检出/合并丢失')
    return reasons


def manifest(root, products):
    root = Path(root)
    return {'schemaVersion': SCHEMA_VERSION, 'sourceVersion': source_version(root),
            'inputs': input_hashes(root), 'compiler': compiler_hash(),
            'products': {name: digest((root / name).read_text(encoding='utf-8-sig'))
                         for name in products if (root / name).exists()}}


def stale_reasons(root):
    root = Path(root)
    m = read_json(root / '_run/build-manifest.json', {})
    if not m:
        return ['缺少构建清单；用 maintain_docs.py build 建立版本基线']
    reasons = []
    now = input_hashes(root)
    for name in sorted(set(now) | set(m.get('inputs', {}))):
        if now.get(name) != m.get('inputs', {}).get(name):
            reasons.append('源已变更或删除：' + name)
    if m.get('compiler') != compiler_hash():
        reasons.append('生成器版本已变更')
    for name in ('index.html', 'docs-data.js', '_run/dispatch.json', '_MOC.md'):
        if not (root / name).exists():
            reasons.append('产物缺失：' + name)
    for name, expected in m.get('products', {}).items():
        if not (root / name).exists() or digest((root / name).read_text(encoding='utf-8-sig')) != expected:
            reasons.append('产物与构建清单不符：' + name)
    return sorted(set(reasons))
