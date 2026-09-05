#!/usr/bin/env python3
"""把维护工具安装到现有文档的 _run；备份旧文件，不修改源文档或运行构建。"""
import argparse
import hashlib
from datetime import datetime, timezone
from pathlib import Path
import shutil
import uuid

from handoff_contract import VERSION, write_json

RUNTIME = ('build_docs.py', 'review.py', 'check_stale.py', 'handoff_contract.py',
           'maintain_docs.py', 'compile_prompts.js', 'install_project.py')


def install(docs):
    root = Path(docs).resolve()
    if not root.is_dir():
        raise ValueError('文档目录不存在')
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
            backup.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, backup / name)
        shutil.copy2(path, dest)
        changed.append(name)
    write_json(target / 'tool-version.json', {'version': VERSION,
      'files': {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in sources.items()}})
    print('工具已安装：' + str(target))
    print('更新：' + (', '.join(changed) or '无，已是当前版本'))
    if backup.exists():
        print('旧工具备份：' + str(backup))
    print('只更新工具文件；接下来 build 建立基线，或按已保存补丁 sync 续做。')
    return changed


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('docs', type=Path)
    args=parser.parse_args()
    try:
        install(args.docs)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))

if __name__ == '__main__':main()
