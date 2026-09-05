#!/usr/bin/env python3
"""收尾只提示过期产物；真正的派发门槛由契约版本与维护状态执行。"""
from pathlib import Path
import sys
from handoff_contract import stale_reasons


def stale_docs(directory):
    return stale_reasons(directory)


def main():
    for root in Path('docs').glob('*/'):
        if not (root / '_run').is_dir():
            continue
        reasons = stale_reasons(root)
        if not reasons:
            continue
        print('[文档维护] ' + str(root) + '：' + '；'.join(reasons[:4]))
        prefix = 'python "' + (root / '_run/maintain_docs.py').as_posix() + '" "' + root.as_posix() + '"'
        print('  当前审查有补丁：' + prefix + ' sync --patch <补丁ID>')
        print('  初次构建/恢复产物：' + prefix + ' build；不重跑需求或设计流程。')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('[文档维护] 无法检查版本：' + str(exc), file=sys.stderr)
    sys.exit(0)
