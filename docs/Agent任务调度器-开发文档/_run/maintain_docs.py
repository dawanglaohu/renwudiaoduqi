#!/usr/bin/env python3
"""文档交付后维护：保存补丁基线、局部同步、逐任务复核、继续原 PR。
本脚本不写需求/架构正文，不提交 Git，不自动声称完成语义或代码审查。
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import build_docs
import review
from handoff_contract import (analyze, compiler_hash, digest, input_hashes, legacy_hashes, manifest,
                              readiness, read_json, rehash_contracts, runtime_drift, source_version,
                              stale_reasons, write_json, write_text)


def now():
    return datetime.now(timezone.utc).isoformat()


def git_info(root):
    info = {}
    for key, cmd in [('branch', ['branch', '--show-current']), ('head', ['rev-parse', 'HEAD'])]:
        result = subprocess.run(['git', '-C', str(root), *cmd], capture_output=True, text=True, encoding='utf-8')
        info[key] = result.stdout.strip() if result.returncode == 0 else None
    return info


def state(root):
    _, sections = build_docs.collect(str(root))
    data = build_docs.extract(sections)
    pres = read_json(root / '_run/presentation.json', {})
    checked = analyze(root, data['tasks'], pres, data['edges'])
    return data, checked


def patch_path(root, patch_id):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', patch_id or ''):
        raise ValueError('补丁 ID 仅允许字母、数字、点、下划线和短横线，最多 80 字符')
    return root / '_run/patches' / (patch_id + '.json')


def check_branch(root, patch):
    branch = git_info(root)['branch']
    if patch.get('branch') and branch != patch['branch']:
        raise ValueError('请返回原补丁分支 ' + patch['branch'] + '；当前为 ' + str(branch))


def marker(root):
    pending = set()
    for p in (root / '_run/patches').glob('*.json'):
        record = read_json(p, {})
        if record.get('status') in ('prepared', 'syncing', 'failed'):
            pending.update(record.get('affected', [record.get('task')]))
    build_state = read_json(root / '_run/build-state.json', {})
    if build_state.get('status') == 'building':
        pending.update(build_state.get('tasks', []))
    needs = read_json(root / '_run/revalidation.json', {})
    value = {'pendingTasks': sorted(t for t in pending if t), 'needsReview': sorted(needs)}
    write_text(root / '_run/maintenance.js', 'window.MAINTENANCE = ' + json.dumps(value, ensure_ascii=False) + ';\n')


def evidence_template(root, analysis, ids, name='evidence-template.json'):
    template = {'scope': 'task-contract', 'tasks': {
        tid: {'contractHash': analysis['contracts'][tid]['hash'], 'verdict': 'pending', 'evidence': []}
        for tid in ids if tid in analysis['contracts']}}
    path = root / '_run' / name
    write_json(path, template)
    return str(path)


def migrate_reviews(root, analysis):
    """1.1.x 的复核记录把当时的生成器指纹算进契约哈希。语义上下文没变的记录按新公式改写哈希，
    沿用原证据；哪怕一个字段变了都不动，留给正常复核。只在 build 内做，之外改记录仍算产物过期。"""
    old_compiler = (read_json(root / '_run/build-manifest.json', {}) or {}).get('compiler')
    records = read_json(root / '_run/task-reviews.json', {}) or {}
    if not old_compiler or not records:
        return []
    legacy = legacy_hashes(analysis, old_compiler)
    moved = []
    for tid, record in records.items():
        current = (analysis['contracts'].get(tid) or {}).get('hash')
        if current and record.get('contractHash') != current and record.get('contractHash') == legacy.get(tid):
            record['migratedFrom'] = record['contractHash']
            record['contractHash'] = current
            record.setdefault('compiler', old_compiler)
            moved.append(tid)
    if moved:
        write_json(root / '_run/task-reviews.json', records)
        print('复核记录已按新契约公式迁移（语义上下文未变，沿用原证据）：' + ', '.join(sorted(moved)))
    return moved


def build(root, selected=None):
    expected = source_version(root)
    _, analysis = state(root)
    migrate_reviews(root, analysis)
    write_json(root / '_run/build-state.json', {'status': 'building', 'sourceVersion': expected,
               'tasks': sorted(selected or analysis['contracts'])})
    marker(root)
    report = review.review(str(root))
    write_json(root / '_run/review.json', {'sourceVersion': source_version(root),
        'block': report.count(review.BLOCK), 'warn': report.count(review.WARN),
        'info': report.count(review.INFO), 'items': report.items})
    commands = [[sys.executable, '-B', str(Path(__file__).with_name('build_docs.py')), str(root)]]
    vault = root / '_run/build_vault.py'
    if not vault.exists():
        vault = Path(__file__).resolve().parents[2] / 'obsidian-vault/scripts/build_vault.py'
    if not vault.exists():
        raise ValueError('缺少 build_vault.py；请从配套 obsidian-vault 技能复制到文档 _run/')
    cmd = [sys.executable, '-B', str(vault), str(root)]
    if selected:
        cmd += ['--tasks', ','.join(sorted(selected))]
    commands.append(cmd)
    for cmd in commands:
        result = subprocess.run(cmd, text=True, encoding='utf-8', capture_output=True, timeout=60)
        if result.returncode:
            raise ValueError('同步失败：' + result.stdout + '\n' + result.stderr)
        print(result.stdout.strip())
    if source_version(root) != expected:
        raise ValueError('同步过程中源被另一个修改更新；保留补丁并重新 sync，不能签发混合版本')
    write_json(root / '_run/build-state.json', {'status': 'complete', 'sourceVersion': expected})
    marker(root)
    products = ['index.html', 'docs-data.js', '_run/dispatch.json', '_run/review.json', '_run/task-reviews.json', '_MOC.md']
    write_json(root / '_run/build-manifest.json', manifest(root, products))
    for line in runtime_drift(root):
        print('[生成器] ' + line)
    return report


def source_contents(root):
    return {name: (root / name).read_text(encoding='utf-8-sig') for name in input_hashes(root)}


def begin(root, args):
    path = patch_path(root, args.patch)
    old = read_json(path)
    if old:
        check_branch(root, old)
        if old.get('task') != args.task or old.get('pr') != args.pr:
            raise ValueError('补丁 ID 已被另一个任务或 PR 使用')
        print('沿用已存在补丁，状态：' + old['status'])
        return 0
    data, current = state(root)
    if args.task not in current['contracts']:
        raise ValueError('未知任务 ' + args.task)
    # 不替用户改正文；先留当前版本，使后续 diff 可恢复并追溯。
    record = {'id': args.patch, 'task': args.task, 'pr': args.pr, **git_info(root),
              'reason': args.reason, 'created': now(), 'status': 'prepared',
              'baseline': current, 'sourceInputs': input_hashes(root), 'sourceContents': source_contents(root),
              'affected': [args.task], 'verifiedTasks': []}
    write_json(path, record)
    marker(root)
    print('补丁基线已保存：' + str(path))
    print('现在在原分支修正对应源条款和任务配置，然后运行 sync --patch ' + args.patch)
    return 0


def changed_fields(old, new):
    """两份契约上下文逐字段比对；sections 再细到文件，报「哪个共享章节变了」而不只是「sections 变了」。"""
    old_ctx = (old or {}).get('context') or {}
    new_ctx = (new or {}).get('context') or {}
    fields = []
    for key in sorted(set(old_ctx) | set(new_ctx)):
        if key == 'compiler':
            continue
        if old_ctx.get(key) == new_ctx.get(key):
            continue
        if key == 'sections':
            a, b = old_ctx.get(key) or {}, new_ctx.get(key) or {}
            files = sorted(name for name in set(a) | set(b) if a.get(name) != b.get(name))
            fields.append('sections:' + ','.join(files))
        else:
            fields.append(key)
    if (old or {}).get('hash') != (new or {}).get('hash') and not fields:
        fields.append('providers')
    return fields


def describe_fields(fields):
    if not fields:
        return '上游契约变化'
    if len(fields) == 1 and fields[0].startswith('sections:'):
        return '仅共享章节 ' + fields[0][len('sections:'):].replace(',', '、') + ' 变化'
    names = {'providers': '前置任务契约变化', 'task': '19 节任务行', 'edges': '13 节边界行', 'effectivePaths': '有效范围',
             'definition': 'task-contracts.json 条目', 'architecture': '架构约定', 'design': '视觉方向',
             'handoff': 'handoff 配置', 'skills': '点名技能'}
    return '、'.join('共享章节 ' + f[len('sections:'):].replace(',', '、') if f.startswith('sections:') else names.get(f, f)
                    for f in fields)


def sync(root, args):
    path = patch_path(root, args.patch)
    record = read_json(path)
    if not record:
        raise ValueError('补丁不存在；改源之前先 begin 保存基线')
    check_branch(root, record)
    _, current = state(root)
    # 基线若是旧版生成器保存的，先按当前公式重算哈希，生成器升级本身不算契约变化。
    before = rehash_contracts(record['baseline']['contracts'])
    after = current['contracts']
    affected = sorted(tid for tid in set(before) | set(after)
                      if before.get(tid, {}).get('hash') != after.get(tid, {}).get('hash'))
    # 当前任务始终保留续接记录；依赖供应者改变会由契约哈希传播到消费者。
    affected = sorted(set(affected) | {record['task']})
    # 已完成的同版本同步可复用；不要重复让已落地成果回到待复验。
    if (record.get('sourceVersion') == current['sourceVersion']
            and record.get('status') in ('synced', 'verified') and not stale_reasons(root)):
        print('该补丁已同步到当前版本，继续原 PR，无需重复构建。')
        return 0
    record.update(status='syncing', affected=affected, sourceVersion=current['sourceVersion'])
    current_contents = source_contents(root)
    prior_contents = record.get('sourceContents', {})
    record['sourceChanges'] = {name: {'before': prior_contents.get(name), 'after': current_contents.get(name)}
        for name in sorted(set(prior_contents) | set(current_contents))
        if prior_contents.get(name) != current_contents.get(name)}
    record['changes'] = {tid: {'before': before.get(tid), 'after': after.get(tid)} for tid in affected}
    write_json(path, record)
    marker(root)
    needs = read_json(root / '_run/revalidation.json', {})
    progress = build_docs.progress_state(str(root))
    flagged = {}
    for tid in affected:
        if tid in after and progress.get(tid) in ('done', 'doing', 'review'):
            fields = changed_fields(before.get(tid), after.get(tid))
            entry = needs.get(tid) or {}
            history = list(entry.get('patches') or [])
            if 'patch' in entry and 'patches' not in entry:
                # 1.1.x 只记最后一个补丁；迁成历史第一条，不丢。
                history.append({'patch': entry['patch'], 'sourceVersion': None, 'changedFields': []})
            history.append({'patch': args.patch, 'sourceVersion': current['sourceVersion'], 'changedFields': fields})
            needs[tid] = {'contractHash': after[tid]['hash'], 'patches': history,
                          'previousStatus': entry.get('previousStatus', progress[tid])}
            if progress[tid] == 'done':
                flagged[tid] = fields
    write_json(root / '_run/revalidation.json', needs)
    try:
        report = build(root, set(affected) & set(after))
    except Exception as exc:
        record.update(status='failed', error=str(exc))
        write_json(path, record)
        marker(root)
        raise
    record.update(status='synced', synced=now())
    record.pop('error', None)
    write_json(path, record)
    marker(root)
    dispatch = read_json(root / '_run/dispatch.json', {}).get('tasks', {})
    lines = ['# 文档补丁 ' + args.patch, '', '任务：' + record['task'],
             '原分支：' + str(record.get('branch')), '原 PR：' + str(record.get('pr')),
             '依据：' + record['reason'], '', '## 差异与复验范围', '']
    for tid in affected:
        old = before.get(tid, {}).get('context', {})
        new = after.get(tid, {}).get('context', {})
        fields = sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))
        lines.append('- ' + tid + '：' + ('、'.join(fields) if fields else '上游契约变化或本次审查目标'))
    for name, change in record.get('sourceChanges', {}).items():
        delta = '\n'.join(difflib.unified_diff((change['before'] or '').splitlines(),
                         (change['after'] or '').splitlines(), fromfile='before/' + name, tofile='after/' + name, lineterm=''))
        lines += ['', '### ' + name, '', '````diff', delta, '````']
    lines += ['', '新旧任务契约在同名 JSON 的 changes、源条款在 sourceChanges。只复验变化及其影响，不重新初始化分支。', '',
              '## 原任务续做', '', dispatch.get(record['task'], {}).get('resume', '任务已移除，保留 PR 历史并裁定收尾。')]
    write_text(path.with_suffix('.md'), '\n'.join(lines) + '\n')
    template = evidence_template(root, current, affected, 'patches/' + args.patch + '.evidence.json')
    print('已同步，待真实复核：' + ', '.join(affected))
    print('证据模板：' + template)
    print('原 PR：' + str(record.get('pr')) + '；不重新派发整任务。')
    if flagged:
        print('已落地任务被标为待复验（交接台显示「已落地·待复验」，不锁下游）：')
        for tid, fields in sorted(flagged.items()):
            print('  ' + tid + '：' + describe_fields(fields))
        print('  复验：交接台点该行「审查」得到复验提示词；核对后 verify --task <ID> --evidence <JSON>，'
              '再 python "' + (root / '_run/build_docs.py').as_posix() + '" "' + root.as_posix() + '" --landed <ID> 清除标记。')
    # 旧项目的无关契约缺口不阻止当前补丁提交，但不能把该任务错误当作通过。
    target_blocks = [i for i in report.items if i['level'] == 'BLOCK' and
                     (not i.get('taskIds') or record['task'] in i.get('taskIds', []))]
    return 1 if target_blocks else 0


def verify(root, args):
    _, checked = state(root)
    if args.task not in checked['contracts']:
        raise ValueError('未知任务 ' + args.task)
    report = review.review(str(root))
    blockers = [i for i in report.items if i['level'] == 'BLOCK' and
                (not i.get('taskIds') or args.task in i.get('taskIds', []))]
    if blockers:
        raise ValueError('该任务尚有阻断：' + '; '.join(i['msg'] for i in blockers))
    submitted = read_json(Path(args.evidence), {})
    item = (submitted.get('tasks') or {}).get(args.task, {})
    if submitted.get('scope') != 'task-contract' or item.get('contractHash') != checked['contracts'][args.task]['hash']:
        raise ValueError('证据的范围或任务契约版本不匹配；先读取 status 的当前版本')
    evidence = item.get('evidence')
    if (item.get('verdict') != 'pass' or not isinstance(evidence, list) or not evidence
            or not all(isinstance(x, str) and x.strip() and x.strip().lower() not in ('todo', 'none', 'pending') for x in evidence)):
        raise ValueError('须由审查方填写 pass 和非空真实证据；模板不代表通过')
    # 全部前置验证完成后才写复核记录，错误参数不得留下半份通过。
    record, path = None, None
    if args.patch:
        path = patch_path(root, args.patch)
        record = read_json(path)
        if not record or record['status'] not in ('synced', 'verified'):
            raise ValueError('先完成该补丁 sync，再登记复核')
        check_branch(root, record)
        if record.get('sourceVersion') != checked['sourceVersion']:
            raise ValueError('补丁之后源又变了；先 sync 当前版本')
        record['verifiedTasks'] = sorted(set(record.get('verifiedTasks', [])) | {args.task})
        if record['task'] in record['verifiedTasks']:
            record['status'] = 'verified'
    records = read_json(root / '_run/task-reviews.json', {})
    old_records = dict(records)
    records[args.task] = {**item, 'scope': 'task-contract', 'reviewed': now(), 'compiler': compiler_hash()}
    write_json(root / '_run/task-reviews.json', records)
    # 文档契约复核不冒充代码通过；revalidation 由代码验收后的 --landed 消除。
    try:
        build(root, {args.task})
    except Exception:
        write_json(root / '_run/task-reviews.json', old_records)
        raise
    if record:
        write_json(path, record)
    marker(root)
    print('任务契约已复核。继续原 PR 的代码验收、回填、commit/push 与落地。')
    return 0


def status(root, args):
    data, checked = state(root)
    report = review.review(str(root))
    checks = readiness(root, checked, report.items)
    if args.task and args.task not in checks:
        raise ValueError('未知任务 ' + args.task)
    ids = [args.task] if args.task else sorted(checks)
    result = {'sourceVersion': checked['sourceVersion'], 'stale': stale_reasons(root),
              'runtimeDrift': runtime_drift(root),
              'tasks': {tid: checks[tid] for tid in ids}}
    if args.task:
        result['evidenceTemplate'] = evidence_template(root, checked, ids, args.task + '.evidence-template.json')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    for line in result['runtimeDrift']:
        print('[生成器] ' + line, file=sys.stderr)
    return 0 if all(checks[t]['ready'] for t in ids) and not result['stale'] and not result['runtimeDrift'] else 1


def workspace(root, args):
    """已落地任务遗留的工作树 ../<repo>-<id> 与 planning ../.codex-plans/<repo>-<id>/：
    只列出并给删除命令，不自动删；活的工作树（git worktree list 里有）不碰。"""
    pres = read_json(root / '_run/presentation.json', {}) or {}
    repo = ((pres.get('handoff') or {}).get('repo') or '').strip()
    if not repo:
        raise ValueError('presentation.json 的 handoff.repo 未设置，无法推断工作树命名')
    progress = build_docs.progress_state(str(root))
    landed = {tid for tid, st in progress.items() if st == 'done'}
    project = project_root(root)
    parent = project.parent
    listed = subprocess.run(['git', '-C', str(project), 'worktree', 'list', '--porcelain'],
                            capture_output=True, text=True, encoding='utf-8')
    active = set()
    for line in (listed.stdout if listed.returncode == 0 else '').splitlines():
        if line.startswith('worktree '):
            active.add(path_key(line[len('worktree '):].strip()))
    leftovers = []
    slug_of = {tid.lower(): tid for tid in landed}
    for d in sorted(parent.glob(repo + '-*')):
        tid = slug_of.get(d.name[len(repo) + 1:].lower())
        if tid and d.is_dir() and path_key(d) not in active and path_key(d) != path_key(project):
            leftovers.append(('worktree', tid, d))
    plans = parent / '.codex-plans'
    if plans.is_dir():
        for d in sorted(plans.glob(repo + '-*')):
            tid = slug_of.get(d.name[len(repo) + 1:].lower())
            if tid and d.is_dir():
                leftovers.append(('planning', tid, d))
    if not leftovers:
        print('没有已落地任务遗留的工作树或 planning 目录（仓库同级 ' + repo + '-*、.codex-plans/' + repo + '-*）。')
        return 0
    print('已落地任务遗留的目录（不在 git worktree list 里；核对后手动执行，脚本不删）：')
    for kind, tid, d in leftovers:
        print('  ' + tid + '　' + kind + '　' + d.as_posix())
        print('    rm -rf "' + d.as_posix() + '"')
    print('Windows 侧不要跑 git worktree prune；WSL 建的活工作树在这里显示 prunable。')
    return 0


def path_key(p):
    """比较用的路径键：WSL 在 git worktree list 里留下的 /mnt/d/x 与 Windows 的 D:/x 是同一个目录。"""
    s = str(p).replace('\\', '/')
    m = re.match(r'^/mnt/([a-zA-Z])/(.*)$', s)
    if m:
        s = m.group(1).upper() + ':/' + m.group(2)
    try:
        s = Path(s).resolve().as_posix()
    except OSError:
        pass
    return s.rstrip('/').lower()


def project_root(root):
    """文档目录所在的项目根：优先 git 顶层，退回文档目录上两级。"""
    top = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'],
                         capture_output=True, text=True, encoding='utf-8')
    if top.returncode == 0 and top.stdout.strip():
        return Path(top.stdout.strip()).resolve()
    return Path(root).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('docs', type=Path)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('build', help='只构建与检查已有源，不运行需求/设计流程')
    p = sub.add_parser('begin')
    p.add_argument('--task', required=True); p.add_argument('--patch', required=True)
    p.add_argument('--pr'); p.add_argument('--reason', required=True)
    p = sub.add_parser('sync'); p.add_argument('--patch', required=True)
    p = sub.add_parser('verify'); p.add_argument('--task', required=True)
    p.add_argument('--evidence', required=True); p.add_argument('--patch')
    p = sub.add_parser('status'); p.add_argument('--task')
    sub.add_parser('workspace', help='列出已落地任务遗留的工作树与 planning 目录，只打印删除命令不执行')
    args = parser.parse_args()
    root = args.docs.resolve()
    if not root.is_dir():
        parser.error('文档目录不存在')
    try:
        if args.command == 'build':
            report = build(root)
            return 1 if report.count(review.BLOCK) else 0
        return globals()[args.command](root, args)
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print('维护未完成：' + str(exc), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
