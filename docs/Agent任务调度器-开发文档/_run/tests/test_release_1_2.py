"""1.2.0 新增行为的回归：待复验被看见且不锁下游、生成器指纹退出契约哈希、生成器漂移报警、
落地记录随 docs-data.js 走、工作区清理清单。"""
import argparse
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

SCRIPTS = Path(__file__).resolve().parents[1]
if (SCRIPTS / 'scripts').is_dir():
    SCRIPTS = SCRIPTS / 'scripts'
sys.path.insert(0, str(SCRIPTS))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import handoff_contract as hc
import build_docs
import maintain_docs as maintenance
import review
from test_maintenance import fixture


def git(base, *args):
    return subprocess.run(['git', '-C', str(base), '-c', 'user.name=t', '-c', 'user.email=t@example.com', *args],
                          check=True, capture_output=True, text=True, encoding='utf-8')


class RevalidationAndDriftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-1-2-')
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

    def verify_task(self, task='M1-T1', patch_id=None):
        item = {'scope': 'task-contract', 'tasks': {task: {'contractHash': self.state()['contracts'][task]['hash'],
                'verdict': 'pass', 'evidence': ['19 节任务条款与输入/范围/测试阶段已逐项核对；回归样例。']}}}
        path = self.doc / '_run/real-evidence.json'
        hc.write_json(path, item)
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.verify(self.doc, argparse.Namespace(task=task, evidence=str(path), patch=patch_id))

    def land(self, *ids):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = build_docs.mark_landed(str(self.doc), list(ids))
        self.assertEqual(code, 0, buf.getvalue())
        return buf.getvalue()

    def begin(self, patch='P1', task='M1-T1'):
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.begin(self.doc, argparse.Namespace(task=task, patch=patch, pr='42', reason='修正条款'))

    def sync(self, patch='P1'):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = maintenance.sync(self.doc, argparse.Namespace(patch=patch))
        return code, buf.getvalue()

    def section_file(self, num):
        for n, title, _, _ in review.REQUIRED_SECTIONS:
            if n == num:
                return self.doc / review.SECTION_GROUP[n] / (f'{n:02d}-' + title + '.md')
        raise KeyError(num)

    def payload(self):
        src = (self.doc / 'docs-data.js').read_text(encoding='utf-8')
        return json.loads(src[len('window.DOCS = '):].strip().rstrip(';'))

    def tool(self, *args):
        run = subprocess.run([sys.executable, '-B', str(self.doc / '_run/maintain_docs.py'), str(self.doc), *args],
                             capture_output=True, text=True, encoding='utf-8', timeout=120)
        return run

    def status_json(self, *args):
        run = self.tool('status', *args)
        out = run.stdout
        return run.returncode, json.loads(out[out.index('{'):]), run.stderr

    # ---- 第 3 项：待复验标记 ----
    def test_sync_records_patch_history_with_changed_fields_and_reports_landed_tasks(self):
        self.run_build()
        self.verify_task('M1-T1'); self.verify_task('M1-T2')
        self.land('M1-T1', 'M1-T2')
        # 补丁 1：只改 M1-T1 自己的任务行
        self.begin('P1')
        src = self.doc / '04-执行/19-模块任务拆分.md'
        src.write_text(src.read_text(encoding='utf-8').replace('校验第1组字符串长度', '校验第一组字符串长度'), encoding='utf-8')
        code, out = self.sync('P1')
        self.assertEqual(code, 0, out)
        needs = hc.read_json(self.doc / '_run/revalidation.json')
        self.assertEqual(sorted(needs), ['M1-T1'])
        self.assertEqual([p['patch'] for p in needs['M1-T1']['patches']], ['P1'])
        self.assertEqual(needs['M1-T1']['patches'][0]['changedFields'], ['task'])
        self.assertEqual(needs['M1-T1']['previousStatus'], 'done')
        self.assertIn('已落地任务被标为待复验', out)
        self.assertIn('M1-T1：19 节任务行', out)
        self.assertIn('不锁下游', out)
        # 补丁 2：只改共享章节 → 已落地的 M1-T1、M1-T2 都被标记，并写明「仅共享章节 <文件> 变化」；未落地的 M1-T3 不进标记
        self.begin('P2', 'M1-T2')
        shared = self.section_file(1)
        rel = shared.relative_to(self.doc).as_posix()
        shared.write_text(shared.read_text(encoding='utf-8') + '\n补充一句共享约束。\n', encoding='utf-8')
        code, out = self.sync('P2')
        needs = hc.read_json(self.doc / '_run/revalidation.json')
        self.assertEqual(sorted(needs), ['M1-T1', 'M1-T2'])
        self.assertEqual([p['patch'] for p in needs['M1-T1']['patches']], ['P1', 'P2'])   # 追加不覆盖
        self.assertEqual(needs['M1-T2']['patches'][-1]['changedFields'], ['sections:' + rel])
        self.assertIn('M1-T2：仅共享章节 ' + rel + ' 变化', out)
        self.assertIn('--landed <ID>', out)
        # 交接台：两个都是 recheck；maintenance.js 的 needsReview 同步
        marker = (self.doc / '_run/maintenance.js').read_text(encoding='utf-8')
        self.assertIn('"needsReview": ["M1-T1", "M1-T2"]', marker)

    def test_mark_landed_lists_remaining_revalidation(self):
        self.run_build()
        self.verify_task('M1-T1'); self.verify_task('M1-T2')
        self.land('M1-T1', 'M1-T2')
        self.begin('P1')
        shared = self.section_file(1)
        shared.write_text(shared.read_text(encoding='utf-8') + '\n补充一句共享约束。\n', encoding='utf-8')
        self.sync('P1')
        self.assertEqual(sorted(hc.read_json(self.doc / '_run/revalidation.json')), ['M1-T1', 'M1-T2'])
        self.verify_task('M1-T1', patch_id='P1')
        out = self.land('M1-T1')
        self.assertIn('仍待复验的已落地任务：M1-T2', out)
        self.assertIn('workspace', out)
        self.assertEqual(sorted(hc.read_json(self.doc / '_run/revalidation.json')), ['M1-T2'])

    def test_recheck_state_in_built_reader_does_not_lock_downstream(self):
        data, _ = maintenance.state(self.doc)
        src = self.doc / '04-执行/19-模块任务拆分.md'
        # 让 M1-T2 依赖 M1-T1
        text = src.read_text(encoding='utf-8').replace('| M1-T2 | 校验第2组字符串长度 | M1 | 无 |', '| M1-T2 | 校验第2组字符串长度 | M1 | M1-T1 |')
        src.write_text(text, encoding='utf-8')
        self.run_build()
        self.verify_task('M1-T1')
        self.land('M1-T1')
        self.begin('P1')
        shared = self.section_file(1)
        shared.write_text(shared.read_text(encoding='utf-8') + '\n补充一句共享约束。\n', encoding='utf-8')
        self.sync('P1')
        payload = self.payload()
        core = build_docs.HTML[build_docs.HTML.index('var HO = PR.handoff || {};'):build_docs.HTML.index('C.metrics = function(){')]
        js = """const vm=require('node:vm'),fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const c={D:x.payload,DT:x.payload.data,PR:x.payload.pres,window:{PROGRESS:{},MAINTENANCE:x.maint},localStorage:{getItem:()=>null},esc:String};
vm.createContext(c);vm.runInContext(x.core,c);console.log(JSON.stringify({t1:c.stOf('M1-T1'),t2locked:c.implLocked('M1-T2'),t2:c.stOf('M1-T2'),
review:c.promptFor('review','M1-T1'),resume:c.promptFor('resume','M1-T1'),impl:c.promptFor('impl','M1-T2')}));"""
        maint = json.loads((self.doc / '_run/maintenance.js').read_text(encoding='utf-8').split('=', 1)[1].strip().rstrip(';'))
        run = subprocess.run(['node', '-e', js], input=json.dumps({'payload': payload, 'core': core, 'maint': maint}),
                             text=True, encoding='utf-8', capture_output=True, check=True)
        r = json.loads(run.stdout)
        self.assertEqual(r['t1'], 'recheck')
        self.assertEqual(r['t2'], 'todo')
        self.assertFalse(r['t2locked'])
        self.assertIn('# 实现任务 M1-T2', r['impl'])
        self.assertIn('复验已落地任务 M1-T1', r['review'])
        self.assertIn('继续复验已落地任务 M1-T1', r['resume'])
        # 派发导出与浏览器同源
        self.assertEqual(payload['dispatch']['M1-T1']['review'], r['review'])
        self.assertEqual(payload['dispatch']['M1-T1']['resume'], r['resume'])

    def test_sync_normalizes_legacy_baseline_saved_with_compiler_in_context(self):
        self.run_build(); self.verify_task('M1-T1'); self.land('M1-T1'); self.verify_task('M1-T2'); self.land('M1-T2')
        self.begin('P1')
        path = self.doc / '_run/patches/P1.json'
        rec = hc.read_json(path)
        legacy = hc.legacy_hashes(rec['baseline'], 'old-compiler-fingerprint')
        for tid, c in rec['baseline']['contracts'].items():
            c['context']['compiler'] = 'old-compiler-fingerprint'
            c['hash'] = legacy[tid]
        hc.write_json(path, rec)
        src = self.doc / '04-执行/19-模块任务拆分.md'
        src.write_text(src.read_text(encoding='utf-8').replace('校验第1组字符串长度', '校验第一组字符串长度'), encoding='utf-8')
        code, out = self.sync('P1')
        self.assertEqual(hc.read_json(path)['affected'], ['M1-T1'])          # 不是全部任务
        self.assertEqual(sorted(hc.read_json(self.doc / '_run/revalidation.json')), ['M1-T1'])

    # ---- 第 4 项：生成器指纹退出契约哈希 ----
    def test_contract_hash_ignores_compiler_fingerprint(self):
        checked = self.state()
        self.assertNotIn('compiler', checked['contracts']['M1-T1']['context'])
        with unittest.mock.patch.object(hc, 'compiler_hash', return_value='another-generator'):
            again = self.state()
            self.assertEqual(again['contracts']['M1-T1']['hash'], checked['contracts']['M1-T1']['hash'])
            self.assertNotEqual(again['sourceVersion'], checked['sourceVersion'])

    def test_compiler_change_keeps_reviews_but_marks_stale(self):
        import install_project
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        run = self.tool('build'); self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        # 用安装后的工具登记复核（契约哈希与进程内 analyze 一致，因为不含生成器指纹）
        self.verify_task('M1-T1')
        run = self.tool('build'); self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        code, before, _ = self.status_json()
        self.assertEqual(before['stale'], [])
        self.assertTrue(before['tasks']['M1-T1']['ready'])
        records = hc.read_json(self.doc / '_run/task-reviews.json')
        self.assertIn('compiler', records['M1-T1'])                     # verify 附带指纹供审计
        # 升级生成器：改一行
        gen = self.doc / '_run/build_docs.py'
        gen.write_text(gen.read_text(encoding='utf-8') + '\n# upgraded generator\n', encoding='utf-8')
        code, mid, _ = self.status_json()
        self.assertEqual(mid['stale'], ['生成器版本已变更'])
        self.assertTrue(mid['tasks']['M1-T1']['ready'])                  # 复核记录仍有效
        self.assertTrue(any('tool-version.json 不一致：build_docs.py' in s for s in mid['runtimeDrift']))
        run = self.tool('build'); self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        code, after, _ = self.status_json()
        self.assertEqual(after['stale'], [])
        self.assertTrue(after['tasks']['M1-T1']['ready'])                # 不需要重新 verify
        self.assertEqual(hc.read_json(self.doc / '_run/task-reviews.json')['M1-T1']['contractHash'],
                         records['M1-T1']['contractHash'])

    def test_build_migrates_legacy_review_records_when_only_compiler_changed(self):
        self.run_build(); self.verify_task('M1-T1')
        checked = self.state()
        manifest = hc.read_json(self.doc / '_run/build-manifest.json')
        records = hc.read_json(self.doc / '_run/task-reviews.json')
        records['M1-T1']['contractHash'] = hc.legacy_hashes(checked, manifest['compiler'])['M1-T1']
        hc.write_json(self.doc / '_run/task-reviews.json', records)
        self.assertFalse(hc.readiness(self.doc, checked)['M1-T1']['ready'])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            maintenance.build(self.doc)
        self.assertIn('复核记录已按新契约公式迁移', buf.getvalue())
        self.assertTrue(hc.readiness(self.doc, self.state())['M1-T1']['ready'])
        self.assertIn('migratedFrom', hc.read_json(self.doc / '_run/task-reviews.json')['M1-T1'])
        # 语义变了的记录不迁移
        records = hc.read_json(self.doc / '_run/task-reviews.json')
        records['M1-T1']['contractHash'] = 'something-else'
        hc.write_json(self.doc / '_run/task-reviews.json', records)
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.build(self.doc)
        self.assertFalse(hc.readiness(self.doc, self.state())['M1-T1']['ready'])

    # ---- 第 5 项：生成器未提交/漂移报警 ----
    def test_uncommitted_generator_change_is_reported_until_committed(self):
        import install_project
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        git(self.base, 'init', '-b', 'main')
        run = self.tool('build'); self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        code, st, err = self.status_json()
        self.assertTrue(any('未提交' in s and '未跟踪' in s for s in st['runtimeDrift']))   # 还没 add
        self.assertEqual(code, 1)
        git(self.base, 'add', '-A'); git(self.base, 'commit', '-q', '-m', 'baseline')
        code, st, err = self.status_json()
        self.assertEqual([s for s in st['runtimeDrift'] if '未提交' in s], [])
        gen = self.doc / '_run/build_docs.py'
        gen.write_text(gen.read_text(encoding='utf-8') + '\n# local fix\n', encoding='utf-8')
        code, st, err = self.status_json()
        self.assertTrue(any('生成器有未提交改动：build_docs.py' in s for s in st['runtimeDrift']))
        self.assertIn('未提交', err)
        self.assertEqual(code, 1)
        run = self.tool('build'); self.assertIn('[生成器] 生成器有未提交改动：build_docs.py', run.stdout)
        git(self.base, 'add', '-A'); git(self.base, 'commit', '-q', '-m', 'fix')
        code, st, err = self.status_json()
        self.assertEqual([s for s in st['runtimeDrift'] if '未提交' in s], [])
        self.assertTrue(any('tool-version.json 不一致：build_docs.py' in s for s in st['runtimeDrift']))  # 本地补丁未登记

    # ---- 第 7 项：落地记录随 docs-data.js 走，笔记写 LF ----
    def test_mark_landed_updates_payload_progress_and_writes_lf(self):
        self.run_build(); self.verify_task('M1-T1'); self.verify_task('M1-T2')
        self.land('M1-T1')
        note = (self.doc / '图谱/任务/M1-T1.md').read_bytes()
        self.assertNotIn(b'\r\n', note)
        self.assertIn(b'status: done', note)
        self.assertEqual(self.payload()['progress'], {'M1-T1': 'done'})
        self.assertEqual(hc.stale_reasons(self.doc), [])                    # 清单同步了 docs-data.js 的指纹
        self.land('M1-T2')                                                   # 第二次 --landed 不被当成产物过期拒绝
        self.assertEqual(self.payload()['progress'], {'M1-T1': 'done', 'M1-T2': 'done'})
        # 新检出：没有本机 progress.js，也没跑脚本，docs-data.js 里就有落地记录
        (self.doc / '_run/progress.js').unlink()
        self.assertEqual(build_docs.read_progress(str(self.doc)), {'M1-T1': 'done', 'M1-T2': 'done'})
        # 重建后 payload.progress 与笔记一致，且不因为 progress 而每次重写
        self.run_build()
        self.assertEqual(self.payload()['progress'], {'M1-T1': 'done', 'M1-T2': 'done'})

    def test_no_text_write_without_explicit_newline(self):
        src = (SCRIPTS / 'build_docs.py').read_text(encoding='utf-8-sig')
        import re
        for m in re.finditer(r'open\(([^)]*)\)', src):
            args = m.group(1)
            if '"w"' in args or "'w'" in args:
                self.assertIn('newline', args, m.group(0))

    # ---- 第 8 项：工作区清理清单 ----
    def test_workspace_lists_leftovers_of_landed_tasks_only(self):
        import install_project
        git(self.base, 'init', '-b', 'main')
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        self.run_build()
        parent = self.base.parent
        for tid in ('M1-T1', 'M1-T3'):
            note = self.doc / '图谱/任务' / (tid + '.md')
            note.write_text(note.read_text(encoding='utf-8').replace('status: todo', 'status: done', 1), encoding='utf-8')
        self.assertEqual(build_docs.progress_state(str(self.doc)), {'M1-T1': 'done', 'M1-T3': 'done'})
        (parent / 'regression-m1-t1').mkdir()                 # 已落地、不在 worktree list → 列出
        (parent / 'regression-m1-t2').mkdir()                 # 未落地 → 不列
        (parent / '.codex-plans' / 'regression-m1-t1').mkdir(parents=True)
        (parent / '.codex-plans' / 'regression-m1-t2').mkdir(parents=True)
        git(self.base, 'add', '-A'); git(self.base, 'commit', '-q', '-m', 'baseline')
        git(self.base, 'worktree', 'add', '-b', 'task/M1-T3', str(parent / 'regression-m1-t3'), 'HEAD')   # 活工作树 → 不列
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(maintenance.workspace(self.doc, None), 0)
        out = buf.getvalue()
        self.assertIn('rm -rf "' + (parent / 'regression-m1-t1').as_posix() + '"', out)
        self.assertIn('rm -rf "' + (parent / '.codex-plans/regression-m1-t1').as_posix() + '"', out)
        self.assertNotIn('regression-m1-t2', out)
        self.assertNotIn('regression-m1-t3', out)
        self.assertIn('git worktree prune', out)
        run = self.tool('workspace')
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn('regression-m1-t1', run.stdout)

    # ---- 第 9 项：交接手册随项目生成 ----
    def test_install_renders_handoff_manual_idempotently_and_survives_vault_rebuild(self):
        import install_project
        self.run_build()
        (self.base / 'AGENTS.md').write_text('# 回归项目\n\n用户自己写的一段。\n', encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        agents = (self.base / 'AGENTS.md').read_text(encoding='utf-8')
        claude = (self.base / 'CLAUDE.md').read_text(encoding='utf-8')
        for text in (agents, claude):
            self.assertIn('<!-- handoff:begin -->', text)
            self.assertIn('<!-- handoff:end -->', text)
            self.assertIn('../regression-<id>', text)
            self.assertIn('docs/契约回归', text)
            self.assertNotIn('<repo>', text)
            self.assertNotIn('<docs>', text)
            self.assertIn('语义复核不是派发条件', text)
            self.assertIn('git worktree prune', text)
        self.assertIn('用户自己写的一段。', agents)
        first = (agents, claude)
        with contextlib.redirect_stdout(io.StringIO()):
            install_project.install(self.doc, root=self.base)
        self.assertEqual(first, ((self.base / 'AGENTS.md').read_text(encoding='utf-8'), (self.base / 'CLAUDE.md').read_text(encoding='utf-8')))
        run = subprocess.run([sys.executable, '-B', str(self.doc / '_run/build_vault.py'), str(self.doc), '--root', str(self.base)],
                             capture_output=True, text=True, encoding='utf-8', timeout=60)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        after = (self.base / 'AGENTS.md').read_text(encoding='utf-8')
        self.assertIn('<!-- vault:begin -->', after)
        self.assertIn('<!-- handoff:begin -->', after)
        self.assertIn('语义复核不是派发条件', after)
        self.assertIn('用户自己写的一段。', after)


if __name__ == '__main__':
    unittest.main()
