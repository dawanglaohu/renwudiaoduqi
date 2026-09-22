"""Jev 最终裁决与批次收口返工任务的 1.6 回归。"""
import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_release_1_3 as release13
import test_prompt_routing as routing

import build_docs
import handoff_contract as hc
import maintain_docs as maintenance
import typesafe_ask
import install_project


TASK = """```task
stable-key: api-timeout-retry
title: 修复超时重试并从真实入口返回成功
module: M1
source-tasks: M1-T1, M1-T2
depends-on: M1-T1, M1-T2
input: 收口复现日志与原任务接口
output: src/task-1.ts, test/task-1.test.ts
acceptance: 1) 超时后只重试一次 2) 回归测试失败前红、修复后绿 3) 真实入口通过
edges: E-01, E-04
paths: src/task-1.ts, test/task-1.test.ts
estimate: 1d
severity: S2
jev: adjudicate: pick=A(high 0.91) adopt=take(A); model=jev-1.13.0
```"""


class AdjudicationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def test_all_four_s7_prompts_and_ui_route_to_jev(self):
        payload = routing.payload_for('M1-T1')
        payload['pres']['handoff']['frontendModules'] = ['M1']
        payload['pres']['handoff']['design'] = {'register': 'product_workbench', 'tokens': '--ink:#111;'}
        result = self.browser(payload)
        compiled = result['tasks']['M1-T1']['compiled']
        for kind in ('implementation', 'review', 'bug'):
            self.assertIn('交 Jev，不交用户', compiled[kind])
            self.assertIn('run adjudicate', compiled[kind])
            self.assertIn('UI/UX', compiled[kind])
            self.assertIn('换成 design', compiled[kind])
            self.assertIn('skipped/error', compiled[kind])
        self.assertNotIn('被架构约定挡住（照约定做不到、只能违反 06/08 节才能完成）才停下',
                         compiled['implementation'])
        wrapup = result['pure0']
        self.assertIn('交 Jev，不交用户', wrapup)
        self.assertIn('TASKS', wrapup)
        self.assertIn('```task', wrapup)
        self.assertIn('stable-key:', wrapup)
        self.assertNotIn('doc-issue / 要用户决定 /', wrapup)
        self.assertIn('ADJUDICATION', compiled['review'])

    def test_adopt_uses_low_confidence_pick_and_only_owner_is_red_line(self):
        low = {'pick': {'choice': 'B', 'band': 'low'}, 'needs_owner': {'verdict': 'no'},
               'spec_change': {'verdict': 'no'}, 'outside_stack': {'verdict': 'no'}}
        self.assertEqual(typesafe_ask.adopt_rule('adjudicate', low)['option'], 'B')
        self.assertEqual(typesafe_ask.adopt_rule('adjudicate', low)['action'], 'take')
        low['needs_owner'] = {'verdict': 'yes'}
        self.assertEqual(typesafe_ask.adopt_rule('adjudicate', low)['action'], 'red_line')
        with self.assertRaises(ValueError):
            typesafe_ask.t_adjudicate({'requirement': 'r', 'task': {}, 'conflict': 'c', 'options': {'A': 'only'}})

    def test_release_installs_its_regression_and_reports_1_6(self):
        self.assertEqual(hc.VERSION, '1.6.0')
        self.assertIn('test_release_1_6_adjudication.py', install_project.TESTS)
        self.assertEqual(len(typesafe_ask.TEMPLATES), 13)

    def test_adjudicate_cli_emits_final_adopt_and_rejects_invalid_pick(self):
        state = json.dumps({'requirement': 'Keep the documented behavior',
                            'task': {'title': 'Repair retry', 'accept': 'One retry'},
                            'conflict': 'The current retry loops forever',
                            'options': {'A': 'Disable retries', 'B': 'Retry once'}})
        base = {'pick': {'type': 'choice', 'choice': 'B', 'probabilities': {'A': 0.4, 'B': 0.6}, 'confidence': 0.2},
                'spec_change': {'type': 'noul', 'noul': 0.1}, 'outside_stack': {'type': 'noul', 'noul': 0.1},
                'needs_owner': {'type': 'noul', 'noul': 0.1}, 'reversible': {'type': 'noul', 'noul': 0.9}}

        def run(answers):
            buf = io.StringIO()
            with unittest.mock.patch.object(typesafe_ask, 'find_key', return_value=('key', 'test', [])), \
                    unittest.mock.patch.object(typesafe_ask, 'run_request', return_value=(200, {'model': 'jev-test', 'answers': answers}, {})), \
                    contextlib.redirect_stdout(buf):
                code = typesafe_ask.main(['run', 'adjudicate', '--state-json', state])
            return code, json.loads(buf.getvalue())

        code, out = run(base)
        self.assertEqual((code, out['status']), (0, 'ok'))
        self.assertEqual(out['verdicts']['adopt']['option'], 'B')
        self.assertEqual(out['verdicts']['adopt']['confidence'], 'low')
        self.assertIn('adopt=take(B)', out['line'])
        unsure = dict(base, needs_owner={'type': 'noul', 'noul': 0.5})
        code, out = run(unsure)
        self.assertEqual(out['verdicts']['adopt']['action'], 'red_line')
        invalid = dict(base, pick={'type': 'choice', 'choice': 'Z', 'probabilities': {'Z': 1.0}, 'confidence': 1.0})
        code, out = run(invalid)
        self.assertEqual((code, out['status']), (4, 'error'))


class RepairTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        routing.PromptRoutingTests.setUpClass.__func__(cls)

    run_node = routing.PromptRoutingTests.run_node
    browser = routing.PromptRoutingTests.browser

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-1-6-')
        self.base = Path(self.temp.name) / 'proj'
        self.base.mkdir()
        self.doc = release13.fixture(self.base)
        self.addCleanup(self.temp.cleanup)

    def record(self, name, body=TASK, date='2026-09-21', batch=1):
        d = self.doc / '_run/batches'
        d.mkdir(exist_ok=True)
        text = release13.RECORD.format(batch=batch, tasks='M1-T1, M1-T2, M1-T3', date=date, verdict='open')
        text = text.replace('\n---\n\n## 交付了什么', '\nrepair_schema: 1\n---\n\n## 交付了什么', 1)
        (d / (name + '.md')).write_text(text + '\n## 返工任务\n\n' + body + '\n', encoding='utf-8')

    def build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.build(self.doc)

    def payload(self):
        text = (self.doc / 'docs-data.js').read_text(encoding='utf-8')
        return json.loads(text[len('window.DOCS = '):].strip().rstrip(';'))

    def test_open_record_generates_stable_todo_task_and_dispatch(self):
        self.record('batch-1-first')
        self.build()
        payload = self.payload()
        repairs = payload['repairTasks']
        self.assertEqual(len(repairs), 1)
        task = repairs[0]
        self.assertRegex(task['id'], r'^R1-T\d{8}$')
        self.assertTrue(next(t for t in payload['data']['tasks'] if t['id'] == task['id'])['repair'])
        self.assertEqual(payload['progress'].get(task['id']), None)
        self.assertIn(task['id'], payload['dispatch'])
        self.assertIn('修复超时重试', payload['dispatch'][task['id']]['implementation'])
        note = self.doc / '图谱/任务' / (task['id'] + '.md')
        self.assertTrue(note.exists())
        self.assertIn('status: todo', note.read_text(encoding='utf-8'))
        self.assertIn('api-timeout-retry', note.read_text(encoding='utf-8'))
        self.assertEqual(payload['dispatchBatches']['0']['tasks'], ['M1-T1', 'M1-T2', 'M1-T3'])

    def test_repair_row_is_dispatchable_without_reopening_original_batch(self):
        self.record('batch-1-first')
        self.build()
        payload = self.payload()
        tid = payload['repairTasks'][0]['id']
        completed = {t['id']: 'done' for t in payload['data']['tasks'] if not t.get('repair')}
        browser = self.browser(payload, progress=completed)
        self.assertFalse(browser['tasks'][tid]['locked'])
        self.assertIn(tid, browser['tasks'][tid]['implementation'])
        self.assertEqual(browser['tasks'][tid]['state'], 'todo')
        self.assertEqual(payload['dispatchBatches']['0']['tasks'], sorted(completed))
        js = """const fs=require('node:fs'),vm=require('node:vm');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const c={D:x.payload,DT:x.payload.data,PR:x.payload.pres,window:{PROGRESS:x.progress,MAINTENANCE:{pendingTasks:[],needsReview:[]}},
localStorage:{getItem:()=>null,setItem:()=>{}},esc:String};vm.createContext(c);
vm.runInContext(x.core,c);vm.runInContext(x.hand,c);process.stdout.write(JSON.stringify({html:c.handBody(),layers:c.batchLayers()}));"""
        html = build_docs.HTML
        hand = html[html.index('function handBody(){'):html.index('/* ── 并行窗口调度的渲染 ── */')]
        rendered = self.run_node(['node', '-e', js], {'payload': payload, 'core': self.core,
                                                     'hand': hand, 'progress': completed})
        self.assertIn('批次收口返工', rendered['html'])
        self.assertIn('data-t="' + tid + '"', rendered['html'])
        self.assertIn('data-task="' + tid + '"', rendered['html'])
        self.assertEqual(len(rendered['layers']['by']), 1)

    def test_record_matches_current_batch_by_task_set_not_batch_number(self):
        self.record('renumbered', batch=77)
        self.build()
        repair = self.payload()['repairTasks'][0]
        task = next(t for t in self.payload()['data']['tasks'] if t['id'] == repair['id'])
        self.assertEqual(repair['batch'], 77)
        self.assertEqual(task['sourceBatch'], 77)
        self.assertEqual(task['currentSourceBatch'], 1)
        self.assertEqual(task['sourceBatchTasks'], ['M1-T1', 'M1-T2', 'M1-T3'])

    def test_repair_can_be_contract_verified_and_marked_landed(self):
        self.record('batch-1-first')
        self.build()
        tid = self.payload()['repairTasks'][0]['id']
        contract = maintenance.state(self.doc)[1]['contracts'][tid]
        evidence = self.doc / '_run/repair-evidence.json'
        hc.write_json(evidence, {'scope': 'task-contract', 'tasks': {tid: {
            'contractHash': contract['hash'], 'verdict': 'pass',
            'evidence': ['收口记录的复现、有效路径、验收与原任务依赖已逐项核对。']}}})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(maintenance.verify(self.doc, type('Args', (), {'task': tid,
                              'evidence': str(evidence), 'patch': None})()), 0)
            self.assertEqual(build_docs.mark_landed(str(self.doc), [tid]), 0)
        self.assertEqual(self.payload()['progress'][tid], 'done')
        self.assertIn('status: done', (self.doc / '图谱/任务' / (tid + '.md')).read_text(encoding='utf-8'))

    def test_same_stable_key_deduplicates_and_preserves_status(self):
        self.record('batch-1-first', date='2026-09-20')
        self.record('batch-1-second', body=TASK.replace('修复超时重试', '彻底修复超时重试'), date='2026-09-21')
        self.build()
        first = self.payload()['repairTasks'][0]
        self.assertEqual(len(self.payload()['repairTasks']), 1)
        note = self.doc / '图谱/任务' / (first['id'] + '.md')
        note.write_text(note.read_text(encoding='utf-8').replace('status: todo', 'status: review'), encoding='utf-8')
        self.build()
        self.assertEqual(self.payload()['repairTasks'][0]['id'], first['id'])
        self.assertIn('status: review', note.read_text(encoding='utf-8'))
        self.assertIn('修复超时重试', note.read_text(encoding='utf-8'))
        self.assertNotIn('彻底修复超时重试', note.read_text(encoding='utf-8'))

    def test_bad_task_block_fails_instead_of_silently_disappearing(self):
        self.record('bad', body=TASK.replace('paths: src/task-1.ts, test/task-1.test.ts\n', ''))
        with self.assertRaisesRegex(ValueError, '缺字段.*paths'):
            build_docs.read_batch_records(str(self.doc))

    def test_duplicate_key_and_fake_jev_evidence_are_rejected(self):
        self.record('duplicate', body=TASK + '\n' + TASK)
        with self.assertRaisesRegex(ValueError, '重复 stable-key'):
            build_docs.read_batch_records(str(self.doc))
        (self.doc / '_run/batches/duplicate.md').unlink()
        self.record('fake-jev', body=TASK.replace('adopt=take(A); model=jev-1.13.0', 'Jev chose A'))
        with self.assertRaisesRegex(ValueError, 'model=.*adopt='):
            build_docs.read_batch_records(str(self.doc))

    def test_new_open_record_requires_tasks_while_legacy_open_is_visible(self):
        self.record('new-empty', body='none')
        with self.assertRaisesRegex(ValueError, '没有 ```task'):
            build_docs.read_batch_records(str(self.doc))
        (self.doc / '_run/batches/new-empty.md').unlink()
        d = self.doc / '_run/batches'
        (d / 'old-open.md').write_text(release13.RECORD.format(batch=1, tasks='M1-T1',
                                      date='2026-09-21', verdict='open'), encoding='utf-8')
        legacy = build_docs.read_batch_records(str(self.doc))['old-open']
        self.assertIn('旧版 open', legacy['repairWarning'])
        (d / 'old-fixed.md').write_text(release13.RECORD.format(batch=1, tasks='M1-T1',
                                       date='2026-09-22', verdict='fixed'), encoding='utf-8')
        self.assertIn('old-fixed', build_docs.read_batch_records(str(self.doc)))

    def test_schema_marks_new_open_even_if_the_section_is_omitted(self):
        d = self.doc / '_run/batches'
        d.mkdir(exist_ok=True)
        text = release13.RECORD.format(batch=1, tasks='M1-T1, M1-T2, M1-T3',
                                       date='2026-09-21', verdict='open')
        text = text.replace('\n---\n\n## 交付了什么', '\nrepair_schema: 1\n---\n\n## 交付了什么', 1)
        (d / 'schema-no-section.md').write_text(text, encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '没有 ```task'):
            build_docs.read_batch_records(str(self.doc))

    def test_record_without_tasks_keeps_legacy_shape(self):
        d = self.doc / '_run/batches'
        d.mkdir(exist_ok=True)
        (d / 'clean.md').write_text(release13.RECORD.format(batch=1, tasks='M1-T1', date='2026-09-21', verdict='clean'), encoding='utf-8')
        rec = build_docs.read_batch_records(str(self.doc))['clean']
        self.assertNotIn('repairTasks', rec)
        self.assertEqual(set(rec), {'batch', 'tasks', 'date', 'verdict', 'tests', 'pr', 'note'})

    def test_clean_record_cannot_bypass_unlanded_repair(self):
        self.record('batch-1-open', date='2026-09-20')
        d = self.doc / '_run/batches'
        (d / 'batch-1-clean.md').write_text(release13.RECORD.format(batch=1,
              tasks='M1-T1, M1-T2, M1-T3', date='2026-09-21', verdict='fixed'), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, '返工任务尚未落地'):
            build_docs.read_batch_records(str(self.doc))

    def test_same_problem_after_fixed_gets_a_new_unlanded_episode(self):
        self.record('batch-1-open-1', date='2026-09-19')
        self.build()
        first = self.payload()['repairTasks'][0]
        note = self.doc / '图谱/任务' / (first['id'] + '.md')
        note.write_text(note.read_text(encoding='utf-8').replace('status: todo', 'status: done'), encoding='utf-8')
        d = self.doc / '_run/batches'
        (d / 'batch-1-fixed.md').write_text(release13.RECORD.format(batch=1,
              tasks='M1-T1, M1-T2, M1-T3', date='2026-09-20', verdict='fixed'), encoding='utf-8')
        self.record('batch-1-open-2', date='2026-09-21')
        self.build()
        repairs = self.payload()['repairTasks']
        self.assertEqual(len(repairs), 2)
        self.assertNotEqual(repairs[0]['id'], repairs[1]['id'])
        states = {t['id']: self.payload()['progress'].get(t['id'], 'todo') for t in repairs}
        self.assertEqual(sorted(states.values()), ['done', 'todo'])
        self.assertEqual(sorted(t['episode'] for t in repairs), [1, 2])

    def test_hash_collision_between_episodes_is_rejected(self):
        self.record('batch-1-open-1', date='2026-09-19')
        (self.doc / '_run/progress.js').write_text(
            'window.PROGRESS = {"R1-T00000000":"done"};\n', encoding='utf-8')
        d = self.doc / '_run/batches'
        (d / 'batch-1-fixed.md').write_text(release13.RECORD.format(batch=1,
              tasks='M1-T1, M1-T2, M1-T3', date='2026-09-20', verdict='fixed'), encoding='utf-8')
        self.record('batch-1-open-2', date='2026-09-21')
        with unittest.mock.patch.object(build_docs, 'repair_id', return_value='R1-T00000000'):
            with self.assertRaisesRegex(ValueError, 'ID 哈希冲突'):
                build_docs.collect_repair_tasks(build_docs.read_batch_records(str(self.doc)))


if __name__ == '__main__':
    unittest.main()
