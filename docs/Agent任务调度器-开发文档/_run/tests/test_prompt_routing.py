"""Prompt routing regression: evaluate the shipped core/click handler, never build artifacts."""

import ast
import copy
import json
from pathlib import Path
import subprocess
import unittest


RUN = Path(__file__).resolve().parents[1]

BROWSER = r"""
(async function(){
const fs = require('node:fs');
const vm = require('node:vm');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
let listener, copied = [], writes = 0;
const context = {
  D: input.payload, DT: input.payload.data, PR: input.payload.pres,
  window: {PROGRESS: input.progress, MAINTENANCE: input.maintenance},
  localStorage: {
    getItem: () => JSON.stringify(input.local || {}),
    setItem: () => { writes++; }
  },
  esc: value => String(value == null ? '' : value),
  document: {
    addEventListener: (event, callback) => { if (event === 'click') listener = callback; },
    querySelector: () => null
  },
  card: {hidden: true, dataset: {}, querySelector: () => null},
  navigator: {clipboard: {writeText: async text => { copied.push(text); }}},
  setTimeout: () => 0, clearTimeout: () => {}, refreshHand: () => {}
};
vm.createContext(context, {codeGeneration: {strings: false, wasm: false}});
vm.runInContext(input.core, context, {timeout: 5000});
vm.runInContext(input.click, context, {timeout: 5000});
for (const action of input.actions || []) {
  const button = {disabled: false, textContent: action.kind,
                  dataset: {kind: action.kind, task: action.id},
                  classList: {remove: () => {}, add: () => {}}};
  listener({target: {closest: selector => selector === '.cp' ? button : null},
            stopPropagation: () => {}});
  await Promise.resolve();
}
const tasks = {};
for (const task of input.payload.data.tasks) {
  tasks[task.id] = {
    review: context.promptFor('review', task.id),
    resume: context.promptFor('resume', task.id),
    implementation: context.promptFor('impl', task.id),
    locked: context.implLocked(task.id),
    state: context.stOf(task.id), fileState: context.fileSt(task.id),
    compiled: {contractHash: input.payload.handoff.contracts[task.id].hash,
      implementation: context.buildImpl(task), review: context.buildReview(task),
      resume: context.buildResume(task)}
  };
}
process.stdout.write(JSON.stringify({tasks, copied, writes, local: context.PG}));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""

SEMANTIC_PENDING = {"ready": False, "blockers": [],
                    "reasons": ["任务契约待语义复核；可在当前审查内完成，无需重跑生成流程"]}


def payload_for(*ids, deps=None, readiness=None):
    deps = deps or {}
    readiness = readiness or {}
    tasks = [dict(id=tid, title="路由回归", module="M1", deps=list(deps.get(tid, [])), input="已有输入",
                  output="确定结果", accept="1) 保留验收依据", est=1, edges=["E-01"])
             for tid in ids]
    return {
        "schemaVersion": 1, "project": "路由测试", "groups": [],
        "data": {"tasks": tasks, "modules": [{"id": "M1", "role": "后端", "deps": []}],
                 "edges": [{"id": "E-01", "scene": "保留历史", "trigger": "复验",
                            "expect": "不改既有记录", "module": "M1"}]},
        "pres": {"handoff": {"docsPath": "docs/路由测试-开发文档", "repo": "routing",
                             "mainBranch": "main", "branchPrefix": "task/"}},
        "handoff": {
            "version": "1.1.0", "contracts": {tid: {"hash": "hash-" + tid} for tid in ids},
            "readiness": {tid: copy.deepcopy(readiness.get(tid, {"ready": True})) for tid in ids},
            "effectivePaths": {tid: ["packages/daemon/src/"] for tid in ids}
        }
    }


def chain():
    """M1-T1 ← M1-T2 ← M1-T4；M1-T3 与 M1-T2 同批（都只依赖 M1-T1）。四个任务都还没登记语义复核。"""
    ids = ("M1-T1", "M1-T2", "M1-T3", "M1-T4")
    return payload_for(*ids, deps={"M1-T2": ["M1-T1"], "M1-T3": ["M1-T1"], "M1-T4": ["M1-T2"]},
                       readiness={tid: SEMANTIC_PENDING for tid in ids})


class PromptRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Read only literals and the pure compiler-input helper. No generator import/main.
        source = (RUN / "build_docs.py").read_text(encoding="utf-8-sig")
        tree = ast.parse(source)
        html_node = next(node for node in tree.body if isinstance(node, ast.Assign)
                         and any(isinstance(target, ast.Name) and target.id == "HTML"
                                 for target in node.targets))
        cls.html = ast.literal_eval(html_node.value)
        cls.core = cls.html[cls.html.index("var HO = PR.handoff || {};"):
                            cls.html.index("C.metrics = function(){")]
        start = cls.html.index('document.addEventListener("click", function(ev){')
        cls.click = cls.html[start:cls.html.index('document.addEventListener("keydown"', start)]
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                      and node.name == "prompt_compiler_core")
        namespace = {"HTML": cls.html, "json": json}
        exec(compile(ast.Module(body=[helper], type_ignores=[]), "<prompt helper>", "exec"), namespace)
        cls.compiler_core = staticmethod(namespace["prompt_compiler_core"])

    def run_node(self, command, data):
        result = subprocess.run(command, input=json.dumps(data, ensure_ascii=False),
                                text=True, encoding="utf-8", capture_output=True,
                                timeout=30, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def browser(self, payload, progress=None, maintenance=None, actions=None, local=None):
        return self.run_node(["node", "-e", BROWSER], {
            "payload": payload, "core": self.core, "click": self.click,
            "progress": progress or {},
            "maintenance": maintenance or {"pendingTasks": [], "needsReview": []},
            "actions": actions or [], "local": local or {}
        })

    def test_todo_contract_pass_stays_contract_only_and_copy_does_not_advance(self):
        result = self.browser(payload_for("M1-T1"), actions=[
            {"kind": "review", "id": "M1-T1"}, {"kind": "review", "id": "M1-T1"}])
        self.assertEqual(len(result["copied"]), 2)
        for text in result["copied"]:
            self.assertIn("本任务尚未开始实现", text)
            self.assertIn("不创建代码 PR", text)
            self.assertNotIn("PR 已提", text)
            self.assertNotIn("gh stack submit", text)
        self.assertEqual(result["tasks"]["M1-T1"]["state"], "todo")
        self.assertEqual(result["local"], {})
        self.assertEqual(result["writes"], 0)

    def test_sync_lock_does_not_make_unstarted_task_an_open_code_pr(self):
        result = self.browser(payload_for("M1-T1"), maintenance={
            "pendingTasks": ["M1-T1"], "needsReview": []},
            actions=[{"kind": "review", "id": "M1-T1"}])
        self.assertIn("本任务尚未开始实现", result["copied"][0])
        self.assertEqual(result["tasks"]["M1-T1"]["state"], "review")
        self.assertEqual(result["local"], {})
        self.assertEqual(result["writes"], 0)

    def test_landed_revalidation_review_and_resume_use_merged_code_and_history(self):
        for ready in (False, True):
            with self.subTest(contract_ready=ready):
                payload = payload_for("M1-T1")
                payload["handoff"]["readiness"]["M1-T1"]["ready"] = ready
                result = self.browser(payload, {"M1-T1": "done"}, {
                    "pendingTasks": [], "needsReview": ["M1-T1"]},
                    actions=[{"kind": "review", "id": "M1-T1"},
                             {"kind": "resume", "id": "M1-T1"}],
                    local={"M1-T1": "done"})
                for text in result["copied"]:
                    self.assertIn("复验已落地任务", text)
                    self.assertIn("已合入 main", text)
                    self.assertIn("历史 PR 只作为", text)
                    self.assertIn("不要创建空 PR", text)
                    self.assertIn("确有代码差异才", text)
                    self.assertIn("verify 只登记文档契约复核", text)
                    self.assertIn("代码完成实际验收", text)
                    self.assertIn("--landed M1-T1", text)
                    for old_action in ("PR 已提", "gh stack submit", "gh stack merge",
                                       "gh pr merge", "git worktree add", "沿用分支 task/M1-T1"):
                        self.assertNotIn(old_action, text)
                self.assertEqual(result["tasks"]["M1-T1"]["state"], "review")
                self.assertEqual(result["tasks"]["M1-T1"]["fileState"], "done")
                self.assertEqual(result["local"], {"M1-T1": "done"})
                self.assertEqual(result["writes"], 0)

    def test_landed_revalidation_respects_project_main_branch(self):
        payload = payload_for("M1-T1")
        payload["pres"]["handoff"]["mainBranch"] = "trunk"
        result = self.browser(payload, {"M1-T1": "done"}, {
            "pendingTasks": [], "needsReview": ["M1-T1"]})
        for kind in ("review", "resume"):
            text = result["tasks"]["M1-T1"][kind]
            self.assertIn("已合入 trunk", text)
            self.assertNotIn("直接修改 main", text)
            self.assertNotIn("已合入 main", text)

    def test_active_task_keeps_open_pr_flow_and_copy_advances_only_once(self):
        result = self.browser(payload_for("M1-T1"), local={"M1-T1": "doing"}, actions=[
            {"kind": "review", "id": "M1-T1"}, {"kind": "review", "id": "M1-T1"}])
        for text in result["copied"]:
            self.assertIn("代码在栈分支 task/M1-T1，PR 已提", text)
            self.assertIn("gh pr merge", text)
            self.assertIn("gh stack merge", text)
            self.assertNotIn("复验已落地任务", text)
        self.assertIn("沿用分支 task/M1-T1、现有工作树和原 PR",
                      result["tasks"]["M1-T1"]["resume"])
        self.assertEqual(result["local"], {"M1-T1": "review"})
        self.assertEqual(result["writes"], 1)

    def test_review_flag_without_done_history_keeps_existing_code_review(self):
        result = self.browser(payload_for("M1-T1"), {"M1-T1": "review"}, {
            "pendingTasks": [], "needsReview": ["M1-T1"]})
        self.assertIn("PR 已提", result["tasks"]["M1-T1"]["review"])
        self.assertIn("沿用分支 task/M1-T1", result["tasks"]["M1-T1"]["resume"])

    def test_browser_and_export_share_core_and_keep_export_fields(self):
        payload = payload_for("M1-T1", "M1-T2", "M1-T3")
        original = copy.deepcopy(payload)
        progress = {"M1-T2": "doing", "M1-T3": "done"}
        maintenance = {"pendingTasks": [], "needsReview": ["M1-T3"]}
        browser = self.browser(payload, progress, maintenance)
        exported = self.run_node(["node", str(RUN / "compile_prompts.js")], {
            "payload": payload, "core": self.compiler_core(progress, maintenance)})
        for tid in exported:
            with self.subTest(task=tid):
                self.assertEqual(set(exported[tid]), {"contractHash", "implementation", "review", "resume"})
                self.assertEqual(exported[tid], browser["tasks"][tid]["compiled"])
        self.assertIn("本任务尚未开始实现", browser["tasks"]["M1-T1"]["review"])
        # Exports keep the existing code-review field; pre-start UI routing is separate.
        self.assertIn("PR 已提", exported["M1-T1"]["review"])
        self.assertIn("复验已落地任务", exported["M1-T3"]["review"])
        self.assertIn("继续复验已落地任务", exported["M1-T3"]["resume"])
        self.assertEqual(payload, original)

    # ---- 实施解锁只看前置是否落地；契约语义复核在审查阶段登记 ----

    def test_dependency_must_land_and_unrelated_batch_siblings_do_not_block(self):
        result = self.browser(chain(), progress={"M1-T1": "done"}, local={"M1-T3": "doing"})
        self.assertFalse(result["tasks"]["M1-T2"]["locked"])
        self.assertIn("# 实现任务 M1-T2", result["tasks"]["M1-T2"]["implementation"])
        self.assertTrue(result["tasks"]["M1-T1"]["locked"])  # 已落地的不再派
        self.assertTrue(result["tasks"]["M1-T3"]["locked"])  # 进行中的不重复派
        self.assertTrue(result["tasks"]["M1-T4"]["locked"])  # 前置 M1-T2 还没落地
        self.assertEqual(result["tasks"]["M1-T4"]["implementation"], "")

    def test_dependency_in_progress_review_or_revalidation_keeps_downstream_locked(self):
        for state in ("todo", "doing", "review"):
            with self.subTest(prerequisite=state):
                local = {} if state == "todo" else {"M1-T1": state}
                result = self.browser(chain(), local=local)
                self.assertTrue(result["tasks"]["M1-T2"]["locked"])
                self.assertEqual(result["tasks"]["M1-T2"]["implementation"], "")
        # 已落地的前置被补丁标为待复验时显示「审查中」，下游重新锁住：标记必须尽快按复验流程清除
        result = self.browser(chain(), progress={"M1-T1": "done"},
                              maintenance={"pendingTasks": [], "needsReview": ["M1-T1"]})
        self.assertEqual(result["tasks"]["M1-T1"]["state"], "review")
        self.assertTrue(result["tasks"]["M1-T2"]["locked"])

    def test_maintenance_progress_and_structural_blocks_still_prevent_implementation(self):
        landed = {"M1-T1": "done"}
        explicit = chain()
        explicit["handoff"]["readiness"]["M1-T2"] = {
            "ready": False, "blockers": ["M1-T2 缺少能力前置 M1-T9"], "reasons": ["M1-T2 缺少能力前置 M1-T9"]}
        self.assertTrue(self.browser(explicit, progress=landed)["tasks"]["M1-T2"]["locked"])
        stale = chain()
        stale["handoff"]["readiness"]["M1-T2"] = {
            "ready": False, "blockers": ["结构检查缺失或已过期，运行维护同步命令"],
            "reasons": ["任务契约待语义复核；可在当前审查内完成，无需重跑生成流程", "结构检查缺失或已过期，运行维护同步命令"]}
        self.assertTrue(self.browser(stale, progress=landed)["tasks"]["M1-T2"]["locked"])
        missing = chain()
        del missing["handoff"]["readiness"]["M1-T2"]
        self.assertTrue(self.browser(missing, progress=landed)["tasks"]["M1-T2"]["locked"])
        syncing = self.browser(chain(), progress=landed,
                               maintenance={"pendingTasks": ["M1-T2"], "needsReview": []})
        self.assertTrue(syncing["tasks"]["M1-T2"]["locked"])
        self.assertEqual(syncing["tasks"]["M1-T2"]["state"], "review")
        # 只是还没登记语义复核：不锁
        self.assertFalse(self.browser(chain(), progress=landed)["tasks"]["M1-T2"]["locked"])

    def test_unlocked_implementation_copy_advances_once_without_landing(self):
        result = self.browser(chain(), progress={"M1-T1": "done"}, actions=[
            {"kind": "impl", "id": "M1-T2"}, {"kind": "impl", "id": "M1-T2"}])
        self.assertEqual(len(result["copied"]), 1)
        self.assertIn("# 实现任务 M1-T2", result["copied"][0])
        self.assertEqual(result["local"], {"M1-T2": "doing"})
        self.assertEqual(result["writes"], 1)
        self.assertEqual(result["tasks"]["M1-T2"]["state"], "doing")
        self.assertEqual(result["tasks"]["M1-T2"]["fileState"], "todo")
        self.assertTrue(result["tasks"]["M1-T4"]["locked"])

    def test_locked_implementation_copy_cannot_advance_task(self):
        result = self.browser(chain(), progress={"M1-T1": "done"}, actions=[
            {"kind": "impl", "id": "M1-T4"}])
        self.assertEqual(result["copied"], [])
        self.assertEqual(result["local"], {})
        self.assertEqual(result["writes"], 0)
        self.assertEqual(result["tasks"]["M1-T4"]["state"], "todo")

    def test_review_prompt_registers_contract_verification_for_dispatched_task(self):
        result = self.browser(chain(), progress={"M1-T1": "done"}, local={"M1-T2": "doing"})
        text = result["tasks"]["M1-T2"]["review"]
        self.assertIn("契约复核是审查的一部分", text)
        self.assertIn("verify --task M1-T2", text)
        self.assertIn("--landed M1-T2", text)


if __name__ == "__main__":
    unittest.main()
