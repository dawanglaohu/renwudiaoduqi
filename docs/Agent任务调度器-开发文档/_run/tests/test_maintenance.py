"""维护闭环的行为回归：失败不落通过、局部补丁保留无关成果、生产者消费者一致。"""
import argparse
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

# 同一份测试既能住在技能的 tests/（脚本在 ../scripts/），也能被安装进 <docs>/_run/tests/（脚本在 ../）
SCRIPTS = Path(__file__).resolve().parents[1]
if (SCRIPTS / 'scripts').is_dir():
    SCRIPTS = SCRIPTS / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import handoff_contract as hc
import build_docs
import maintain_docs as maintenance
import review


def fixture(base):
    doc = base / 'docs' / '契约回归'
    for n, title, _, _ in review.REQUIRED_SECTIONS:
        p = doc / review.SECTION_GROUP[n] / (f'{n:02d}-' + title + '.md')
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('# ' + title + '\n\n本节约束字符串处理的输入、输出与错误分支。所有输入均须显式校验并返回可观察结果。\n', encoding='utf-8')
    (doc/'README.md').write_text('# 回归项目\n按任务契约实施与验收。\n', encoding='utf-8')
    (doc/'02-设计/06-系统架构与模块划分.md').write_text('# 系统架构与模块划分\n\n| ID | 职责 | 依赖 |\n|---|---|---|\n| M1 | 字符串处理 | 无 |\n', encoding='utf-8')
    edges = '| ID | 场景 | 触发 | 期望 | 模块 |\n|---|---|---|---|---|\n'
    for i in range(1,17):
        edges += f'| E-{i:02d} | 空输入{i} | 长度为零 | 返回空字符串 | M1 |\n'
    (doc/'03-质量/13-边界问题与异常处理.md').write_text('# 边界问题与异常处理\n\n'+edges, encoding='utf-8')
    rows = '| ID | 标题 | 模块 | 依赖 | 输入 | 产出 | 验收标准 | 预估 |\n|---|---|---|---|---|---|---|---|\n'
    for i in range(1,4):
        refs = '、'.join(f'E-{j:02d}' for j in range(1,17) if (j-1)%3 == i-1)
        rows += f'| M1-T{i} | 校验第{i}组字符串长度 | M1 | 无 | 固定字符串 | `src/task-{i}.ts` | 1) 空输入返回空字符串（{refs}） 2) 非空输入原样返回 | 1d |\n'
    (doc/'04-执行/19-模块任务拆分.md').write_text('# 模块任务拆分\n\n'+rows,encoding='utf-8')
    (doc/'_run').mkdir()
    hc.write_json(doc/'_run/presentation.json', {'project':'契约回归','handoff':{
        'repo':'regression','stack':'TypeScript','docsPath':'docs/契约回归',
        'taskPaths':{f'M1-T{i}':[f'src/task-{i}.ts'] for i in range(1,4)}}})
    vault = SCRIPTS/'build_vault.py'
    if not vault.exists():
        vault = SCRIPTS.parents[1]/'obsidian-vault/scripts/build_vault.py'
    shutil.copyfile(vault, doc/'_run/build_vault.py')
    return doc


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='skill-contract-')
        self.doc = fixture(Path(self.temp.name))
        self.addCleanup(self.temp.cleanup)

    def run_build(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.build(self.doc)

    def state(self):
        return maintenance.state(self.doc)[1]

    def verify_task(self, task='M1-T1', patch_id=None):
        item={'scope':'task-contract','tasks':{task:{'contractHash':self.state()['contracts'][task]['hash'],
              'verdict':'pass','evidence':['19 节任务条款与输入/范围/测试阶段已逐项核对；回归样例。']}}}
        path=self.doc/'_run/real-evidence.json';hc.write_json(path,item)
        with contextlib.redirect_stdout(io.StringIO()):
            return maintenance.verify(self.doc,argparse.Namespace(task=task,evidence=str(path),patch=patch_id))

    def begin(self):
        with contextlib.redirect_stdout(io.StringIO()):
            maintenance.begin(self.doc,argparse.Namespace(task='M1-T1',patch='P1',pr='42',reason='保留既定行为，修正任务标题'))

    def test_real_structure_and_normal_task_pass(self):
        self.assertEqual(self.run_build().count(review.BLOCK),0)
        self.assertFalse(hc.readiness(self.doc,self.state())['M1-T1']['ready'])
        self.assertEqual(self.verify_task(),0)
        self.assertTrue(hc.readiness(self.doc,self.state())['M1-T1']['ready'])
        self.assertEqual(hc.stale_reasons(self.doc),[])

    def test_invalid_evidence_never_writes_pass(self):
        self.run_build()
        path=self.doc/'_run/fake.json';hc.write_json(path,{'scope':'task-contract','tasks':{'M1-T1':{
          'contractHash':'wrong-version','verdict':'pass','evidence':['claim']}}})
        with self.assertRaises(ValueError):
            maintenance.verify(self.doc,argparse.Namespace(task='M1-T1',evidence=str(path),patch=None))
        self.assertFalse((self.doc/'_run/task-reviews.json').exists())

    def test_unknown_patch_does_not_write_pass(self):
        self.run_build()
        with self.assertRaises(ValueError):self.verify_task(patch_id='missing')
        self.assertFalse((self.doc/'_run/task-reviews.json').exists())

    def test_local_patch_preserves_other_tasks_and_pr(self):
        self.run_build();self.verify_task('M1-T2');self.begin()
        other=self.doc/'图谱/任务/M1-T2.md'
        text=other.read_text(encoding='utf-8').replace('<!-- notes:begin -->','<!-- notes:begin -->\n保留人工沉淀')
        other.write_text(text,encoding='utf-8');before=(other.read_bytes(),other.stat().st_mtime_ns)
        html_time=(self.doc/'index.html').stat().st_mtime_ns
        src=self.doc/'04-执行/19-模块任务拆分.md'
        src.write_text(src.read_text(encoding='utf-8').replace('校验第1组字符串长度','校验第一组字符串长度'),encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(maintenance.sync(self.doc,argparse.Namespace(patch='P1')),0)
        rec=hc.read_json(self.doc/'_run/patches/P1.json')
        self.assertEqual(rec['affected'],['M1-T1']);self.assertEqual(rec['pr'],'42')
        self.assertIn('04-执行/19-模块任务拆分.md',rec['sourceChanges'])
        self.assertIn('校验第1组字符串长度',rec['sourceChanges']['04-执行/19-模块任务拆分.md']['before'])
        self.assertIn('校验第一组字符串长度',rec['sourceChanges']['04-执行/19-模块任务拆分.md']['after'])
        self.assertEqual((other.read_bytes(),other.stat().st_mtime_ns),before)
        self.assertEqual((self.doc/'index.html').stat().st_mtime_ns,html_time)
        self.assertTrue(hc.readiness(self.doc,self.state())['M1-T2']['ready'])
        self.assertEqual(self.verify_task(patch_id='P1'),0)
        self.assertEqual(hc.read_json(self.doc/'_run/patches/P1.json')['status'],'verified')
        self.assertIn('原 PR：42',(self.doc/'_run/patches/P1.md').read_text(encoding='utf-8'))

    def test_noop_build_preserves_generated_bytes_and_mtime(self):
        self.run_build()
        names=['index.html','docs-data.js','_run/dispatch.json','_MOC.md','图谱/任务/M1-T2.md']
        before={n:((self.doc/n).read_bytes(),(self.doc/n).stat().st_mtime_ns) for n in names}
        self.run_build()
        self.assertEqual(before,{n:((self.doc/n).read_bytes(),(self.doc/n).stat().st_mtime_ns) for n in names})

    def test_paths_and_missing_provider_are_blocked(self):
        pres=hc.read_json(self.doc/'_run/presentation.json');pres['handoff']['taskPaths']['M1-T1']=[]
        hc.write_json(self.doc/'_run/presentation.json',pres)
        spec={'schemaVersion':1,'tasks':{'M1-T1':{'requires':[{'task':'M1-T3','capability':'storage'}],
              'outputPaths':['src/new.ts']},'M1-T3':{'provides':['storage']}}}
        hc.write_json(self.doc/'_run/task-contracts.json',spec)
        codes={x['code'] for x in self.state()['issues']}
        self.assertTrue({'H04','H05','H08'} <= codes)

    def test_future_consumer_not_a_dependency_and_shared_paths_consistent(self):
        src=self.doc/'04-执行/19-模块任务拆分.md'
        src.write_text(src.read_text(encoding='utf-8').replace('`src/task-1.ts`','`src/task-1.ts`，后由 M1-T3 消费'),encoding='utf-8')
        hc.write_json(self.doc/'_run/task-contracts.json',{'schemaVersion':1,'tasks':{
          'M1-T1':{'supportPaths':['src/shared.ts']},'M1-T2':{'supportPaths':['src/shared.ts']}}})
        checked=self.state();self.assertFalse(any(i['code']=='H05' for i in checked['issues']))
        self.run_build()
        payload=hc.read_json(self.doc/'_run/dispatch.json')
        self.assertIn('src/shared.ts',payload['tasks']['M1-T1']['implementation'])
        self.assertIn('src/shared.ts',payload['tasks']['M1-T1']['review'])
        self.assertEqual(checked['effectivePaths']['M1-T1'][-1],'src/task-1.ts')

    def test_glob_scope_rejected_instead_of_silently_ignored(self):
        pres=hc.read_json(self.doc/'_run/presentation.json');pres['handoff']['taskPaths']['M1-T1']=['packages/*/src/']
        hc.write_json(self.doc/'_run/presentation.json',pres)
        self.assertTrue(any(i['code']=='H03' for i in self.state()['issues']))

    def test_fingerprint_includes_edge_path_and_architecture_not_mtime(self):
        original=self.state()['contracts']['M1-T1']['hash']
        edge=self.doc/'03-质量/13-边界问题与异常处理.md'
        edge.write_text(edge.read_text(encoding='utf-8').replace('返回空字符串','返回明确空结果',1),encoding='utf-8')
        new=self.state()['contracts']['M1-T1']['hash'];self.assertNotEqual(new,original)
        other=self.state()['contracts']['M1-T2']['hash']
        edge.touch();self.assertEqual(self.state()['contracts']['M1-T2']['hash'],other)
        pres=hc.read_json(self.doc/'_run/presentation.json');pres['handoff']['taskPaths']['M1-T1'].append('test/task-1.test.ts')
        hc.write_json(self.doc/'_run/presentation.json',pres);self.assertNotEqual(self.state()['contracts']['M1-T1']['hash'],new)
        new=self.state()['contracts']['M1-T1']['hash']
        pres['handoff']['architecture']={'backend':{'layers':'输入处理只能调用字符串层'}}
        hc.write_json(self.doc/'_run/presentation.json',pres);self.assertNotEqual(self.state()['contracts']['M1-T1']['hash'],new)

    def test_missing_or_deleted_source_and_products_detected(self):
        self.run_build()
        (self.doc/'01-约束/05-技术栈.md').unlink();(self.doc/'_run/dispatch.json').unlink()
        reasons=hc.stale_reasons(self.doc)
        self.assertTrue(any('源已变更或删除' in s for s in reasons))
        self.assertTrue(any('dispatch.json' in s for s in reasons))

    def test_failed_sync_recovers_same_patch_without_restarting(self):
        self.run_build();self.begin()
        with patch.object(maintenance,'build',side_effect=ValueError('simulated interrupted build')):
            with self.assertRaises(ValueError):maintenance.sync(self.doc,argparse.Namespace(patch='P1'))
        self.assertEqual(hc.read_json(self.doc/'_run/patches/P1.json')['status'],'failed')
        with contextlib.redirect_stdout(io.StringIO()):maintenance.sync(self.doc,argparse.Namespace(patch='P1'))
        self.assertEqual(hc.read_json(self.doc/'_run/patches/P1.json')['status'],'synced')

    def test_existing_patch_cannot_be_reused_for_another_pr(self):
        self.begin()
        with self.assertRaises(ValueError):
            maintenance.begin(self.doc,argparse.Namespace(task='M1-T1',patch='P1',pr='99',reason='different'))
        with self.assertRaises(ValueError):maintenance.patch_path(self.doc,'../outside')

    def test_primitive_needs_integration_owner_and_capabilities_unique(self):
        hc.write_json(self.doc/'_run/task-contracts.json',{'schemaVersion':1,'tasks':{
          'M1-T1':{'stage':'primitive','provides':['shared']},'M1-T2':{'provides':['shared']}}})
        codes={i['code'] for i in self.state()['issues']}
        self.assertTrue({'H02','H09'} <= codes)

    def test_browser_core_export_and_review_override(self):
        self.run_build()
        src=(self.doc/'docs-data.js').read_text(encoding='utf-8')
        payload=json.loads(src[len('window.DOCS = '):].strip().rstrip(';'))
        self.assertEqual(payload['dispatch'],hc.read_json(self.doc/'_run/dispatch.json')['tasks'])
        self.assertIn('DOC_PATCH',payload['dispatch']['M1-T1']['review'])
        self.assertNotIn('gh stack init',payload['dispatch']['M1-T1']['resume'])
        core=build_docs.HTML[build_docs.HTML.index('var HO = PR.handoff || {};'):build_docs.HTML.index('C.metrics = function(){')]
        code="""const vm=require('node:vm'),fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const c={D:x.payload,DT:x.payload.data,PR:x.payload.pres,window:{PROGRESS:{'M1-T1':'review'},MAINTENANCE:{pendingTasks:[],needsReview:[]}},localStorage:{getItem:()=>JSON.stringify({'M1-T1':'done'})},esc:String};
vm.createContext(c);vm.runInContext(x.core,c);console.log(JSON.stringify({state:c.stOf('M1-T1'),locked:c.implLocked('M1-T1'),review:c.buildReview(c.taskById('M1-T1'))}));"""
        run=subprocess.run(['node','-e',code],input=json.dumps({'payload':payload,'core':core}),text=True,encoding='utf-8',capture_output=True,check=True)
        result=json.loads(run.stdout)
        self.assertEqual(result['state'],'review');self.assertTrue(result['locked'])
        self.assertEqual(result['review'],payload['dispatch']['M1-T1']['review'])


    def test_pending_patch_prevents_landing_without_mutating_note(self):
        self.run_build();self.verify_task();self.begin()
        note=self.doc/'图谱/任务/M1-T1.md';before=note.read_bytes()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_docs.mark_landed(str(self.doc),['M1-T1']),1)
        self.assertEqual(note.read_bytes(),before)

    def test_verified_local_patch_can_land_and_clear_revalidation(self):
        self.run_build();self.verify_task()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_docs.mark_landed(str(self.doc),['M1-T1']),0)
        self.begin()
        src=self.doc/'04-执行/19-模块任务拆分.md'
        src.write_text(src.read_text(encoding='utf-8').replace('校验第1组字符串长度','校验第一组字符串长度'),encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()):maintenance.sync(self.doc,argparse.Namespace(patch='P1'))
        self.assertIn('M1-T1',hc.read_json(self.doc/'_run/revalidation.json'))
        self.verify_task(patch_id='P1')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(build_docs.mark_landed(str(self.doc),['M1-T1']),0)
        self.assertNotIn('M1-T1',hc.read_json(self.doc/'_run/revalidation.json'))
        self.assertIn('status: done',(self.doc/'图谱/任务/M1-T1.md').read_text(encoding='utf-8'))

    def test_installer_preserves_source_and_backs_up_old_runtime(self):
        import install_project
        original={str(p):p.read_bytes() for p in self.doc.glob('*/*.md') if p.parent.name!='_run'}
        old=self.doc/'_run/review.py';old.write_text('# previous tool',encoding='utf-8')
        with contextlib.redirect_stdout(io.StringIO()):
            changed=install_project.install(self.doc)
        self.assertIn('review.py',changed)
        self.assertTrue(list((self.doc/'_run/tool-backups').glob('*/review.py')))
        self.assertEqual(original,{str(p):p.read_bytes() for p in self.doc.glob('*/*.md') if p.parent.name!='_run'})
        run=subprocess.run([sys.executable,'-B',str(self.doc/'_run/maintain_docs.py'),str(self.doc),'build'],
                           capture_output=True,text=True,encoding='utf-8',timeout=30)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        self.assertEqual(hc.stale_reasons(self.doc),[])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(install_project.install(self.doc),[])

    def test_deleted_provider_blocks_input_not_unrelated_task(self):
        data,_=maintenance.state(self.doc)
        data['tasks'][0]['input']='M9-T99 的已完成产出'
        checked=hc.analyze(self.doc,data['tasks'],hc.read_json(self.doc/'_run/presentation.json'),data['edges'])
        self.assertTrue(any(i['code']=='H05' and i['taskIds']==['M1-T1'] for i in checked['issues']))
        self.assertFalse(any('M1-T2' in i.get('taskIds',[]) for i in checked['issues']))

    def test_provider_change_propagates_but_unrelated_task_does_not(self):
        data,_=maintenance.state(self.doc);pres=hc.read_json(self.doc/'_run/presentation.json')
        data['tasks'][1]['deps']=['M1-T1'];data['tasks'][1]['input']='M1-T1 产出'
        before=hc.analyze(self.doc,data['tasks'],pres,data['edges'])['contracts']
        data['tasks'][0]['accept']+=' 增加已确认的输出约束'
        after=hc.analyze(self.doc,data['tasks'],pres,data['edges'])['contracts']
        self.assertNotEqual(before['M1-T2']['hash'],after['M1-T2']['hash'])
        self.assertEqual(before['M1-T3']['hash'],after['M1-T3']['hash'])

    def test_invalid_contract_types_rejected_without_traceback(self):
        hc.write_json(self.doc/'_run/task-contracts.json',{'tasks':{'M1-T1':{'requires':7}}})
        with self.assertRaises(ValueError):self.state()
        report=review.review(str(self.doc))
        self.assertTrue(any(i['code']=='H00' for i in report.items))


    def test_review_record_changed_outside_sync_invalidates_outputs(self):
        self.run_build();self.verify_task()
        records=hc.read_json(self.doc/'_run/task-reviews.json')
        records['M1-T1']['verdict']='revise'
        hc.write_json(self.doc/'_run/task-reviews.json',records)
        self.assertTrue(any('task-reviews.json' in s for s in hc.stale_reasons(self.doc)))
        self.assertFalse(hc.readiness(self.doc,self.state())['M1-T1']['ready'])


    def test_real_git_branch_mismatch_does_not_update_patch(self):
        base=self.doc.parents[1]
        subprocess.run(['git','init','-b','task/M1-T1',str(base)],check=True,capture_output=True)
        self.begin()
        baseline=(self.doc/'_run/patches/P1.json').read_bytes()
        subprocess.run(['git','-C',str(base),'switch','--orphan','task/other'],check=True,capture_output=True)
        with self.assertRaises(ValueError):maintenance.sync(self.doc,argparse.Namespace(patch='P1'))
        self.assertEqual((self.doc/'_run/patches/P1.json').read_bytes(),baseline)

    def test_first_review_is_contract_only_without_code_pr(self):
        self.run_build()
        src=(self.doc/'docs-data.js').read_text(encoding='utf-8')
        payload=json.loads(src[len('window.DOCS = '):].strip().rstrip(';'))
        core=build_docs.HTML[build_docs.HTML.index('var HO = PR.handoff || {};'):build_docs.HTML.index('C.metrics = function(){')]
        js="""const vm=require('node:vm'),fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));
const c={D:x.payload,DT:x.payload.data,PR:x.payload.pres,window:{PROGRESS:{}},localStorage:{getItem:()=>null},esc:String};
vm.createContext(c);vm.runInContext(x.core,c);console.log(JSON.stringify({prompt:c.promptFor('review','M1-T1'),implementation:c.promptFor('impl','M1-T1')}));"""
        run=subprocess.run(['node','-e',js],input=json.dumps({'payload':payload,'core':core}),text=True,encoding='utf-8',capture_output=True,check=True)
        actual=json.loads(run.stdout)
        self.assertIn('不创建代码 PR',actual['prompt'])
        self.assertNotIn('gh stack submit',actual['prompt'])
        # 1.2.0：契约待语义复核不再锁「实施」——无前置的任务未复核也能派，复核在审查阶段登记
        self.assertIn('# 实现任务 M1-T1',actual['implementation'])


if __name__ == '__main__':unittest.main()
