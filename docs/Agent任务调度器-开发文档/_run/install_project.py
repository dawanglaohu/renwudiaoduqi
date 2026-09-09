#!/usr/bin/env python3
"""把维护工具安装到现有文档的 _run；备份旧文件，不修改源文档或运行构建。
同时把交接手册渲染进项目根的 AGENTS.md 与 CLAUDE.md 的 <!-- handoff:begin -->…<!-- handoff:end --> 之间。"""
import argparse
import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import uuid

from handoff_contract import VERSION, read_json, write_json, write_text

RUNTIME = ('build_docs.py', 'review.py', 'check_stale.py', 'handoff_contract.py',
           'maintain_docs.py', 'compile_prompts.js', 'install_project.py')
TESTS = ('test_maintenance.py', 'test_prompt_routing.py', 'test_release_1_2.py')
MANUAL = 'handoff-manual.md'
HANDOFF_BEGIN, HANDOFF_END = '<!-- handoff:begin -->', '<!-- handoff:end -->'


def manual_source(source):
    """手册模板：装进 _run/ 的副本优先，否则取技能目录的 references/。"""
    for candidate in (source / MANUAL, source.parent / 'references' / MANUAL):
        if candidate.is_file():
            return candidate
    return None


def main_checkout(root):
    """主检出 = git worktree list 的第一行。在工作树里装工具时，手册仍要指向真正的主检出。"""
    listed = subprocess.run(['git', '-C', str(root), 'worktree', 'list', '--porcelain'],
                            capture_output=True, text=True, encoding='utf-8')
    if listed.returncode == 0:
        for line in listed.stdout.splitlines():
            if line.startswith('worktree '):
                return line[len('worktree '):].strip()
    return root.as_posix()


def render_manual(template, root, docs):
    pres = read_json(docs / '_run/presentation.json', {}) or {}
    ho = pres.get('handoff') or {}
    try:
        rel = docs.relative_to(root).as_posix()
    except ValueError:
        rel = docs.as_posix()
    values = {'<repo>': (ho.get('repo') or 'repo').strip(),
              '<docs>': (ho.get('docsPath') or rel).strip(),
              '<主检出>': main_checkout(root)}
    text = template.replace('\r\n', '\n')
    for key, value in values.items():
        text = text.replace(key, value)
    return text.strip() + '\n'


def upsert_handoff(path, block, header):
    if path.exists():
        old = path.read_text(encoding='utf-8-sig')
        if HANDOFF_BEGIN in old and HANDOFF_END in old:
            return re.sub(re.escape(HANDOFF_BEGIN) + r'.*?' + re.escape(HANDOFF_END), lambda _: block, old, flags=re.S)
        return old.rstrip() + '\n\n' + block + '\n'
    return header + '\n\n' + block + '\n'


def install_manual(source, root, docs):
    template = manual_source(source)
    if template is None:
        print('未找到 ' + MANUAL + '，AGENTS.md/CLAUDE.md 的交接手册段未更新')
        return []
    block = HANDOFF_BEGIN + '\n' + render_manual(template.read_text(encoding='utf-8-sig'), root, docs) + HANDOFF_END
    project = (read_json(docs / '_run/presentation.json', {}) or {}).get('project') or docs.name
    touched = []
    for name in ('AGENTS.md', 'CLAUDE.md'):
        target = root / name
        if write_text(target, upsert_handoff(target, block, '# ' + project)):
            touched.append(name)
    return touched


def install(docs, root=None):
    docs = Path(docs).resolve()
    if not docs.is_dir():
        raise ValueError('文档目录不存在')
    project_root = Path(root).resolve() if root else docs.parents[1]
    root = docs
    target = root / '_run'
    target.mkdir(exist_ok=True)
    if not target.resolve().is_relative_to(root):
        raise ValueError('_run 必须位于指定文档目录内')
    source = Path(__file__).resolve().parent
    vault = source / 'build_vault.py'
    if not vault.exists():
        vault = source.parents[1] / 'obsidian-vault/scripts/build_vault.py'
    sources = {name: source / name for name in RUNTIME}
    sources['build_vault.py'] = vault
    manual = manual_source(source)
    if manual is not None:
        sources[MANUAL] = manual
    # 回归测试随工具走：AGENTS.md 要求改生成器前后都跑 <docs>/_run/tests
    tests_dir = source / 'tests' if (source / 'tests').is_dir() else source.parent / 'tests'
    for name in TESTS:
        if (tests_dir / name).is_file():
            sources['tests/' + name] = tests_dir / name
    for name, path in sources.items():
        if not path.is_file():
            raise ValueError('工具包不完整：' + str(path))
        dest = target / name
        if dest.exists() and not dest.resolve().is_relative_to(root):
            raise ValueError('安装目标指向文档目录外：' + str(dest))
    backup = target / 'tool-backups' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
    changed = []
    for name, path in sources.items():
        dest = target / name
        if dest.exists() and dest.read_bytes() == path.read_bytes():
            continue
        if dest.exists():
            (backup / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, backup / name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dest)
        changed.append(name)
    # 指纹按 LF 归一：仓库 eol=lf 检出出来的副本与技能源的 CRLF 文件是同一份工具，不该报漂移
    write_json(target / 'tool-version.json', {'version': VERSION,
      'files': {name: hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest() for name, path in sources.items()}})
    touched = install_manual(source, project_root, docs)
    print('工具已安装：' + str(target))
    print('更新：' + (', '.join(changed) or '无，已是当前版本'))
    print('交接手册：' + project_root.as_posix() + ' 的 ' + (', '.join(touched) + ' 已更新' if touched else 'AGENTS.md/CLAUDE.md 已是当前版本'))
    if backup.exists():
        print('旧工具备份：' + str(backup))
    print('只更新工具文件；接下来 build 建立基线，或按已保存补丁 sync 续做。')
    return changed


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('docs', type=Path)
    parser.add_argument('--root', type=Path, help='项目根（AGENTS.md/CLAUDE.md 落点），默认文档目录上两级')
    args=parser.parse_args()
    try:
        install(args.docs, args.root)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))

if __name__ == '__main__':main()
