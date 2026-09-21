"""1.5.0 TypeSafe 判断层接入的回归：judgments 接线类别、X19/X20 与 S2/S4 关卡、
H12 关键词、判断层任务的提示词（typesafe-ai、反造假第 ⑦ 条、密钥不判 pass）、开工与收口提示词、安装器清单。
没登记 judgments、05 节没写 TypeSafe 的项目一条都不触发。"""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
import unittest.mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_maintenance import fixture, hc, maintenance, review, SCRIPTS
import test_prompt_routing as routing
import test_release_1_4_gate as gate
import install_project
import stage
import typesafe_ask
import urllib.error
import io as _io
import json
import os

JUDG = 'src/judgments.ts'


class TypeSafeDocChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-typesafe-')
        self.addCleanup(self.temp.cleanup)
        self.doc = fixture(Path(self.temp.name))

    def config(self, registry=None, definitions=None):
        pres = hc.read_json(self.doc / '_run/presentation.json')
        if registry is not None:
            pres['handoff']['wiring'] = registry
        hc.write_json(self.doc / '_run/presentation.json', pres)
        if definitions is not None:
            hc.write_json(self.doc / '_run/task-contracts.json', {'schemaVersion': 1, 'tasks': definitions})

    def section(self, number):
        return hc.source_file(self.doc, number)[0]

    def codes(self, *wanted):
        items = review.review(str(self.doc)).items
        return {code: [i for i in items if i['code'] == code] for code in wanted}

    def test_no_judgment_layer_means_no_x19_x20(self):
        found = self.codes('X19', 'X20')
        self.assertEqual(found['X19'], [])
        self.assertEqual(found['X20'], [])
        self.config({'backendRoutes': 'src/routes.ts'})
        found = self.codes('X19', 'X20')
        self.assertEqual(found['X19'], [])
        self.assertEqual(found['X20'], [])

    def test_registry_or_stack_mention_triggers_x19_x20_until_sections_written(self):
        for trigger in ('registry', 'stack'):
            with self.subTest(trigger=trigger):
                self.doc = fixture(Path(tempfile.mkdtemp(prefix='ts-', dir=self.temp.name)))
                if trigger == 'registry':
                    self.config({'judgments': JUDG})
                else:
                    self.section(5).write_text('# 技术栈\n\n语义判断走 TypeSafe（System One，jev-latest）。\n\n## 被否方案\n\n自训分类器。\n',
                                               encoding='utf-8')
                found = self.codes('X19', 'X20')
                self.assertEqual(len(found['X19']), 1, found)
                self.assertEqual(len(found['X20']), 1, found)
                self.assertTrue(all(i['level'] == 'WARN' for i in found['X19'] + found['X20']))
                self.assertIn('10-', found['X19'][0]['where'])
                self.assertIn('18-', found['X20'][0]['where'])
                self.section(10).write_text('# 接口约定\n\n| 方法 | 路径 | 入参 | 返回 | 权限 |\n|---|---|---|---|---|\n'
                                            '| GET | `/api/x` | 无 | X | 匿名 |\n\n## 语义判断契约（TypeSafe）\n\n'
                                            '| 问题 ID | 原语 | state 字段 | instructions | criteria | 阈值与低置信处理 | 消费方 |\n'
                                            '|---|---|---|---|---|---|---|\n'
                                            '| `x.kind` | choice | `x.text` | 属于哪类 | a；b；other | confidence < 0.6 转人工 | M1 |\n',
                                            encoding='utf-8')
                self.section(18).write_text('# 部署与运维\n\n分发形态：脚本。配置项：`TYPESAFE_API_KEY`（必填，缺失时启动失败）。\n',
                                            encoding='utf-8')
                found = self.codes('X19', 'X20')
                self.assertEqual(found['X19'], [])
                self.assertEqual(found['X20'], [])

    def test_x19_ignores_fenced_heading_and_na_section(self):
        self.config({'judgments': JUDG})
        self.section(10).write_text('# 接口约定\n\n```markdown\n## 语义判断契约\n```\n', encoding='utf-8')
        self.assertEqual(len(self.codes('X19')['X19']), 1)
        self.section(10).write_text('# 接口约定\n\n不适用：纯脚本，无对外接口。\n', encoding='utf-8')
        self.assertEqual(self.codes('X19')['X19'], [])

    def test_s2_and_s4_gates_promote_x19_x20_to_blockers(self):
        self.config({'judgments': JUDG})
        self.section(6).write_text(self.section(6).read_text(encoding='utf-8') + '\n## 接线注册表\n\n- judgments：`' + JUDG + '`\n',
                                   encoding='utf-8')
        items = review.review(str(self.doc)).items
        self.assertTrue(any('X19' in p for p in stage.gate_s2(self.doc, items)))
        self.assertFalse(any('H14' in p for p in stage.gate_s2(self.doc, items)))
        self.assertTrue(any('X20' in p for p in stage.gate_s4(self.doc, items)))
        self.assertFalse(any('X20' in p for p in stage.gate_s2(self.doc, items)))
        self.assertFalse(any('X19' in p for p in stage.gate_s4(self.doc, items)))

    def test_judgments_is_a_wiring_category_and_joins_effective_paths(self):
        self.config({'judgments': JUDG}, {'M1-T1': {'wiring': ['judgments']}})
        analysis = maintenance.state(self.doc)[1]
        self.assertEqual([i for i in analysis['issues'] if i['code'] == 'H14'], [])
        self.assertIn(JUDG, analysis['effectivePaths']['M1-T1'])
        self.assertNotIn(JUDG, analysis['effectivePaths']['M1-T2'])
        self.assertEqual(analysis['contracts']['M1-T1']['context']['wiring'], {'judgments': [JUDG]})
        self.config({'judgments': JUDG}, {'M1-T1': {'wiring': ['judgment']}})
        analysis = maintenance.state(self.doc)[1]
        self.assertTrue(any(i['code'] == 'H14' and i['level'] == 'BLOCK' for i in analysis['issues']))

    def test_h12_hint_words_cover_judgment_vocabulary(self):
        self.config({'judgments': JUDG})
        path = self.section(19)
        original = path.read_text(encoding='utf-8')
        for word in ('工单分流判断', 'Judgment routing', 'TypeSafe 分流', '按置信度分流', 'confidence gate'):
            path.write_text(original.replace('校验第1组字符串长度', word, 1), encoding='utf-8')
            analysis = maintenance.state(self.doc)[1]
            hits = [i for i in analysis['issues'] if i['code'] == 'H12' and 'M1-T1' in i['taskIds']]
            self.assertEqual(len(hits), 1, (word, hits))
            self.assertEqual(hits[0]['level'], 'WARN')

    def test_installer_ships_the_typesafe_regression(self):
        self.assertIn('test_release_1_5_typesafe.py', install_project.TESTS)
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=Path(self.temp.name))
        self.assertTrue((self.doc / '_run/tests/test_release_1_5_typesafe.py').is_file())
        self.assertEqual(hc.read_json(self.doc / '_run/tool-version.json')['version'], '1.6.0')


class TypeSafePromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser
    view = gate.WrapupGateTests.view

    def payload(self, judgments_path='packages/daemon/src/judgments.ts', frontend=False):
        payload = routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})
        payload['pres']['handoff']['wiring'] = {'judgments': judgments_path}
        if frontend:
            payload['pres']['handoff']['frontendModules'] = ['M1']
        return payload

    def test_uncovered_registry_adds_nothing(self):
        result = self.browser(self.payload('server/judgments.ts'))
        for tid in ('M1-T1', 'M1-T2'):
            compiled = result['tasks'][tid]['compiled']
            for kind in ('implementation', 'review', 'bug'):
                self.assertNotIn('`typesafe-ai`', compiled[kind])
                self.assertNotIn('TYPESAFE_API_KEY', compiled[kind])
            self.assertNotIn('⑦', compiled['review'])
            self.assertNotIn('⑤ 判断层', compiled['bug'])
            self.assertIn('run adjudicate', compiled['implementation'])
            self.assertNotIn('写判断层时', compiled['implementation'])
        plain = self.browser(routing.payload_for('M1-T1'))['tasks']['M1-T1']['compiled']
        self.assertNotIn('`typesafe-ai`', plain['review'])
        self.assertIn('TypeSafe 复核（可选', plain['review'])

    def test_covered_task_gets_skill_seventh_scan_and_key_rule(self):
        for frontend in (False, True):
            with self.subTest(frontend=frontend):
                compiled = self.browser(self.payload(frontend=frontend))['tasks']['M1-T2']['compiled']
                impl = compiled['implementation']
                self.assertIn('`typesafe-ai`　写判断层时', impl)
                self.assertIn('问题与阈值常量集中于此、与 10 节语义判断契约同 ID、一次真实调用记录了 model', impl)
                self.assertIn('- judgments：packages/daemon/src/judgments.ts；', impl)
                text = compiled['review']
                self.assertIn('`typesafe-ai`　核判断层时', text)
                scan = text.split('反造假扫描：', 1)[1].split('\n', 1)[0]
                for needle in ('①', '⑥', '⑦ 判断层', '固定应答替换', '阈值门禁恒返回通过', 'argmax', 'model 字段'):
                    self.assertIn(needle, scan)
                key_step = ('10' if frontend else '9') + '. 判断层：TYPESAFE_API_KEY 未设置就不给结论'
                self.assertIn(key_step, text)
                self.assertLess(text.index(key_step), text.index('## 分级'))
                grading = text.split('## 分级', 1)[1].split('## 结论', 1)[0]
                self.assertIn('判断层客户端被固定应答替换', grading)
                self.assertIn('测试钩子；判断层', grading)
                bug = compiled['bug']
                self.assertIn('⑤ 判断层', bug)
                self.assertIn('低置信输入', bug)
                self.assertIn('记录扫描命中位置', bug)
                self.assertLess(text.index('反造假扫描'), text.index('## 分级'))

    def test_contract_context_wiring_wins_over_path_coverage(self):
        payload = self.payload('server/judgments.ts')
        payload['handoff']['contracts']['M1-T1']['context'] = {'wiring': {'judgments': ['server/judgments.ts']}}
        result = self.browser(payload)['tasks']
        self.assertIn('`typesafe-ai`', result['M1-T1']['compiled']['implementation'])
        self.assertIn('run adjudicate', result['M1-T2']['compiled']['implementation'])
        self.assertNotIn('写判断层时', result['M1-T2']['compiled']['implementation'])

    def test_kickoff_and_batch_prompts_follow_the_registry(self):
        payload = self.payload()
        kickoff = self.view(payload, progress={})['kickoff']
        self.assertIn('5. 本项目接了 TypeSafe 判断层（System One，注册表 packages/daemon/src/judgments.ts）', kickoff)
        self.assertIn('https://console.typesafe.ai/keys', kickoff)
        self.assertIn('claude plugin install typesafe@typesafe-ai', kickoff)
        self.assertIn('npx skills add typesafe-ai/skills --skill typesafe-ai', kickoff)
        self.assertLess(kickoff.index('4. 确认栈工具可用'), kickoff.index('5. 本项目接了 TypeSafe'))
        wrapup = self.browser(payload)['pure0']
        self.assertIn('本批含判断层任务：跑 17 节的判断用例集并做一次真实调用', wrapup)
        self.assertIn('`typesafe-ai`　核判断层接缝时', wrapup)
        self.assertLess(wrapup.index('端到端冒烟'), wrapup.index('判断用例集'))
        self.assertLess(wrapup.index('判断用例集'), wrapup.index('2. 逐任务'))
        plain = routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})
        self.assertNotIn('TypeSafe', self.view(plain, progress={})['kickoff'])
        self.assertNotIn('判断用例集', self.browser(plain)['pure0'])

    def test_exported_dispatch_matches_browser(self):
        payload = self.payload()
        exported = self.run_node(['node', str(routing.RUN / 'compile_prompts.js')],
                                 {'payload': payload, 'core': self.core})
        browser = self.browser(payload)
        for tid in ('M1-T1', 'M1-T2'):
            for kind in ('implementation', 'review', 'bug'):
                self.assertEqual(exported['tasks'][tid][kind], browser['tasks'][tid]['compiled'][kind])
        self.assertEqual(exported['batches']['0']['wrapup'], browser['pure0'])

