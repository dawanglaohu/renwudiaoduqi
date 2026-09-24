"""P5: adjacent-batch gate, truthful prompt evidence, reader and landing entrypoints."""
from html.parser import HTMLParser
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_prompt_routing as routing
import test_release_1_3 as release13


GATE_VIEW = r"""
const fs = require('node:fs'), vm = require('node:vm');
const x = JSON.parse(fs.readFileSync(0, 'utf8'));
x.payload.index = {tasks: Object.fromEntries(x.payload.data.tasks.map(t => [t.id, t])), edges: {}, modules: {}};
const c = {D:x.payload, DT:x.payload.data, PR:x.payload.pres, C:{},
  window:{PROGRESS:x.progress || {}, MAINTENANCE:x.maintenance || {pendingTasks:[], needsReview:[]}, innerWidth:1000},
  localStorage:{getItem:() => null, setItem:() => {}},
  card:{dataset:{}, style:{}, innerHTML:'', hidden:true}};
vm.createContext(c, {codeGeneration:{strings:false, wasm:false}});
for (const source of [x.esc, x.core, x.hand, x.entry, x.card]) vm.runInContext(source, c, {timeout:5000});
const tasks = {};
for (const t of x.payload.data.tasks) {
  c.showCardAt(0, 0, t.id);
  tasks[t.id] = {locked:c.implLocked(t.id), block:c.wrapupBlocked(t.id), waiting:c.waitingOn(t),
    title:c.implLockTitle(t.id), popup:c.card.innerHTML};
}
process.stdout.write(JSON.stringify({tasks, hand:c.handBody(), entry:c.C.handoff(),
  dispatchable:c.dispatchable().map(t => t.id), bugAll:c.buildBugAll(), kickoff:c.buildKickoff()}));
"""


