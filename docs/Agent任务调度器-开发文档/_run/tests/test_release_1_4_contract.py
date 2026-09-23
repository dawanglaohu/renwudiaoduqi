"""接线范围、端点供需提醒与文档/阶段关卡的回归。"""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_maintenance import fixture, hc, maintenance, review, SCRIPTS
import stage


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-wiring-')
        self.addCleanup(self.temp.cleanup)
        self.doc = fixture(Path(self.temp.name))

    def config(self, registry=None, definitions=None):
        pres = hc.read_json(self.doc / '_run/presentation.json')
        if registry is not None:
            pres['handoff']['wiring'] = registry
        hc.write_json(self.doc / '_run/presentation.json', pres)
        if definitions is not None:
            hc.write_json(self.doc / '_run/task-contracts.json', {'schemaVersion': 1, 'tasks': definitions})
        return pres

    def section(self, number):
        return hc.source_file(self.doc, number)[0]

    def replace(self, number, old, new):
        path = self.section(number)
        text = path.read_text(encoding='utf-8')
        self.assertEqual(text.count(old), 1)
        path.write_text(text.replace(old, new), encoding='utf-8')

    def state(self):
        return maintenance.state(self.doc)[1]

    def issues(self, code, analysis=None):
        return [i for i in (analysis or self.state())['issues'] if i['code'] == code]

    def verify_all(self, analysis):
        hc.write_json(self.doc / '_run/task-reviews.json', {
            tid: {'contractHash': c['hash'], 'verdict': 'pass', 'evidence': ['fixture: 核对路径、前置与验收']}
            for tid, c in analysis['contracts'].items()})
        return hc.readiness(self.doc, analysis)

    def endpoint_fixture(self):
        self.section(10).write_text('# 接口约定\n\n'
                                   '| 方法 | 路径 | 入参 | 返回 | 权限 |\n'
                                   '|---|---|---|---|---|\n'
                                   '| GET | `/api/v1/x` | 无 | X | 匿名 |\n', encoding='utf-8')
        self.replace(19, '`src/task-3.ts`', '`src/task-3.ts`、GET /api/v1/x')
        self.replace(19, '2) 非空输入原样返回 | 1d |\n| M1-T2',
                     '2) 数据来源：GET /api/v1/x 返回真实结果 | 1d |\n| M1-T2')

    def test_wiring_merges_deduplicates_and_hashes_only_relevant_registry(self):
        pres = self.config({'backendRoutes': ['src/routes.ts', 'src/routes.ts'], 'container': 'src/di.ts'},
                           {'M1-T2': {'wiring': ['backendRoutes'], 'supportPaths': ['src/routes.ts']}})
        before = self.state()
        self.assertEqual(before['effectivePaths']['M1-T2'], ['src/routes.ts', 'src/task-2.ts'])
        self.assertEqual(before['contracts']['M1-T2']['context']['wiring'], {'backendRoutes': ['src/routes.ts']})
        pres['handoff']['wiring']['backendRoutes'] = 'src/new-routes.ts'
        hc.write_json(self.doc / '_run/presentation.json', pres)
        after = self.state()
        self.assertNotEqual(before['contracts']['M1-T2']['hash'], after['contracts']['M1-T2']['hash'])
        self.assertEqual(before['contracts']['M1-T1']['hash'], after['contracts']['M1-T1']['hash'])

    def test_legacy_context_and_hashes_unchanged_without_wiring(self):
        legacy_doc = fixture(Path(self.temp.name) / 'legacy')
        self.config({'backendRoutes': 'src/routes.ts'}, {'M1-T2': {'wiring': ['backendRoutes']}})
        wired = self.state()['contracts']
        legacy = maintenance.state(legacy_doc)[1]['contracts']
        self.assertNotIn('wiring', legacy['M1-T2']['context'])
        self.assertIn('wiring', wired['M1-T2']['context'])
        for tid in ('M1-T1', 'M1-T3'):
            self.assertNotIn('wiring', wired[tid]['context'])
            self.assertEqual(wired[tid], legacy[tid])
        self.config({}, {})
        self.assertEqual(self.state()['contracts'], legacy)

    def test_h12_warn_is_ready_after_review_and_not_a_blocker(self):
        self.config({'backendRoutes': 'src/routes.ts'})
        self.replace(19, '校验第3组字符串长度', '注册 X 接口')
        checked = self.state()
        warn = self.issues('H12', checked)
        self.assertEqual(len(warn), 1)
        self.assertEqual(warn[0]['level'], 'WARN')
        self.assertEqual(warn[0]['msg'], 'M1-T3 疑似接线任务未列注册点（命中：接口）')
        ready = self.verify_all(checked)['M1-T3']
        self.assertTrue(ready['ready'])
        self.assertEqual(ready['blockers'], [])
        self.assertIn(warn[0]['msg'], ready['reasons'])
        self.config({})
        self.assertEqual(self.issues('H12'), [])

    def test_h12_keywords_case_and_scope_coverage(self):
        data, _ = maintenance.state(self.doc)
        pres = self.config({'backendRoutes': 'src/routes.ts'})
        for word in ('路由', '接口', '端点', '/api/', '页面', '挂到', '挂进', '路由表',
                     'SERVICE', '服务', 'JOB', '后台任务', '事件', 'KIND', '迁移', 'MIGRATION', '壳', 'BRIDGE'):
            with self.subTest(word=word):
                data['tasks'][2]['title'] = word
                result = hc.analyze(self.doc, data['tasks'], pres)
                self.assertEqual(len(self.issues('H12', result)), 1)
        for declared in (['src/routes.ts'], ['src/']):
            pres['handoff']['taskPaths']['M1-T3'] = declared
            self.assertEqual(self.issues('H12', hc.analyze(self.doc, data['tasks'], pres)), [])
        pres['handoff']['taskPaths']['M1-T3'] = ['src/routes.tsx']
        self.assertEqual(len(self.issues('H12', hc.analyze(self.doc, data['tasks'], pres))), 1)

    def test_h13_output_priority_with_accept_consumer_and_transitive_dependency(self):
        self.endpoint_fixture()
        checked = self.state()
        warns = self.issues('H13', checked)
        self.assertEqual([i['msg'] for i in warns], ['M1-T1 消费端点 /api/v1/x 但提供方 M1-T3 不在前置'])
        ready = self.verify_all(checked)['M1-T1']
        self.assertTrue(ready['ready'])
        self.assertEqual(ready['blockers'], [])
        self.assertIn(warns[0]['msg'], ready['reasons'])
        data, _ = maintenance.state(self.doc)
        data['tasks'][0]['deps'] = ['M1-T2']
        data['tasks'][1]['deps'] = ['M1-T3']
        pres = hc.read_json(self.doc / '_run/presentation.json')
        checked = hc.analyze(self.doc, data['tasks'], pres, endpoints=data['endpoints'])
        self.assertEqual(self.issues('H13', checked), [])
        data['tasks'][0]['deps'] = []
        self.assertEqual(self.issues('H13', hc.analyze(self.doc, data['tasks'], pres)), [])

    def test_h13_accept_fallback_multiple_providers_and_exact_path(self):
        data, _ = maintenance.state(self.doc)
        pres = hc.read_json(self.doc / '_run/presentation.json')
        tasks = data['tasks']
        tasks[0]['input'] = 'GET /api/v1/x'
        tasks[1]['accept'] += ' GET /api/v1/x 返回真实数据'
        tasks[2]['accept'] += ' GET /api/v1/x 返回真实数据'
        def analyze():
            return hc.analyze(self.doc, tasks, pres, endpoints=[{'path': '/api/v1/x'}])
        self.assertEqual(self.issues('H13', analyze())[0]['taskIds'], ['M1-T1'])
        tasks[0]['deps'] = ['M1-T3']
        self.assertEqual(self.issues('H13', analyze()), [])
        tasks[0]['deps'] = []
        for path in ('/api/v1/xs', '/api/v1/x/child', '/prefix/api/v1/x', '/api/v1/x.json', '/api/v1/x-extra'):
            tasks[0]['input'] = path
            self.assertEqual(self.issues('H13', analyze()), [])

    def test_h13_reaches_review_and_reader_payload(self):
        self.endpoint_fixture()
        self.assertTrue(any(i['code'] == 'H13' for i in review.review(str(self.doc)).items))
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.build(self.doc)
        source = (self.doc / 'docs-data.js').read_text(encoding='utf-8')
        payload = json.loads(source[len('window.DOCS = '):].strip().rstrip(';'))
        self.assertTrue(any(i['code'] == 'H13' for i in payload['handoff']['issues']))

    def test_h13_chinese_adjacent_paths_keep_output_provider(self):
        data, _ = maintenance.state(self.doc)
        pres = hc.read_json(self.doc / '_run/presentation.json')
        data['tasks'][2]['output'] = '实现/api/v1/x接口'
        data['tasks'][0]['accept'] = '调用/api/v1/x返回真实数据'
        result = hc.analyze(self.doc, data['tasks'], pres, endpoints=[{'path': '/api/v1/x'}])
        self.assertEqual([i['msg'] for i in self.issues('H13', result)],
                         ['M1-T1 消费端点 /api/v1/x 但提供方 M1-T3 不在前置'])

    def test_h14_unknown_global_or_task_key_and_missing_registration_block(self):
        for registry, definition, affected in (
            ({'unknown': 'src/routes.ts'}, {}, 'M1-T1'),
            ({'backendRoutes': 'src/routes.ts'}, {'wiring': ['unknown']}, 'M1-T2'),
            ({}, {'wiring': ['backendRoutes']}, 'M1-T2'),
            ({'backendRoutes': []}, {'wiring': ['backendRoutes']}, 'M1-T2'),
        ):
            with self.subTest(registry=registry, definition=definition):
                self.config(registry, {'M1-T2': definition})
                checked = self.state()
                self.assertTrue(self.issues('H14', checked))
                self.assertTrue(all(i['level'] == 'BLOCK' for i in self.issues('H14', checked)))
                ready = self.verify_all(checked)[affected]
                self.assertFalse(ready['ready'])
                self.assertTrue(ready['blockers'])

    def test_wiring_invalid_paths_and_types_rejected(self):
        for value in ('src/*/routes.ts', '../routes.ts', '/absolute.ts', 'src\\routes.ts', ''):
            self.config({'backendRoutes': value}, {'M1-T2': {'wiring': ['backendRoutes']}})
            checked = self.state()
            self.assertTrue(self.issues('H03', checked))
            self.assertNotIn(value, checked['effectivePaths']['M1-T2'])
        for value in ([], None, '', {'backendRoutes': 4}, {'backendRoutes': ['src/routes.ts', None]}):
            pres = hc.read_json(self.doc / '_run/presentation.json')
            pres['handoff']['wiring'] = value
            hc.write_json(self.doc / '_run/presentation.json', pres)
            self.assertTrue(any(i['code'] == 'H00' for i in review.review(str(self.doc)).items))
        for value in ('backendRoutes', [2]):
            self.config({'backendRoutes': 'src/routes.ts'}, {'M1-T2': {'wiring': value}})
            with self.assertRaises(ValueError):
                self.state()

    def test_x15_requires_heading_not_a_body_mention(self):
        self.replace(6, '# 系统架构与模块划分', '# 系统架构与模块划分\n\n接线注册表放在这里。')
        self.assert_rule('X15', True, 'WARN')
        self.replace(6, '接线注册表放在这里。', '## 接线注册表\n\n| 类别 | 路径 |\n|---|---|\n| jobs | src/jobs.ts |')
        self.assert_rule('X15', False)

    def test_x15_ignores_fenced_examples(self):
        path = self.section(6)
        original = path.read_text(encoding='utf-8')
        for fence in ('```', '~~~~'):
            path.write_text(original + '\n' + fence + 'markdown\n## 接线注册表\n' + fence, encoding='utf-8')
            self.assert_rule('X15', True, 'WARN')
        path.write_text(original + '\n### 后端接线注册表\n\n表格与配置同源。', encoding='utf-8')
        self.assert_rule('X15', False)

    def assert_rule(self, code, present, level=None):
        found = [i for i in review.review(str(self.doc)).items if i['code'] == code]
        self.assertEqual(bool(found), present, found)
        if level:
            self.assertTrue(all(i['level'] == level for i in found))
        return found

    def test_x16_missing_or_nameless_smoke_and_real_browser(self):
        for body, warns in (('分层测试与接口单测。', True), ('端到端冒烟测试。', True),
                            ('浏览器检查首页。', True), ('E2E：真起服务并在浏览器断言样式。', False),
                            ('冒烟：真实启动服务。', False)):
            self.section(17).write_text('# 测试策略\n\n' + body, encoding='utf-8')
            self.assert_rule('X16', warns, 'WARN' if warns else None)

    def test_x17_acceptance_only_all_forbidden_words_and_task_id(self):
        original = self.section(19).read_text(encoding='utf-8')
        for word in ('占位', '桩', '待接入', '后续任务接', '后续接入', 'TODO', 'todo'):
            text = original.replace('2) 非空输入原样返回', '2) ' + word, 1)
            self.section(19).write_text(text, encoding='utf-8')
            hits = self.assert_rule('X17', True, 'BLOCK')
            self.assertEqual(len(hits), 1)
            self.assertIn('M1-T1', hits[0]['msg'])
        self.section(19).write_text(original.replace('固定字符串', '固定字符串与桩输入', 1), encoding='utf-8')
        self.assert_rule('X17', False)

    def test_x17_blocks_only_its_task_in_readiness_and_reader(self):
        checked = self.state()
        self.verify_all(checked)
        self.replace(19, '2) 非空输入原样返回 | 1d |\n| M1-T2',
                     '2) 待接入 | 1d |\n| M1-T2')
        checked = self.state()
        self.verify_all(checked)
        report = review.review(str(self.doc))
        hits = [i for i in report.items if i['code'] == 'X17']
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0].get('taskIds'), ['M1-T1'])
        checks = hc.readiness(self.doc, checked, report.items)
        self.assertFalse(checks['M1-T1']['ready'])
        self.assertIn(hits[0]['msg'], checks['M1-T1']['blockers'])
        self.assertTrue(checks['M1-T2']['ready'])
        self.assertTrue(checks['M1-T3']['ready'])
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.build(self.doc)
        payload = json.loads((self.doc / 'docs-data.js').read_text(encoding='utf-8')
                             .split('window.DOCS = ', 1)[1].strip().rstrip(';'))
        self.assertFalse(payload['handoff']['readiness']['M1-T1']['ready'])
        self.assertTrue(payload['handoff']['readiness']['M1-T2']['ready'])
        self.assertTrue(payload['handoff']['readiness']['M1-T3']['ready'])

    def test_scoped_structural_block_is_enforced_and_global_block_still_blocks_all(self):
        checked = self.state()
        self.verify_all(checked)
        problem = {'level': 'BLOCK', 'code': 'X17', 'msg': 'task-specific invalid acceptance',
                   'where': '19', 'taskIds': ['M1-T2']}
        checks = hc.readiness(self.doc, checked, [problem])
        self.assertTrue(checks['M1-T1']['ready'])
        self.assertFalse(checks['M1-T2']['ready'])
        self.assertEqual(checks['M1-T2']['blockers'], [problem['msg']])
        self.assertTrue(checks['M1-T3']['ready'])
        del problem['taskIds']
        checks = hc.readiness(self.doc, checked, [problem])
        self.assertTrue(all(not c['ready'] for c in checks.values()))
        self.assertTrue(all(c['blockers'] == [problem['msg']] for c in checks.values()))

    def test_flask_route_parameters_are_not_unfilled_placeholders(self):
        for line in ('| POST | /items/<id>/completion | completed | HTML |',
                     '| GET | `/items/<int:item_id>` | id | HTML |',
                     'POST /items/<item_id>/completion uses the form contract.',
                     '| 页面 | GET / 返回事项；POST /items、POST /items/<id>/completion 成功后重读 |'):
            report = review.Report()
            review.check_placeholders(report, [{'file': '10-api.md', 'lines': [line]}], None)
            self.assertFalse([i for i in report.items if i['code'] == 'P1'], line)
        for line in ('Choose <backend> before implementation.',
                     '| POST | /items/<id>/completion | <填写字段> | HTML |',
                     '| GET | /<填写路径> | none | HTML |'):
            report = review.Report()
            review.check_placeholders(report, [{'file': '10-api.md', 'lines': [line]}], None)
            self.assertTrue([i for i in report.items if i['code'] == 'P1'], line)

    def test_x17_todo_marker_does_not_match_project_paths_or_identifiers(self):
        path = self.section(19)
        original = path.read_text(encoding='utf-8')
        old = '2) 非空输入原样返回'
        for value in ('接线点：todo/web.py；调用 todo/__init__.py',
                      '校验 TODO_SECRET_KEY 并测试 tests/test_todo.py',
                      '读取 `todo.py` 与 `src/todo` 文件'):
            path.write_text(original.replace(old, '2) ' + value, 1), encoding='utf-8')
            self.assert_rule('X17', False)
        for value in ('TODO', 'todo: wire endpoint', '接口TODO接入', '`TODO` 接线'):
            path.write_text(original.replace(old, '2) ' + value, 1), encoding='utf-8')
            self.assert_rule('X17', True, 'BLOCK')

    def test_x18_distribution_markers(self):
        self.assert_rule('X18', True, 'WARN')
        for word in ('分发形态', '随包', '安装包', '打包形态'):
            self.section(18).write_text('# 部署与运维\n\n' + word + '：命令行工具。', encoding='utf-8')
            self.assert_rule('X18', False)

    def test_json_schema_and_x17_exit_code(self):
        self.replace(19, '校验第1组字符串长度', '校验第1组字符串长度（输入）')
        self.replace(19, '2) 非空输入原样返回 | 1d |\n| M1-T2',
                     '2) 待接入 | 1d |\n| M1-T2')
        run = subprocess.run([sys.executable, '-B', str(SCRIPTS / 'review.py'), str(self.doc), '--json'],
                             capture_output=True, text=True, encoding='utf-8', timeout=30)
        self.assertEqual(run.returncode, 1, run.stderr)
        payload = json.loads(run.stdout)
        self.assertEqual(set(payload), {'block', 'warn', 'info', 'items', 'sourceVersion'})
        self.assertTrue(any(i['code'] == 'X17' for i in payload['items']))

    def test_s2_missing_heading_blocks_even_with_one_registry_key(self):
        self.config({'backendRoutes': 'src/routes.ts'})
        items = review.review(str(self.doc)).items
        self.assertTrue(any('X15' in x for x in stage.gate_s2(self.doc, items)))
        self.replace(6, '# 系统架构与模块划分', '# 系统架构与模块划分\n\n## 接线注册表')
        problems = stage.gate_s2(self.doc, review.review(str(self.doc)).items)
        self.assertFalse(any('X15' in x or '缺 handoff.wiring' in x for x in problems))

    def test_s2_rejects_invalid_registry_before_tasks_exist(self):
        for registry, message in (({'typo': 'src/routes.ts'}, 'H14'),
                                  ({'backendRoutes': ['']}, 'H03'),
                                  ({'backendRoutes': 'src/*.ts'}, 'H03'),
                                  ({'backendRoutes': 7}, '必须是路径')):
            self.config(registry)
            problems = stage.gate_s2(self.doc, [])
            self.assertTrue(any(message in p for p in problems), problems)

    def test_s4_x16_x18_block_and_all_distribution_markers_pass(self):
        problems = stage.gate_s4(self.doc, review.review(str(self.doc)).items)
        self.assertTrue(any('X16' in x for x in problems))
        self.assertTrue(any('X18' in x for x in problems))
        self.section(17).write_text('# 测试策略\n\n端到端：真起服务，浏览器检查样式。', encoding='utf-8')
        self.section(15).write_text('# 性能与容量假设\n\n用户量与并发未评估，上线前按真实流量确定目标。', encoding='utf-8')
        for word in ('分发形态', '随包', '安装包', '打包形态'):
            self.section(18).write_text('# 部署与运维\n\n' + word + '：脚本，发布时携带依赖清单和运行时要求。', encoding='utf-8')
            self.assertEqual(stage.gate_s4(self.doc, review.review(str(self.doc)).items), [])

    def test_s5_prints_individual_counts_zero_included_and_does_not_block_warns(self):
        self.config({'backendRoutes': 'src/routes.ts'})
        self.endpoint_fixture()
        self.replace(19, '校验第3组字符串长度', '注册 X 接口')
        items = review.review(str(self.doc)).items
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(stage.gate_s5(self.doc, items), [])
        self.assertIn('H12 2 条，H13 1 条', output.getvalue())
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            stage.gate_s5(self.doc, [])
        self.assertIn('H12 0 条，H13 0 条', output.getvalue())
        self.replace(19, '返回真实结果', '待接入真实结果')
        with contextlib.redirect_stdout(io.StringIO()):
            problems = stage.gate_s5(self.doc, review.review(str(self.doc)).items)
        self.assertTrue(any('X17' in x and 'M1-T1' in x for x in problems))


if __name__ == '__main__':
    unittest.main()