class _Resp(object):
    def __init__(self, body, status=200):
        self._body = json.dumps(body).encode('utf-8')
        self.status = status

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_opener(script):
    """script: 每次调用弹出一项：('ok', body) 或 ('http', code, body)。记录收到的请求。"""
    calls = []

    def opener(req, timeout=None):
        calls.append({'method': req.get_method(), 'url': req.full_url, 'auth': req.get_header('Authorization'),
                      'body': json.loads(req.data.decode('utf-8')) if req.data else None})
        kind = script.pop(0)
        if kind[0] == 'ok':
            return _Resp(kind[1])
        raise urllib.error.HTTPError(req.full_url, kind[1], 'err', {}, _io.BytesIO(json.dumps(kind[2]).encode('utf-8')))
    opener.calls = calls
    return opener


class TypeSafeAskTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ts-ask-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home'
        (self.home / '.typesafe').mkdir(parents=True)
        self.skill = Path(self.temp.name) / 'skill'
        (self.skill / 'scripts').mkdir(parents=True)
        self._home = unittest.mock.patch.object(Path, 'home', return_value=self.home)
        self._home.start()
        self.addCleanup(self._home.stop)
        self._env = unittest.mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        for var in ('TYPESAFE_API_KEY', 'TYPESAFE_ENV_FILE', 'TYPESAFE_BASE_URL'):
            os.environ.pop(var, None)

    def run_cli(self, argv, opener=None):
        buf = _io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = typesafe_ask.main(argv, opener=opener)
        return code, json.loads(buf.getvalue())

    def test_key_lookup_order_and_env_file_parsing(self):
        script_dir = self.skill / 'scripts'
        self.assertEqual(typesafe_ask.find_key(None, {}, script_dir)[0], None)
        (self.skill / '.env').write_text('export TYPESAFE_API_KEY="skill-key"\n', encoding='utf-8')
        self.assertEqual(typesafe_ask.find_key(None, {}, script_dir)[:2], ('skill-key', (self.skill / '.env').as_posix()))
        (self.home / '.claude/skills/unattended-run').mkdir(parents=True)
        (self.home / '.claude/skills/unattended-run/.env').write_text("TYPESAFE_API_KEY='installed-key'\n", encoding='utf-8')
        self.assertEqual(typesafe_ask.find_key(None, {}, script_dir)[0], 'installed-key')
        (self.home / '.typesafe/.env').write_text('# comment\n\nTYPESAFE_API_KEY=global-key\nOTHER=x\n', encoding='utf-8')
        self.assertEqual(typesafe_ask.find_key(None, {}, script_dir)[0], 'global-key')
        custom = Path(self.temp.name) / 'custom.env'
        custom.write_text('TYPESAFE_API_KEY=custom-key\n', encoding='utf-8')
        self.assertEqual(typesafe_ask.find_key(None, {'TYPESAFE_ENV_FILE': str(custom)}, script_dir)[0], 'custom-key')
        self.assertEqual(typesafe_ask.find_key(None, {'TYPESAFE_API_KEY': 'env-key', 'TYPESAFE_ENV_FILE': str(custom)}, script_dir)[:2],
                         ('env-key', 'env:TYPESAFE_API_KEY'))
        self.assertEqual(typesafe_ask.find_key('explicit', {'TYPESAFE_API_KEY': 'env-key'}, script_dir)[0], 'explicit')
        (self.home / '.typesafe/.env').write_text('TYPESAFE_API_KEY=\n', encoding='utf-8')
        self.assertEqual(typesafe_ask.find_key(None, {}, script_dir)[0], 'installed-key')

    def test_missing_key_is_skipped_exit_2_and_never_calls_network(self):
        opener = fake_opener([])
        code, out = self.run_cli(['check'], opener)
        self.assertEqual((code, out['status']), (2, 'skipped'))
        self.assertIn('.typesafe/.env', ''.join(out['searched']))
        code, out = self.run_cli(['run', 'edge', '--state-json', '{"edge": {"scene": "s", "trigger": "t", "expect": "e"}}'], opener)
        self.assertEqual((code, out['status']), (2, 'skipped'))
        self.assertEqual(opener.calls, [])
        code, out = self.run_cli(['run', 'edge', '--dry', '--state-json', '{"edge": {"scene": "s"}}'], opener)
        self.assertEqual((code, out['status']), (0, 'dry'))
        self.assertEqual(sorted(out['questions']), ['executable', 'likelihood', 'severity'])

    def test_every_template_builds_and_rejects_missing_keys(self):
        code, out = self.run_cli(['templates'])
        self.assertEqual(code, 0)
        self.assertEqual(sorted(out), sorted(typesafe_ask.TEMPLATES))
        for name, spec in typesafe_ask.TEMPLATES.items():
            with self.assertRaises(ValueError, msg=name):
                spec[0]({})
        q = typesafe_ask.t_coverage({'acceptance': 'a', 'edges': {'E-01': {}, 'E-07': {}}})
        self.assertEqual(sorted(q), ['covered_E-01', 'covered_E-07'])
        q = typesafe_ask.t_review({'diff': 'd', 'claims': {'c1': 'x'}})
        self.assertEqual(q['claim_c1']['type'], 'choice')
        self.assertEqual(sorted(q['claim_c1']['criteria']), ['absent', 'contradicts', 'supports'])
        q = typesafe_ask.t_module({'capability': 'c', 'modules': {'M1': 'r', 'M2': 's'}})
        self.assertEqual(sorted(q['owner']['criteria']), ['M1', 'M2', 'none'])
        big = {'prompt': 'x' * (typesafe_ask.MAX_STATE_CHARS + 10)}
        code, out = self.run_cli(['run', 'prompt', '--dry', '--state-json', json.dumps(big)])
        self.assertEqual((code, out['status']), (5, 'error'))

    def test_run_posts_template_interprets_answers_and_logs(self):
        (self.home / '.typesafe/.env').write_text('TYPESAFE_API_KEY=global-key\n', encoding='utf-8')
        opener = fake_opener([('ok', {'model': 'jev-1.13.0', 'usage': {'input_tokens': 10, 'output_tokens': 2}, 'answers': {
            'sound': {'type': 'noul', 'noul': 0.9}, 'covered': {'type': 'noul', 'noul': 0.2}, 'irreversible': {'type': 'noul', 'noul': 0.5},
            'pick': {'type': 'choice', 'choice': 'B', 'probabilities': {'A': 0.3, 'B': 0.7}, 'confidence': 0.4}}})])
        log = Path(self.temp.name) / 'docs/_run/judgments.jsonl'
        code, out = self.run_cli(['--log', str(log), '--label', 'decision-3', 'run', 'decision', '--ruling', 'A', '--state-json',
                                  '{"requirement": "secret-requirement", "question": "q", "options": {"A": "a", "B": "b"}}'], opener)
        self.assertEqual((code, out['status']), (0, 'ok'))
        call = opener.calls[0]
        self.assertEqual((call['method'], call['auth']), ('POST', 'Bearer global-key'))
        self.assertTrue(call['url'].endswith('/v1/systemone'))
        self.assertEqual(call['body']['model'], 'jev-latest')
        self.assertEqual(sorted(call['body']['questions']), ['covered', 'irreversible', 'pick', 'sound'])
        v = out['verdicts']
        self.assertEqual((v['sound']['verdict'], v['covered']['verdict'], v['irreversible']['verdict']), ('yes', 'no', 'unsure'))
        self.assertEqual((v['pick']['choice'], v['pick']['band']), ('B', 'low'))
        self.assertEqual(v['agreement'], {'ruling': 'A', 'typesafe': 'B', 'agree': False, 'band': 'low'})
        self.assertIn('agree=NO', out['line'])
        self.assertIn('pick=B(low 0.40)', out['line'])
        self.assertEqual(out['key_source'], (self.home / '.typesafe/.env').as_posix())
        raw = log.read_text(encoding='utf-8')
        record = json.loads(raw.strip())
        self.assertEqual((record['template'], record['model'], record['label']), ('decision', 'jev-1.13.0', 'decision-3'))
        self.assertNotIn('global-key', raw)
        self.assertNotIn('secret-requirement', raw)

    def test_rate_limit_retries_then_succeeds_and_401_is_error(self):
        os.environ['TYPESAFE_API_KEY'] = 'env-key'
        opener = fake_opener([('http', 429, {'error': 'slow down'}),
                              ('ok', {'model': 'jev-1.13.0', 'answers': {'placeholder': {'type': 'noul', 'noul': 0.1}}})])
        with unittest.mock.patch.object(typesafe_ask.time, 'sleep') as sleep:
            code, out = self.run_cli(['run', 'prompt', '--state-json', '{"prompt": "p"}'], opener)
        self.assertEqual((code, out['status']), (0, 'ok'))
        self.assertEqual(len(opener.calls), 2)
        self.assertTrue(sleep.called)
        opener = fake_opener([('http', 401, {'error': 'bad key'})])
        code, out = self.run_cli(['check'], opener)
        self.assertEqual((code, out['status'], out['http']), (3, 'error', 401))
        opener = fake_opener([('ok', {'models': [{'name': 'jev-latest'}, {'name': 'jev-preview'}]})])
        code, out = self.run_cli(['check'], opener)
        self.assertEqual((code, out['models']), (0, ['jev-latest', 'jev-preview']))
        self.assertEqual(opener.calls[0]['method'], 'GET')

    def test_cjk_state_gets_language_warning_but_still_runs(self):
        os.environ['TYPESAFE_API_KEY'] = 'env-key'
        zh = {'requirement': '前端没人，能跑就行，几十个人用', 'question': '用 React 还是服务端渲染', 'options': {'A': 'React 单页', 'B': '服务端模板'}}
        self.assertGreater(typesafe_ask.cjk_ratio(zh), typesafe_ask.CJK_WARN_RATIO)
        code, out = self.run_cli(['run', 'decision', '--dry', '--state-json', json.dumps(zh, ensure_ascii=False)])
        self.assertEqual((code, out['status']), (0, 'dry'))
        self.assertIn('language_warning', out)
        answers = {'sound': {'type': 'noul', 'noul': 0.9}, 'covered': {'type': 'noul', 'noul': 0.1}, 'irreversible': {'type': 'noul', 'noul': 0.1},
                   'pick': {'type': 'choice', 'choice': 'B', 'probabilities': {'A': 0.1, 'B': 0.9}, 'confidence': 0.9}}
        opener = fake_opener([('ok', {'model': 'jev-1.13.0', 'answers': answers})])
        code, out = self.run_cli(['run', 'decision', '--state-json', json.dumps(zh, ensure_ascii=False)], opener)
        self.assertEqual((code, out['status']), (0, 'ok'))
        self.assertIn('language_warning', out)
        self.assertIn('[lang: CJK state, prefer English]', out['line'])
        en = {'requirement': 'No frontend developer; it just needs to run; a few dozen users', 'question': 'React or server-rendered templates', 'options': {'A': 'React SPA', 'B': 'server templates'}}
        self.assertEqual(typesafe_ask.cjk_ratio(en), 0.0)
        opener = fake_opener([('ok', {'model': 'jev-1.13.0', 'answers': answers})])
        code, out = self.run_cli(['run', 'decision', '--state-json', json.dumps(en)], opener)
        self.assertNotIn('language_warning', out)
        self.assertNotIn('[lang:', out['line'])

    def test_installer_ships_the_asker(self):
        self.assertIn('typesafe_ask.py', install_project.RUNTIME)
        doc = fixture(Path(self.temp.name) / 'proj')
        with contextlib.redirect_stdout(_io.StringIO()):
            install_project.install(doc, root=Path(self.temp.name) / 'proj')
        self.assertTrue((doc / '_run/typesafe_ask.py').is_file())


class TypeSafeSecondOpinionPromptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    browser = routing.PromptRoutingTests.browser
    run_node = routing.PromptRoutingTests.run_node

    def test_review_and_wrapup_carry_optional_typesafe_check_for_every_project(self):
        payload = routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})
        result = self.browser(payload)
        review = result['tasks']['M1-T2']['compiled']['review']
        self.assertIn('TypeSafe 复核（可选，第二意见不替代上面任何一步）', review)
        self.assertIn('_run/typesafe_ask.py', review)
        self.assertIn('run review --state', review)
        self.assertIn('TS_CHECK 行写 skipped', review)
        self.assertLess(review.index('反造假扫描'), review.index('TypeSafe 复核'))
        self.assertLess(review.index('TypeSafe 复核'), review.index('## 分级'))
        wrapup = result['pure0']
        self.assertIn('run coverage --state', wrapup)
        self.assertLess(wrapup.index('查五类接缝'), wrapup.index('run coverage'))
        self.assertLess(wrapup.index('run coverage'), wrapup.index('4. 找到 bug'))
        self.assertNotIn('TypeSafe 复核', result['tasks']['M1-T2']['compiled']['implementation'])



if __name__ == '__main__':
    unittest.main()
