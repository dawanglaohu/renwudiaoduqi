#!/usr/bin/env python3
"""收尾只提示过期产物；真正的派发门槛由契约版本与维护状态执行。"""
from pathlib import Path
import sys
from handoff_contract import runtime_drift, stale_reasons


def stale_docs(directory):
    return stale_reasons(directory)


def workspace_report(root):
    """maintain_docs.workspace 的只读版：只数已落地任务遗留的目录，不打印命令。"""
    import contextlib
    import io
    try:
        import maintain_docs
    except ImportError:
        return 0
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            maintain_docs.workspace(Path(root).resolve(), None)
    except Exception:
        return 0
    return buf.getvalue().count('    rm -rf ')


def main():
    for root in Path('docs').glob('*/'):
        if not (root / '_run').is_dir():
            continue
        reasons = stale_reasons(root)
        drift = runtime_drift(root)
        prefix = 'python "' + (root / '_run/maintain_docs.py').as_posix() + '" "' + root.as_posix() + '"'
        if reasons:
            print('[文档维护] ' + str(root) + '：' + '；'.join(reasons[:4]))
            print('  当前审查有补丁：' + prefix + ' sync --patch <补丁ID>')
            print('  初次构建/恢复产物：' + prefix + ' build；不重跑需求或设计流程。')
        for line in drift:
            print('[生成器] ' + str(root) + '：' + line)
        leftovers = workspace_report(root)
        if leftovers:
            print('[工作区] ' + str(root) + '：已落地任务遗留 ' + str(leftovers) + ' 个目录；' + prefix + ' workspace 列出删除命令')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('[文档维护] 无法检查版本：' + str(exc), file=sys.stderr)
    sys.exit(0)
