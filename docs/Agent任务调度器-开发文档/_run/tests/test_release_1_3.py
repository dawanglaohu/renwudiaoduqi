"""1.3.0 新增行为的回归：批次收口记录的解析与 --batches 就地改写、收口提示词随 dispatch 导出、
--landed 报告已全部落地尚未收口的批、Python 3.8 兼容、交接台批次按钮渲染。"""
import argparse
import contextlib
import io
import json
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


RECORD = """---
batch: {batch}
tasks: {tasks}
date: {date}
verdict: {verdict}
tests: pass
pr: none
note: 给下一批的一句
---

## 交付了什么
三个任务。
"""


class BatchWrapupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-1-3-')
        self.base = Path(self.temp.name) / 'proj'
        self.base.mkdir()
        self.doc = fixture(self.base)
        self.addCleanup(self.temp.cleanup)

    # ---- helpers ----
    def run_build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.build(self.doc)

    def state(self):
        return maintenance.state(self.doc)[1]

    def verify_task(self, task):
        item = {'scope': 'task-contract', 'tasks': {task: {'contractHash': self.state()['contracts'][task]['hash'],
                'verdict': 'pass', 'evidence': ['19 节任务条款与输入/范围/测试阶段已逐项核对；回归样例。']}}}
        path = self.doc / '_run/real-evidence.json'
        hc.write_json(path, item)
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.verify(self.doc, argparse.Namespace(task=task, evidence=str(path), patch=None))

    def land(self, *ids):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = build_docs.mark_landed(str(self.doc), list(ids))
        self.assertEqual(code, 0, buf.getvalue())
        return buf.getvalue()

    def payload(self):
        src = (self.doc / 'docs-data.js').read_text(encoding='utf-8')
        return json.loads(src[len('window.DOCS = '):].strip().rstrip(';'))

    def write_record(self, name='batch-1-20260901', batch=1, tasks='M1-T1, M1-T2, M1-T3', date='2026-09-01', verdict='clean'):
        d = self.doc / '_run/batches'
        d.mkdir(exist_ok=True)
        (d / (name + '.md')).write_text(RECORD.format(batch=batch, tasks=tasks, date=date, verdict=verdict), encoding='utf-8')

    def batches_cli(self):
        return subprocess.run([sys.executable, '-B', str(SCRIPTS / 'build_docs.py'), str(self.doc), '--batches'],
                              capture_output=True, text=True, encoding='utf-8', timeout=120)

    # ---- 记录解析 ----
    def test_read_batch_records_parses_front_matter_and_skips_invalid(self):
        self.assertEqual(build_docs.read_batch_records(str(self.doc)), {})       # 目录不存在
        self.write_record('batch-1-20260901', tasks='M1-T3、M1-T1, M1-T2, M1-T1')  # 乱序、重复、中文顿号
        self.write_record('batch-x-20260902', batch='two')                        # batch 不是整数 → 跳过
        (self.doc / '_run/batches/notes.txt').write_text('不是 md', encoding='utf-8')
        (self.doc / '_run/batches/no-front-matter.md').write_text('# 没有头\n', encoding='utf-8')
        records = build_docs.read_batch_records(str(self.doc))
        self.assertEqual(list(records), ['batch-1-20260901'])
        rec = records['batch-1-20260901']
        self.assertEqual(rec, {'batch': 1, 'tasks': ['M1-T1', 'M1-T2', 'M1-T3'], 'date': '2026-09-01',
                               'verdict': 'clean', 'tests': 'pass', 'pr': 'none', 'note': '给下一批的一句'})
        self.assertIsInstance(rec['batch'], int)

    # ---- --batches 就地改写 ----
    def test_batches_cli_rewrites_payload_and_keeps_manifest_current(self):
        self.run_build()
        self.assertEqual(self.payload()['batchRecords'], {})
        self.write_record()
        run = self.batches_cli()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('已写 docs-data.js 的 batchRecords：1 条记录', run.stdout)
        self.assertIn('batch-1-20260901：batch 1 / 2026-09-01 / clean', run.stdout)
        payload = self.payload()
        self.assertEqual(list(payload['batchRecords']), ['batch-1-20260901'])
        self.assertEqual(payload['batchRecords']['batch-1-20260901']['tasks'], ['M1-T1', 'M1-T2', 'M1-T3'])
        self.assertEqual(hc.stale_reasons(self.doc), [])                        # 清单指纹同步了
        self.verify_task('M1-T1')
        self.land('M1-T1')                                                       # 不被当成产物过期拒绝
        self.assertEqual(self.payload()['progress'], {'M1-T1': 'done'})
        self.assertEqual(list(self.payload()['batchRecords']), ['batch-1-20260901'])   # --landed 不吞掉记录
        # 重复跑不改内容也不报错；docs-data.js 不存在时提示先 build 并返回 1
        run = self.batches_cli()
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        (self.doc / 'docs-data.js').unlink()
        run = self.batches_cli()
        self.assertEqual(run.returncode, 1)
        self.assertIn('先跑', run.stdout)

    # ---- 导出 ----
    def test_full_build_exports_dispatch_batches(self):
        self.run_build()
        payload = self.payload()
        self.assertEqual(list(payload['dispatchBatches']), ['0'])
        b = payload['dispatchBatches']['0']
        self.assertEqual(set(b), {'batchNo', 'tasks', 'contractHash', 'wrapup'})
        self.assertEqual(b['batchNo'], 1)
        self.assertEqual(b['tasks'], ['M1-T1', 'M1-T2', 'M1-T3'])
        self.assertIn('# 第 1 批收口', b['wrapup'])
        self.assertIn('regression-batch-1', b['wrapup'])
        contracts = payload['handoff']['contracts']
        self.assertEqual(b['contractHash'], hc.digest(sorted([[i, contracts[i]['hash']] for i in b['tasks']])))
        dispatch = hc.read_json(self.doc / '_run/dispatch.json')
        self.assertEqual(set(dispatch), {'schemaVersion', 'sourceVersion', 'tasks', 'batches'})
        self.assertEqual(dispatch['batches'], payload['dispatchBatches'])
        self.assertEqual(set(dispatch['tasks']), {'M1-T1', 'M1-T2', 'M1-T3'})
        self.assertEqual(set(dispatch['tasks']['M1-T1']), {'contractHash', 'implementation', 'review', 'resume'})
        # 收口提示词是纯函数：落地前后、有没有记录，导出的 wrapup 都一样
        self.verify_task('M1-T1'); self.land('M1-T1')
        self.write_record()
        self.run_build()
        self.assertEqual(self.payload()['dispatchBatches']['0']['wrapup'], b['wrapup'])
        self.assertEqual(list(self.payload()['batchRecords']), ['batch-1-20260901'])

    # ---- --landed 报未收口 ----
    def test_mark_landed_reports_unwrapped_complete_batches(self):
        self.run_build()
        for tid in ('M1-T1', 'M1-T2', 'M1-T3'):
            self.verify_task(tid)
        out = self.land('M1-T1', 'M1-T2')
        self.assertNotIn('尚未收口', out)
        out = self.land('M1-T3')
        self.assertIn('第 1 批已全部落地、尚未收口', out)
        self.assertIn('M1-T1、M1-T2、M1-T3', out)
        self.write_record()
        self.batches_cli()
        out = self.land('M1-T3')                                                  # 重复落地不报错
        self.assertNotIn('尚未收口', out)
        # Python 端分层与 JS 相同：链式依赖分成三批
        layers = build_docs.task_layers([{'id': 'A', 'deps': []}, {'id': 'B', 'deps': ['A']},
                                         {'id': 'C', 'deps': ['B', 'X']}, {'id': 'D', 'deps': ['A']}])
        self.assertEqual(layers, {'A': 0, 'B': 1, 'C': 2, 'D': 1})
        cyc = build_docs.task_layers([{'id': 'A', 'deps': ['B']}, {'id': 'B', 'deps': ['A']}])
        self.assertEqual(set(cyc), {'A', 'B'})

    # ---- 3.8 兼容 ----
    def test_no_python39_only_idioms_in_build_docs(self):
        src = (SCRIPTS / 'build_docs.py').read_text(encoding='utf-8-sig')
        self.assertNotIn('removesuffix', src)
        self.assertNotIn('removeprefix', src)
        self.assertNotIn('is_relative_to', src)
        self.assertEqual(build_docs.js_payload('window.DOCS = {"a": 1};\n', 'window.DOCS = '), '{"a": 1}')
        self.assertEqual(build_docs.js_payload(' {"a": 1} ', ''), '{"a": 1}')

    # ---- 交接台渲染 ----
    def test_handbody_renders_batch_button(self):
        self.run_build()
        payload = self.payload()
        # 让 M1-T3 依赖 M1-T1、M1-T2，分成两批；第 1 批全落地，第 2 批没有
        for t in payload['data']['tasks']:
            if t['id'] == 'M1-T3':
                t['deps'] = ['M1-T1', 'M1-T2']
        html = build_docs.HTML
        core = html[html.index('var HO = PR.handoff || {};'):html.index('C.metrics = function(){')]
        hand = html[html.index('function handBody(){'):html.index('/* ── 并行窗口调度的渲染 ── */')]
        js = """const vm=require('node:vm'),fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const c={D:x.payload,DT:x.payload.data,PR:x.payload.pres,window:{PROGRESS:x.progress,MAINTENANCE:{pendingTasks:[],needsReview:[]}},
localStorage:{getItem:()=>null,setItem:()=>{}},esc:String};
vm.createContext(c);vm.runInContext(x.core,c);vm.runInContext(x.hand,c);console.log(JSON.stringify({html:c.handBody()}));"""
        def render(progress, records=None):
            payload['batchRecords'] = records or {}
            run = subprocess.run(['node', '-e', js], input=json.dumps({'payload': payload, 'core': core, 'hand': hand, 'progress': progress}),
                                 text=True, encoding='utf-8', capture_output=True, check=True)
            return json.loads(run.stdout)['html']
        out = render({'M1-T1': 'done', 'M1-T2': 'done'})
        buttons = re.findall(r'<button class="cp batch"[^>]*>[^<]*</button>', out)
        self.assertEqual(len(buttons), 2)
        self.assertNotIn('disabled', buttons[0])
        self.assertIn('>批次收口<', buttons[0])
        self.assertIn('disabled', buttons[1])
        self.assertIn('还有 1 个未落地：M1-T3', buttons[1])
        self.assertIn('可收口', out)
        self.assertIn('<b>1</b> 批已全部落地、尚未收口：第 1 批', out)
        self.assertIn('data-act="batchtoggle"', out)
        self.assertEqual(out.count('<div class="hbody"'), 2)
        # 默认开合：全落地的第 1 批折叠，含可派任务的第 2 批展开
        self.assertIn('<div class="hbatch" data-batch="0">', out)
        self.assertIn('<div class="hbatch open" data-batch="1">', out)
        self.assertIn('已落地 2/2', out)
        # 有记录：按钮变「再收口一次」，标题带日期与裁定；提示句不再提这一批
        out = render({'M1-T1': 'done', 'M1-T2': 'done'},
                     {'batch-1-20260901': {'batch': 1, 'tasks': ['M1-T1', 'M1-T2'], 'date': '2026-09-01', 'verdict': 'fixed'}})
        self.assertIn('>再收口一次<', out)
        self.assertIn('已收口 2026-09-01 · 已修', out)
        self.assertNotIn('尚未收口', out)
        # 在跑的批展开并计数
        out = render({'M1-T1': 'done', 'M1-T2': 'doing'})
        self.assertIn('<div class="hbatch open" data-batch="0">', out)
        self.assertIn('进行中 1', out)
        self.assertIn('还有 1 个未落地：M1-T2', out)


if __name__ == '__main__':
    unittest.main()
