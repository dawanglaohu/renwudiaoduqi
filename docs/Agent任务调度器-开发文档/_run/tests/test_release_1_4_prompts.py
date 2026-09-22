"""P4: task-first prompts, inline inputs, shared compiler metrics and budget warnings."""
import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_prompt_routing as routing
from test_maintenance import fixture, hc, maintenance, review, SCRIPTS
import build_docs


class Release14PromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def payload(self):
        return routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})

    def architecture(self, payload):
        payload['pres']['handoff']['architecture'] = {
            'shared': {'errors': '统一错误枚举', 'env': '统一环境变量'},
            'backend': {'data': '共用存储接口', 'tx': '事务只在 service 内开启',
                        'layers': '路由到 service 到 repo', 'custom': '项目自定条款'},
            'frontend': {'ui': '复用组件库', 'route': '路由登记在 app'}}

    def compiled(self, payload, tid='M1-T2'):
        return self.browser(payload)['tasks'][tid]['compiled']

    def test_design_dials_object_keeps_names_values_and_string_compatibility(self):
        payload = self.payload()
        ho = payload['pres']['handoff']
        ho['frontendModules'] = ['M1']
        ho['design'] = {'register': 'product', 'dials': {'SOUL': 5, 'SPECTACLE': 1, 'DENSITY': 6}}
        for kind in ('implementation', 'review'):
            prompt = self.compiled(payload)[kind]
            self.assertIn('三档刻度：SOUL=5 / SPECTACLE=1 / DENSITY=6', prompt)
            self.assertNotIn('[object Object]', prompt)
        ho['design']['dials'] = 'SOUL 5 / SPECTACLE 1 / DENSITY 6'
        self.assertIn('三档刻度：SOUL 5 / SPECTACLE 1 / DENSITY 6', self.compiled(payload)['implementation'])

    def test_dependency_code_refs_only_reach_consumers(self):
        payload = self.payload()
        refs = ['`src/repo.ts:12` — 复用存储接口', '- `src/types.ts:8` — 共用类型']
        payload['data']['tasks'][0]['codeRefs'] = refs
        result = self.browser(payload)['tasks']
        for kind in ('implementation', 'review'):
            prompt = result['M1-T2']['compiled'][kind]
            self.assertIn('## 前置留下的代码位置（直接用，不重造）', prompt)
            self.assertIn('### M1-T1 路由回归', prompt)
            for line in refs:
                self.assertIn(line, prompt)
            self.assertNotIn('前置留下的代码位置', result['M1-T1']['compiled'][kind])

    def test_wiring_categories_and_review_evidence(self):
        payload = self.payload()
        registry = {'backendRoutes': ['src/routes.ts', 'src/routes.ts'],
                    'frontendRoutes': 'web/app.tsx', 'container': ['src/container.ts'],
                    'eventKinds': ['shared/events.ts'], 'buildPipeline': ['postcss.config.js'],
                    'repoExports': ['src/repo/index.ts']}
        payload['pres']['handoff']['wiring'] = registry
        payload['handoff']['contracts']['M1-T2']['context'] = {'wiring': registry}
        prompts = self.compiled(payload)
        for criterion in ('路由已注册并返回真实数据', '页面已挂进装配件可导航',
                          'service 已注册并被路由或 job 调用', '事件从产生到订阅端到端',
                          '构建产物在浏览器里样式已加载', '已登记且被消费'):
            self.assertIn(criterion, prompts['implementation'])
        self.assertIn('## 接线要求（做完必须从入口可达）', prompts['implementation'])
        self.assertIn('入口可达证据：', prompts['implementation'])
        text = prompts['review']
        self.assertLess(text.index('\nACCEPTANCE\n'), text.index('\nWIRING\n'))
        self.assertLess(text.index('\nWIRING\n'), text.index('\nEDGES\n'))
        self.assertEqual(text.count('- 注册点 src/routes.ts 已含本任务条目'), 1)
        self.assertIn('→ 文件:行 ｜ 未接线 → 阻断', text)

    def test_registry_fallback_uses_effective_paths_and_task_categories_win(self):
        payload = self.payload()
        payload['pres']['handoff']['wiring'] = {
            'backendRoutes': ['packages/daemon/src/routes.ts'], 'frontendRoutes': ['web/app.tsx']}
        text = self.compiled(payload)['implementation']
        self.assertIn('backendRoutes：packages/daemon/src/routes.ts', text)
        self.assertNotIn('frontendRoutes：', text)
        payload['handoff']['contracts']['M1-T2']['context'] = {'wiring': {'container': ['src/di.ts']}}
        text = self.compiled(payload)['implementation']
        self.assertIn('container：src/di.ts', text)
        self.assertNotIn('backendRoutes：', text)
        payload['handoff']['contracts']['M1-T2']['context']['wiring'] = {}
        self.assertNotIn('## 接线要求', self.compiled(payload)['implementation'])

    def test_endpoint_fields_and_entities_inline_in_all_three_prompts(self):
        payload = self.payload()
        raw = '| GET | /api/v1/x | — | X |'
        field = '| /api/v1/x | lanes | array | 必填 |'
        entity = '| `runs` | id, state | 持久化 |'
        payload['data']['endpoints'] = [{'method': 'GET', 'path': '/api/v1/x',
                                         'raw': raw, 'fieldContracts': [field]}]
        payload['data']['entities'] = [{'name': '`runs`', 'fields': 'id, state', 'raw': entity}]
        payload['data']['tasks'][1]['accept'] += '；GET /api/v1/x 返回 runs。'
        for kind in ('implementation', 'review', 'bug'):
            text = self.compiled(payload)[kind]
            self.assertIn('## 相关契约（照它实现，改要走文档补丁）', text)
            for line in (raw, field, entity):
                self.assertIn(line, text)

    def test_reference_matching_is_exact_for_paths_codes_kinds_and_names(self):
        payload = self.payload()
        endpoints = [
            {'path': '/api/v1/x', 'raw': '| GET | /api/v1/x | ok |'},
            {'path': '/api/v1/xy', 'raw': '| GET | /api/v1/xy | wrong-path |'},
            {'path': '/api/v1/a', 'raw': '| POST | /api/v1/a | E_BUSY_2 |'},
            {'path': '/api/v1/b', 'raw': '| POST | /api/v1/b | E_BUSY_20 |'},
            {'path': '/api/v1/c', 'raw': '| POST | /api/v1/c | run.changed |'},
            {'path': '/api/v1/d', 'raw': '| POST | /api/v1/d | run.changed_more |'},
        ]
        payload['data']['endpoints'] = endpoints
        payload['data']['entities'] = [{'name': name, 'raw': '| ' + name + ' | entity | id |'}
                                       for name in ('runs', 'run')]
        task = payload['data']['tasks'][1]
        task.update(title='GET /api/v1/x', output='错误 E_BUSY_2', accept='事件 run.changed', input='表 runs')
        text = self.compiled(payload)['implementation']
        for index in (0, 2, 4):
            self.assertIn(endpoints[index]['raw'], text)
        for index in (1, 3, 5):
            self.assertNotIn(endpoints[index]['raw'], text)
        self.assertIn('| runs | entity | id |', text)
        self.assertNotIn('| run | entity | id |', text)

    def test_reference_limit_counts_unique_lines_and_reports_remainder(self):
        payload = self.payload()
        raw = '| GET | /api/v1/x | ok |'
        rows = ['| /api/v1/x | field%d | required |' % i for i in range(32)]
        payload['data']['endpoints'] = [{'path': '/api/v1/x', 'raw': raw,
                                         'fieldContracts': rows + [rows[0]]}]
        payload['data']['tasks'][1]['accept'] = '/api/v1/x'
        text = self.compiled(payload)['implementation']
        self.assertEqual(len([line for line in text.splitlines() if line.startswith('|')]), 30)
        self.assertIn('…还有 3 条，见 10/09 节', text)
        self.assertNotIn(rows[29], text)

    def test_task_sections_precede_appendix_and_bug_has_no_appendix(self):
        payload = self.payload()
        self.architecture(payload)
        payload['pres']['handoff'].update(frontendModules=['M1'], design={'tokens': '--ink:#111;'},
                                           conventions='使用既有约定')
        prompts = self.compiled(payload)
        impl = prompts['implementation']
        headings = ['## 验收标准', '## 必须处理的边界', '## 只改这些路径', '## 步骤',
                    '## 交活前回填', '## 不要做', '## 收到返工指令时', '## 本项目约定',
                    '## 回报', '## 附录', '## 全项目共用约定', '## 框架架构', '## 视觉方向']
        self.assertEqual([impl.index(h) for h in headings], sorted(impl.index(h) for h in headings))
        self.assertLess(prompts['review'].index('## 结论与动作'), prompts['review'].index('## 附录'))
        self.assertLess(prompts['review'].index('## 输出格式'), prompts['review'].index('## 附录'))
        self.assertNotIn('## 附录', prompts['bug'])
        self.assertNotIn('## 框架架构', prompts['bug'])

    def test_arch_keys_keep_shared_and_report_omitted_labels_at_end(self):
        payload = self.payload()
        self.architecture(payload)
        payload['handoff']['contracts']['M1-T2']['context'] = {'definition': {'archKeys': ['data']}}
        payload['pres']['handoff']['architectureScope'] = {'packages/daemon/': ['tx']}
        for kind in ('implementation', 'review'):
            text = self.compiled(payload)[kind]
            self.assertIn('- 数据层：共用存储接口', text)
            self.assertNotIn('- 事务边界：', text)
            self.assertNotIn('事务只在 service 内开启', text)
            self.assertIn('- 错误体系：统一错误枚举', text)
            self.assertIn('- 环境变量：统一环境变量', text)
            self.assertTrue(text.splitlines()[-1].startswith('未列出的条款：事务边界、'))
            self.assertTrue(text.endswith('见 08 节'))

    def test_arch_scope_unions_prefixes_and_falls_back_to_all(self):
        payload = self.payload()
        self.architecture(payload)
        ho = payload['pres']['handoff']
        ho['architectureScope'] = {'packages/daemon/': ['data'], 'packages/daemon/src/': ['layers'],
                                   'packages/daemon/src/repository/': ['tx']}
        text = self.compiled(payload)['implementation']
        self.assertIn('- 数据层：', text)
        self.assertIn('- 分层与调用方向：', text)
        self.assertNotIn('- 事务边界：', text)
        ho['architectureScope'] = {'packages/daemo/': ['data']}
        for config in (dict(ho), {k: v for k, v in ho.items() if k != 'architectureScope'}):
            payload['pres']['handoff'] = config
            text = self.compiled(payload)['implementation']
            self.assertIn('- 事务边界：', text)
            self.assertIn('- custom：', text)
            self.assertNotIn('未列出的条款', text)

    def test_empty_arch_keys_and_legacy_string_architecture(self):
        payload = self.payload()
        self.architecture(payload)
        payload['handoff']['contracts']['M1-T2']['context'] = {'definition': {'archKeys': []}}
        text = self.compiled(payload)['implementation']
        self.assertNotIn('## 框架架构', text)
        self.assertIn('未列出的条款', text)
        payload['pres']['handoff']['architecture']['backend'] = '旧字符串架构'
        text = self.compiled(payload)['implementation']
        self.assertIn('旧字符串架构', text)
        self.assertNotIn('未列出的条款', text)

    def test_legacy_payload_has_no_new_context_blocks(self):
        text = self.compiled(self.payload())['implementation']
        for heading in ('## 验收标准', '## 必须处理的边界', '## 步骤', '## 回报'):
            self.assertIn(heading, text)
        for heading in ('## 接线要求', '## 前置留下', '## 相关契约'):
            self.assertNotIn(heading, text)

    def test_export_metrics_match_browser_and_unicode_lengths(self):
        payload = self.payload()
        self.architecture(payload)
        payload['pres']['handoff']['conventions'] = '中文 🧪\n```md\n## 围栏里的示例\n```'
        payload['data']['tasks'][0]['codeRefs'] = ['`src/repo.ts:1` — 原样复用']
        before = copy.deepcopy(payload)
        exported = self.run_node(['node', str(routing.RUN / 'compile_prompts.js')],
                                 {'payload': payload, 'core': self.compiler_core({}, {})})['tasks']
        browser = self.browser(payload)['tasks']
        for tid, item in exported.items():
            self.assertEqual(item, browser[tid]['compiled'])
            for kind in ('implementation', 'review'):
                sections = item['sections'][kind]
                self.assertEqual(sum(n for _, n in sections) + len(sections) - 1, len(item[kind]))
                self.assertNotIn('围栏里的示例', [name for name, _ in sections])
        self.assertEqual(payload, before)

    def test_landed_review_keeps_actions_before_filtered_appendix(self):
        payload = self.payload()
        self.architecture(payload)
        payload['handoff']['contracts']['M1-T2']['context'] = {'definition': {'archKeys': ['data']}}
        result = self.browser(payload, progress={'M1-T2': 'done'},
                              maintenance={'pendingTasks': [], 'needsReview': ['M1-T2']})
        text = result['tasks']['M1-T2']['review']
        self.assertLess(text.index('输出 VERDICT:'), text.index('## 附录'))
        self.assertNotIn('- 事务边界：', text)


