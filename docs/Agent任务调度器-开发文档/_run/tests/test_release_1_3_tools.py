"""1.3.x 工具脚本配套的回归：workspace 列出批次收口遗留目录、版本号升到 1.3.1、
脚本与测试不用 Python 3.9+ 才有的写法（项目 _run/tests 在 WSL 用 3.8.10 跑）、
build 子进程超时是 600 秒。"""
import contextlib
import io
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
if (SCRIPTS / 'scripts').is_dir():
    SCRIPTS = SCRIPTS / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import handoff_contract as hc
import build_docs
import maintain_docs as maintenance
from test_maintenance import fixture


def git(base, *args):
    return subprocess.run(['git', '-C', str(base), '-c', 'user.name=t', '-c', 'user.email=t@example.com', *args],
                          check=True, capture_output=True, text=True, encoding='utf-8')


class Release13ToolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-1-3-')
        self.base = Path(self.temp.name) / 'proj'
        self.base.mkdir()
        self.doc = fixture(self.base)
        self.addCleanup(self.temp.cleanup)

    def run_build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.build(self.doc)

    # ---- 批次收口遗留目录 ----
    def test_workspace_lists_batch_leftovers(self):
        git(self.base, 'init')
        git(self.base, 'symbolic-ref', 'HEAD', 'refs/heads/main')
        self.run_build()
        parent = self.base.parent
        (parent / 'regression-batch-1').mkdir()                              # 不在 worktree list → 列出
        (parent / '.codex-plans' / 'regression-batch-1').mkdir(parents=True)  # planning 一律列出
        git(self.base, 'add', '-A'); git(self.base, 'commit', '-q', '-m', 'baseline')
        git(self.base, 'worktree', 'add', '-b', 'batch/2-20260910', str(parent / 'regression-batch-2'), 'HEAD')  # 活 → 不列
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(maintenance.workspace(self.doc, None), 0)
        out = buf.getvalue()
        self.assertIn('rm -rf "' + (parent / 'regression-batch-1').as_posix() + '"', out)
        self.assertIn('rm -rf "' + (parent / '.codex-plans/regression-batch-1').as_posix() + '"', out)
        self.assertIn('batch-worktree', out)
        self.assertIn('batch-planning', out)
        self.assertNotIn('regression-batch-2', out)
        self.assertIn('git worktree prune', out)

    # ---- 版本号 ----
    def test_version_is_1_3_1(self):
        import install_project
        self.assertEqual(hc.VERSION, '1.6.1')
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        self.assertEqual(hc.read_json(self.doc / '_run/tool-version.json')['version'], '1.6.1')

    # ---- build 子进程超时 ----
    def test_build_subprocess_timeout_is_600(self):
        """build_vault 在大项目上要 70 到 120 秒；60 秒会让 verify 与 --landed 每次中途回滚
        （项目 renwudiaoduqi 提交 60b269a 已验证），收进技能后重装才不会冲掉。"""
        source = (SCRIPTS / 'maintain_docs.py').read_text(encoding='utf-8-sig')
        build_src = source[source.index('def build('):source.index('def ', source.index('def build(') + 1)]
        self.assertIn("capture_output=True, timeout=600)", build_src)
        self.assertNotIn('timeout=60)', source)

    # ---- Python 3.8 兼容 ----
    def test_no_python39_only_idioms(self):
        banned = re.compile(r'\.(removesuffix|removeprefix|is_relative_to)\(')
        files = sorted(SCRIPTS.glob('*.py')) + sorted(Path(__file__).resolve().parent.glob('*.py'))
        self.assertTrue(files)
        hits = []
        for path in files:
            for no, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
                if banned.search(line):
                    hits.append(path.name + ':' + str(no) + ': ' + line.strip())
        self.assertEqual(hits, [], '\n'.join(hits))


if __name__ == '__main__':
    unittest.main()
