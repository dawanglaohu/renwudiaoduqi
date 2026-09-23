"""1.6.1 回归：测试步骤补齐（实施跑测试、审查复跑、缺命令统一、收口 skipped 闸门），不接 Jev。"""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_release_1_3 as release13
import test_prompt_routing as routing

import build_docs
import handoff_contract as hc
import install_project

NEEDLE = 'TESTS 记 skipped 并写明原因、NOT_FIXED 记一条 doc-issue，不猜命令'


class TestStepPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def compiled(self):
        result = self.browser(routing.payload_for('M1-T1'))
        return result['tasks']['M1-T1']['compiled'], result

    def test_implementation_runs_tests_before_pr_and_reports_tests_line(self):
        compiled, _ = self.compiled()
        impl = compiled['implementation']
        self.assertIn('然后跑测试', impl)
        self.assertIn('dsh-pre-push-checks', impl)
        self.assertIn('TESTS: <pass | fail | skipped>', impl)
        self.assertIn('不猜命令', impl)
        self.assertLess(impl.index('然后跑测试'), impl.index('3. 提交、推送、开 PR'))

    def test_review_reruns_tests_in_step_one_and_formats_tests_lines(self):
        compiled, _ = self.compiled()
        review = compiled['review']
        self.assertIn('在该分支上复跑测试与 lint', review)
        self.assertLess(review.index('复跑测试与 lint'), review.index('反造假扫描'))
        self.assertLess(review.index('复跑测试与 lint'), review.index('## 输出格式'))
        self.assertIn('\nTESTS\n- pass | fail | skipped', review)
        self.assertIn('\nTS_CHECK\n', review)
        self.assertIn('第 1 步已跑过的测试不重复跑', review)
        self.assertNotIn('按本层改动挑最小充分测试集跑一遍；红了回头', review)

    def test_missing_test_command_is_handled_the_same_everywhere(self):
        compiled, result = self.compiled()
        self.assertIn(NEEDLE, compiled['bug'])
        self.assertIn(NEEDLE, result['pure0'])
        self.assertNotIn('没写就记进 NOT_FIXED', compiled['bug'])
        self.assertIn('\nTESTS\n- pass | fail | skipped', compiled['bug'])
        self.assertLess(compiled['bug'].index('\nTESTS\n'), compiled['bug'].index('\nBUGS\n'))
        # 全项目查 bug 不在浏览器夹具里：核编译器源码，三处缺命令写法一致、旧写法不存在
        core = build_docs.prompt_compiler_core({}, {})
        self.assertEqual(core.count(NEEDLE), 3)
        self.assertNotIn('命令在 17-测试策略）。红的先记下来', core)

    def test_wrapup_template_documents_skip_reason(self):
        _, result = self.compiled()
        self.assertIn('skip_reason:', result['pure0'])


class SkippedRecordGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-1-6-1-')
        self.base = Path(self.temp.name) / 'proj'
        self.base.mkdir()
        self.doc = release13.fixture(self.base)
        self.addCleanup(self.temp.cleanup)

    def record(self, tests, verdict, extra=''):
        d = self.doc / '_run/batches'
        d.mkdir(exist_ok=True)
        text = release13.RECORD.format(batch=1, tasks='M1-T1, M1-T2, M1-T3', date='2026-09-22', verdict=verdict)
        text = text.replace('tests: pass\n', 'tests: %s\n%s' % (tests, extra), 1)
        (d / 'batch-1-20260922.md').write_text(text + '\n', encoding='utf-8')

    def test_skipped_tests_cannot_be_clean_without_reason(self):
        self.record('skipped', 'clean')
        with self.assertRaises(ValueError) as ctx:
            build_docs.read_batch_records(str(self.doc))
        self.assertIn('skip_reason', str(ctx.exception))

    def test_skip_reason_allows_docs_only_batch_and_is_exported(self):
        self.record('skipped', 'clean', extra='skip_reason: docs-only batch\n')
        rec = build_docs.read_batch_records(str(self.doc))['batch-1-20260922']
        self.assertEqual((rec['tests'], rec['verdict'], rec['skipReason']), ('skipped', 'clean', 'docs-only batch'))

    def test_open_with_skipped_tests_still_accepted_and_fail_still_rejected(self):
        self.record('skipped', 'open')
        self.assertIn('batch-1-20260922', build_docs.read_batch_records(str(self.doc)))
        self.record('fail', 'fixed')
        with self.assertRaises(ValueError):
            build_docs.read_batch_records(str(self.doc))


class ReleaseTests(unittest.TestCase):
    def test_release_1_6_1_ships_regression_and_version(self):
        self.assertEqual(hc.VERSION, '1.6.1')
        self.assertIn('test_release_1_6_1_tests.py', install_project.TESTS)


if __name__ == '__main__':
    unittest.main()