class Release14PromptInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-prompts-1-4-')
        self.addCleanup(self.temp.cleanup)
        self.doc = fixture(Path(self.temp.name))

    def test_extract_preserves_raw_rows_and_matches_field_paths_exactly(self):
        entity = '  | `runs` | id, state | 主表 |  '
        endpoint = '| GET | `/api/v1/x` | 无 | X | device |'
        field = '| `/api/v1/x` | lanes | array | 必填 |'
        other = '| `/api/v1/xy` | wrong | string | 可选 |'
        data = build_docs.extract({
            9: '| note | value |\n|---|---|\n| 无 | 无 |\n\n'
               '| 名称 | 字段 | 说明 |\n|---|---|---|\n' + entity + '\n\n'
               '| 名称 | 字段 | 说明 |\n|---|---|---|\n| ignored | x | y |',
            10: '| 方法 | 路径 | 入参 | 返回 | 权限 |\n|---|---|---|---|---|\n' + endpoint + '\n'
                '| POST | `/api/v1/no-fields` | 无 | X | device |\n\n'
                '## 字段级契约\n| 端点 | 字段 | 类型 | 必填 |\n|---|---|---|---|\n' + field + '\n' + other})
        self.assertEqual(data['entities'], [{'name': '`runs`', 'fields': 'id, state', 'raw': entity}])
        self.assertEqual(data['endpoints'][0]['raw'], endpoint)
        self.assertEqual(data['endpoints'][0]['fieldContracts'], [field])
        self.assertEqual(data['endpoints'][1]['fieldContracts'], [])
        self.assertEqual(build_docs.extract({})['entities'], [])

    def test_code_refs_are_read_only_strip_outer_fences_and_cap_at_40(self):
        folder = self.doc / '图谱/任务'
        folder.mkdir(parents=True)
        refs = ['`src/a.ts:%d` — 位置' % i for i in range(45)]
        path = folder / 'M1-T1.md'
        path.write_text('outside\n<!-- code:begin -->\n\n```text\n' + '\n\n'.join(refs) +
                        '\n```\n<!-- code:end -->\nignored', encoding='utf-8')
        (folder / 'M1-T2.md').write_text('<!-- code:begin -->\n缺结束标记', encoding='utf-8')
        (folder / 'M1-T3.md').write_text('<!-- code:begin -->\n'
                                       '_（**落地前必须回填**。一行一处，格式：`路径:行号` — 说明）_\n'
                                       '<!-- code:end -->', encoding='utf-8')
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in folder.iterdir()}
        tasks = [{'id': 'M1-T%d' % i} for i in range(1, 5)]
        build_docs.read_code_refs(str(self.doc), tasks)
        self.assertEqual(tasks[0]['codeRefs'], refs[:40])
        for task in tasks[1:]:
            self.assertEqual(task['codeRefs'], [])
        self.assertEqual(before, {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in folder.iterdir()})

    def test_main_feeds_context_without_changing_contract_hash_or_handoff(self):
        source = hc.source_file(self.doc, 19)[0]
        source.write_text(source.read_text(encoding='utf-8').replace('| M1-T2 | 校验第2组字符串长度 | M1 | 无 |',
                          '| M1-T2 | 校验第2组字符串长度 | M1 | M1-T1 |'), encoding='utf-8')
        folder = self.doc / '图谱/任务'
        folder.mkdir(parents=True)
        note = folder / 'M1-T1.md'
        note.write_text('<!-- code:begin -->\n`src/task-1.ts:42` — 复用\n<!-- code:end -->', encoding='utf-8')
        before = note.read_bytes()
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['promptBudget'] = 100000
        hc.write_json(self.doc / '_run/presentation.json', pres)
        contracts = maintenance.state(self.doc)[1]['contracts']
        result = subprocess.run([sys.executable, '-B', str(SCRIPTS / 'build_docs.py'), str(self.doc)],
                                text=True, encoding='utf-8', capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        payload = json.loads(build_docs.js_payload((self.doc / 'docs-data.js').read_text(encoding='utf-8'), 'window.DOCS = '))
        self.assertEqual(payload['pres']['handoff'], pres['handoff'])
        self.assertEqual(payload['handoff']['contracts'], contracts)
        self.assertIn('entities', payload['data'])
        self.assertIn('`src/task-1.ts:42` — 复用', payload['dispatch']['M1-T2']['implementation'])
        self.assertEqual(note.read_bytes(), before)

    def test_custom_budget_warns_for_both_prompts_with_largest_sections(self):
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['promptBudget'] = 100
        hc.write_json(self.doc / '_run/presentation.json', pres)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            report = maintenance.build(self.doc)
        self.assertEqual(report.count(review.BLOCK), 0)
        dispatch = hc.read_json(self.doc / '_run/dispatch.json')['tasks']
        for tid, item in dispatch.items():
            for kind, label in (('implementation', '实施'), ('review', '审查')):
                largest = sorted(item['sections'][kind], key=lambda s: s[1], reverse=True)[:3]
                expected = '  ! %s %s提示词 %d 字符，超预算：最大三段 %s' % (
                    tid, label, len(item[kind]), '；'.join('<%s %d 字符>' % (name, n) for name, n in largest))
                self.assertIn(expected.lstrip(), [line.lstrip() for line in output.getvalue().splitlines()])

    def test_default_budget_warns_without_truncating_prompt(self):
        pres = hc.read_json(self.doc / '_run/presentation.json')
        pres['handoff']['architecture'] = {'shared': {'types': '字符' * 6100}}
        hc.write_json(self.doc / '_run/presentation.json', pres)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            maintenance.build(self.doc)
        self.assertIn('超预算：最大三段 <全项目共用约定', output.getvalue())
        item = hc.read_json(self.doc / '_run/dispatch.json')['tasks']['M1-T1']
        self.assertIn('字符' * 6100, item['implementation'])


if __name__ == '__main__':
    unittest.main()