class Buttons(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.impl = {}
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'button' and attrs.get('data-kind') == 'impl':
            self.impl[attrs['data-task']] = attrs


class WrapupGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def payload(self):
        return routing.payload_for('M1-T1', 'M1-T2', deps={'M1-T2': ['M1-T1']})

    def record(self, verdict='clean', tasks=None, date='2026-09-18', batch=1):
        return {'tasks': tasks or ['M1-T1'], 'verdict': verdict, 'date': date, 'batch': batch}

    def view(self, payload=None, progress=None, maintenance=None):
        html = self.html
        return self.run_node(['node', '-e', GATE_VIEW], {
            'payload': payload if payload is not None else self.payload(), 'core': self.core,
            'progress': progress if progress is not None else {'M1-T1': 'done'},
            'maintenance': maintenance,
            'esc': html[html.index('var esc = function'):html.index('\n', html.index('var esc = function'))],
            'card': html[html.index('function showCardAt('):html.index('function showCard(el, id)')],
            'hand': html[html.index('function handBody(){'):html.index('/* ── 并行窗口调度的渲染 ── */')],
            'entry': html[html.index('C.handoff = function(){'):html.index('/* 交接台整页：')],
        })

    def test_default_on_blocks_dispatch_and_copy_without_changing_progress(self):
        result = self.view()
        task = result['tasks']['M1-T2']
        self.assertTrue(task['locked'])
        self.assertEqual(task['block'], {'batch': 1, 'verdict': None})
        self.assertEqual(task['waiting'], [])
        self.assertEqual(result['dispatchable'], [])
        copied = self.browser(self.payload(), progress={'M1-T1': 'done'},
                              actions=[{'kind': 'impl', 'id': 'M1-T2'}])
        self.assertEqual(copied['copied'], [])
        self.assertEqual(copied['local'], {})
        self.assertEqual(copied['writes'], 0)
        self.assertEqual(copied['tasks']['M1-T2']['implementation'], '')

    def test_clean_and_fixed_unlock_but_open_stays_locked(self):
        for verdict in ('clean', 'fixed', 'open'):
            with self.subTest(verdict=verdict):
                payload = self.payload()
                payload['batchRecords'] = {'record': self.record(verdict)}
                result = self.view(payload)
                self.assertEqual(result['tasks']['M1-T2']['locked'], verdict == 'open')
                self.assertEqual(result['dispatchable'], [] if verdict == 'open' else ['M1-T2'])
                if verdict == 'open':
                    self.assertEqual(result['tasks']['M1-T2']['block'], {'batch': 1, 'verdict': 'open'})
                    self.assertIn('收口有遗留', result['tasks']['M1-T2']['title'])
                else:
                    self.assertIsNone(result['tasks']['M1-T2']['block'])
                    self.assertNotIn('下一批的实施因此上锁', result['hand'])

    def test_only_explicit_false_disables_gate(self):
        for value in (False, True, None, 0, 'false'):
            with self.subTest(value=value):
                payload = self.payload()
                payload['pres']['handoff']['wrapupGate'] = value
                result = self.view(payload)
                self.assertEqual(result['tasks']['M1-T2']['locked'], value is not False)
                if value is False:
                    self.assertIsNone(result['tasks']['M1-T2']['block'])
                    self.assertNotIn('下一批的实施因此上锁', result['hand'])
                    self.assertIn('尚未收口', result['hand'])

    def test_record_bound_skip_unlocks_only_one_open_batch_and_expires(self):
        payload = routing.payload_for('M1-T1', 'M1-T2', 'M1-T4',
                                      deps={'M1-T2': ['M1-T1'], 'M1-T4': ['M1-T2']})
        payload['batchRecords'] = {'first-open': self.record('open')}
        payload['pres']['handoff']['wrapupGateSkipRecords'] = {'1': 'first-open'}

        first = self.view(payload, {'M1-T1': 'done'})
        self.assertFalse(first['tasks']['M1-T2']['locked'])
        self.assertIsNone(first['tasks']['M1-T2']['block'])
        self.assertEqual(first['dispatchable'], ['M1-T2'])
        self.assertIn('闸门已跳过', first['hand'])
        self.assertNotIn('下一批的实施因此上锁', first['hand'])

        second = self.view(payload, {'M1-T1': 'done', 'M1-T2': 'done'})
        self.assertEqual(second['tasks']['M1-T4']['block'], {'batch': 2, 'verdict': None})

        payload['batchRecords']['second-open'] = self.record('open', tasks=['M1-T2'], batch=2)
        payload['pres']['handoff']['wrapupGateSkipRecords']['2'] = 'second-open'
        del payload['pres']['handoff']['wrapupGateSkipRecords']['1']
        scoped = self.view(payload, {'M1-T1': 'done', 'M1-T2': 'done'})
        self.assertFalse(scoped['tasks']['M1-T4']['locked'])
        self.assertNotIn('下一批的实施因此上锁', scoped['hand'])
        del payload['batchRecords']['second-open']
        del payload['pres']['handoff']['wrapupGateSkipRecords']['2']
        payload['pres']['handoff']['wrapupGateSkipRecords']['1'] = 'first-open'

        payload['batchRecords']['later-open'] = self.record('open', date='2026-09-19')
        expired = self.view(payload, {'M1-T1': 'done'})
        self.assertEqual(expired['tasks']['M1-T2']['block'], {'batch': 1, 'verdict': 'open'})

        del payload['batchRecords']['later-open']
        payload['pres']['handoff']['wrapupGateSkipRecords'] = {'1': 'wrong-record'}
        invalid = self.view(payload, {'M1-T1': 'done'})
        self.assertTrue(invalid['tasks']['M1-T2']['locked'])

    def test_unlanded_predecessor_is_dependency_block_and_first_batch_is_free(self):
        result = self.view(progress={})
        self.assertFalse(result['tasks']['M1-T1']['locked'])
        self.assertIsNone(result['tasks']['M1-T1']['block'])
        self.assertTrue(result['tasks']['M1-T2']['locked'])
        self.assertEqual(result['tasks']['M1-T2']['waiting'], ['M1-T1'])
        self.assertIsNone(result['tasks']['M1-T2']['block'])
        self.assertNotIn('尚未收口', result['tasks']['M1-T2']['title'])

    def test_gate_checks_only_adjacent_batch_and_only_when_whole_batch_lands(self):
        payload = routing.payload_for('M1-T1', 'M1-T2', 'M1-T3', 'M1-T4',
                                     deps={'M1-T2': ['M1-T1'], 'M1-T3': ['M1-T1'], 'M1-T4': ['M1-T2']})
        # An unlanded sibling keeps the prior layer incomplete; it is not a task prerequisite.
        result = self.view(payload, {'M1-T1': 'done', 'M1-T2': 'done'})
        self.assertFalse(result['tasks']['M1-T4']['locked'])
        self.assertIsNone(result['tasks']['M1-T4']['block'])
        payload['batchRecords'] = {'second': self.record(tasks=['M1-T2', 'M1-T3'], batch=99)}
        result = self.view(payload, {'M1-T1': 'done', 'M1-T2': 'done', 'M1-T3': 'done'})
        self.assertFalse(result['tasks']['M1-T4']['locked'])
        self.assertIsNone(result['tasks']['M1-T4']['block'])
        del payload['batchRecords']
        result = self.view(payload, {'M1-T1': 'done', 'M1-T2': 'done', 'M1-T3': 'done'})
        self.assertEqual(result['tasks']['M1-T4']['block'], {'batch': 2, 'verdict': None})

    def test_latest_matching_task_set_controls_gate_not_batch_number(self):
        payload = self.payload()
        payload['batchRecords'] = {
            'old': self.record(date='2026-09-16', batch=77),
            'new': self.record('open', date='2026-09-17', batch=88),
            'wrong-set': self.record(tasks=['M1-T2']),
        }
        self.assertTrue(self.view(payload)['tasks']['M1-T2']['locked'])
        payload['batchRecords']['last'] = self.record('fixed', batch=999)
        self.assertFalse(self.view(payload)['tasks']['M1-T2']['locked'])

    def test_revalidation_remains_landed_and_maintenance_lock_is_preserved(self):
        payload = self.payload()
        payload['batchRecords'] = {'record': self.record()}
        result = self.view(payload, maintenance={'pendingTasks': [], 'needsReview': ['M1-T1']})
        self.assertFalse(result['tasks']['M1-T2']['locked'])
        self.assertEqual(result['tasks']['M1-T2']['waiting'], [])
        result = self.view(payload, maintenance={'pendingTasks': ['M1-T2'], 'needsReview': []})
        self.assertTrue(result['tasks']['M1-T2']['locked'])
        self.assertIsNone(result['tasks']['M1-T2']['block'])

    def test_row_and_popup_titles_preserve_quoted_config_and_notice_on_both_surfaces(self):
        for verdict in (None, 'open'):
            payload = self.payload()
            if verdict:
                payload['batchRecords'] = {'record': self.record(verdict)}
            result = self.view(payload)
            title = result['tasks']['M1-T2']['title']
            for html in (result['hand'], result['tasks']['M1-T2']['popup']):
                button = Buttons(html).impl['M1-T2']
                self.assertIn('disabled', button)
                self.assertEqual(button['title'], title)
                self.assertIn('"wrapupGate": false', button['title'])
                self.assertNotIn('wrapupgate":', button)
            for html in (result['hand'], result['entry']):
                self.assertIn('<b>下一批的实施因此上锁</b>', html)
            self.assertIn('紧邻上一批落齐时须收口', result['hand'])

    def test_review_contains_six_blockers_before_appendix_and_names_scan_locations(self):
        for frontend in (False, True):
            payload = self.payload()
            payload['pres']['handoff'].update(frontendModules=['M1'] if frontend else [],
                                               architecture={'shared': {'types': 'keep appendix'}})
            text = self.browser(payload)['tasks']['M1-T2']['compiled']['review']
            self.assertIn(('9' if frontend else '8') + '. 反造假扫描', text)
            scan = text.split('反造假扫描：', 1)[1].split('\n', 1)[0]
            for needle in ('①', '②', '③', '④', '⑤', '⑥',
                           'not implemented|placeholder|stub|TODO|待接入|后续接入',
                           '硬编码 `true`/固定值', '注册表', '前置代码位置', '类型 / 枚举 / 工具',
                           'computed style', '默认控件外观', 'window.__x', 'globalThis.__x'):
                self.assertIn(needle, scan)
            grading = text.split('## 分级', 1)[1].split('## 结论', 1)[0]
            for needle in ('占位/桩', '硬编码', '注册表', '前置已有', 'GIF 样式未加载', '测试钩子'):
                self.assertIn(needle, grading)
            self.assertIn('造假类阻断写明扫描命中位置', text)
            self.assertLess(text.index('反造假扫描'), text.index('## 分级'))
            self.assertLess(text.index('## 输出格式'), text.index('## 附录'))

    def test_bug_batch_and_kickoff_prompts_include_new_evidence_requirements(self):
        payload = self.payload()
        view = self.view(payload)
        browser = self.browser(payload)
        for text in (browser['tasks']['M1-T2']['compiled']['bug'], view['bugAll']):
            self.assertIn('占位与桩扫描', text)
            for needle in ('not implemented|placeholder|stub|TODO|待接入|后续接入',
                           '硬编码 `true`/固定值', '注册表', 'window.__x', 'globalThis.__x'):
                self.assertIn(needle, text)
        wrapup = browser['pure0']
        for needle in ('端到端冒烟', '真起服务', '真浏览器打开首页', '断言样式已加载',
                       'computed style', '主流程', '没有这条冒烟就记 NOT_FIXED 标 doc-issue'):
            self.assertIn(needle, wrapup)
        self.assertLess(wrapup.index('跑现有全部测试'), wrapup.index('端到端冒烟'))
        self.assertLess(wrapup.index('端到端冒烟'), wrapup.index('2. 逐任务'))
        self.assertIn('一批全部落地后先收口再派下一批；交接台默认上锁', view['kickoff'])

    def test_pure_export_remains_available_and_independent_of_gate_progress_and_records(self):
        payload = self.payload()
        baseline = self.run_node(['node', str(routing.RUN / 'compile_prompts.js')],
                                 {'payload': payload, 'core': self.compiler_core({}, {})})
        payload['progress'] = {'M1-T1': 'done'}
        payload['batchRecords'] = {'record': self.record('open')}
        payload['pres']['handoff']['wrapupGate'] = False
        exported = self.run_node(['node', str(routing.RUN / 'compile_prompts.js')],
                                 {'payload': payload, 'core': self.compiler_core({}, {})})
        self.assertEqual(baseline, exported)
        self.assertIn('# 实现任务 M1-T2', exported['tasks']['M1-T2']['implementation'])


class LandingGateTests(unittest.TestCase):
    setUp = release13.BatchWrapupTests.setUp
    run_build = release13.BatchWrapupTests.run_build
    state = release13.BatchWrapupTests.state
    verify_task = release13.BatchWrapupTests.verify_task
    land = release13.BatchWrapupTests.land
    write_record = release13.BatchWrapupTests.write_record
    batches_cli = release13.BatchWrapupTests.batches_cli

    def prepare(self, gate=True):
        path = self.doc / '_run/presentation.json'
        if gate is False:
            pres = release13.hc.read_json(path)
            pres['handoff']['wrapupGate'] = False
            release13.hc.write_json(path, pres)
        source = release13.hc.source_file(self.doc, 19)[0]
        text = source.read_text(encoding='utf-8').replace(
            '| M1-T3 | 校验第3组字符串长度 | M1 | 无 |',
            '| M1-T3 | 校验第3组字符串长度 | M1 | M1-T1、M1-T2 |')
        source.write_text(text, encoding='utf-8')
        self.run_build()
        for tid in ('M1-T1', 'M1-T2'):
            self.verify_task(tid)

    def test_mark_landed_reads_gate_and_latest_record_from_fixture(self):
        self.prepare()
        self.assertNotIn('上锁', self.land('M1-T1'))
        self.assertIn('wrapupGate 开启时下一批的实施已上锁', self.land('M1-T2'))
        self.write_record(tasks='M1-T1, M1-T2', verdict='open')
        result = self.batches_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        out = self.land('M1-T2')
        self.assertIn('收口有遗留', out)
        self.assertIn('上锁', out)
        self.write_record('later', tasks='M1-T2, M1-T1', date='2026-09-02', verdict='fixed')
        result = self.batches_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('上锁', self.land('M1-T2'))

    def test_mark_landed_opt_out_preserves_reminder_without_lock_claim(self):
        self.prepare(gate=False)
        out = self.land('M1-T1', 'M1-T2')
        self.assertIn('尚未收口', out)
        self.assertNotIn('上锁', out)
        self.write_record(tasks='M1-T1, M1-T2', verdict='open')
        self.assertNotIn('尚未收口', self.land('M1-T2'))

    def test_mark_landed_reports_record_bound_skip_without_claiming_fix(self):
        self.prepare()
        self.land('M1-T1', 'M1-T2')
        self.write_record(tasks='M1-T1, M1-T2', verdict='open')
        pres_path = self.doc / '_run/presentation.json'
        pres = release13.hc.read_json(pres_path)
        pres['handoff']['wrapupGateSkipRecords'] = {'1': 'batch-1-20260901'}
        release13.hc.write_json(pres_path, pres)
        result = self.batches_cli()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.run_build()
        out = self.land('M1-T2')
        self.assertIn('当前 open 记录已定点跳过闸门；返工仍待处理', out)
        self.assertNotIn('下一批的实施已上锁', out)


if __name__ == '__main__':
    unittest.main()
