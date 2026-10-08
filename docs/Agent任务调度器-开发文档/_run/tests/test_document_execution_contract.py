"""文档执行合同与控制版本、指派格式、收口成员的接缝检查。"""
import json
from collections import defaultdict
from pathlib import Path
import re
import unittest

DOCS_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = DOCS_ROOT.parent.parent
TASKS = ('M8-T12', 'M8-T13', 'M9-T30', 'M1-T12')


def control_requests():
    text = (DOCS_ROOT / '05-附录/22-决策记录.md').read_text(encoding='utf-8')
    rows = {}
    for line in text.splitlines():
        cells = [cell.strip().strip('`') for cell in line.split('|')[1:-1]]
        if len(cells) == 4 and cells[0] == 'POST' and '/execution/' in cells[1]:
            rows[cells[1].rsplit('/', 1)[1]] = cells[2]
    return rows


class DocumentExecutionContractTests(unittest.TestCase):
    def test_mutating_controls_carry_the_observed_client_version(self):
        rows = control_requests()
        self.assertEqual(set(rows), {'start', 'pause', 'resume'})
        for action, body in rows.items():
            with self.subTest(action=action):
                self.assertIn('expectedVersion', body)

    def test_document_defaults_use_existing_effort_value_union(self):
        body = control_requests()['start']
        self.assertIn('effort: EffortValue', body)
        self.assertNotIn('effortTier', body)
        agents = (REPO_ROOT / 'packages/shared/src/api/agents.ts').read_text(encoding='utf-8')
        self.assertRegex(agents, r'export type EffortValue\s*=.*tier:.*vendor:.*null;')
        draft = (REPO_ROOT / 'packages/shared/src/api/batches.ts').read_text(encoding='utf-8')
        self.assertIn('readonly effort?: EffortValue;', draft)

    def test_both_dispatch_and_review_prompts_cover_the_two_contract_seams(self):
        dispatch = json.loads((DOCS_ROOT / '_run/dispatch.json').read_text(encoding='utf-8'))
        for task in TASKS:
            for side in ('implementation', 'review'):
                with self.subTest(task=task, side=side):
                    prompt = dispatch['tasks'][task][side]
                    self.assertIn('expectedVersion', prompt)
                    self.assertIn('EffortValue', prompt)

    def test_done_reuse_requires_a_matching_membership_proof(self):
        text = (DOCS_ROOT / '05-附录/22-决策记录.md').read_text(encoding='utf-8')
        extension = text.split('## 文档级顺序自动执行', 1)[1]
        self.assertIn('membershipFingerprint', extension)
        self.assertIn('completionFingerprint', extension)
        self.assertIn('tasks_json', extension)
        self.assertIn('finished_at', extension)
        self.assertNotIn('已 done 批次和既有运行不重跑', extension)
        self.assertNotIn('保留已完成批次与历史运行，重新规划未完成部分', extension)

    def test_new_batch_members_cannot_be_skipped_in_generated_prompts(self):
        dispatch = json.loads((DOCS_ROOT / '_run/dispatch.json').read_text(encoding='utf-8'))
        for task in TASKS:
            for side in ('implementation', 'review'):
                with self.subTest(task=task, side=side):
                    prompt = dispatch['tasks'][task][side]
                    self.assertIn('membershipFingerprint', prompt)
                    self.assertIn('已完成批次新增任务', prompt)

    def test_batch_invalidation_has_authorized_state_machine_paths(self):
        run = DOCS_ROOT / '_run'
        contracts = json.loads((run / 'task-contracts.json').read_text(encoding='utf-8'))['tasks']
        paths = json.loads((run / 'presentation.json').read_text(encoding='utf-8'))['handoff']['taskPaths']
        required = ('packages/daemon/src/domain/batch-state-machine.ts',
                    'packages/daemon/src/service/batch.ts',
                    'packages/daemon/test/unit/batch-state-machine.test.ts',
                    'packages/daemon/test/arch/batch-state-isolation.test.ts')
        for task in ('M8-T12', 'M8-T13'):
            effective = set(paths[task] + contracts[task]['supportPaths'])
            for path in required:
                with self.subTest(task=task, path=path):
                    self.assertIn(path, effective)
        extension = (DOCS_ROOT / '05-附录/22-决策记录.md').read_text(encoding='utf-8').split('## 文档级顺序自动执行', 1)[1]
        self.assertIn('transitionBatchInTx', extension)
        self.assertIn('membership_invalidated', extension)

    def test_membership_generations_have_separate_bounded_wrapup_budgets(self):
        extension = (DOCS_ROOT / '05-附录/22-决策记录.md').read_text(encoding='utf-8').split('## 文档级顺序自动执行', 1)[1]
        for term in ('generationId', 'wrapupRunIds', '2轮有效自动收口', '6次物理尝试', '历史编号继续全局递增'):
            self.assertIn(term, extension)

    def test_generation_budget_is_in_every_implementation_and_review_prompt(self):
        dispatch = json.loads((DOCS_ROOT / '_run/dispatch.json').read_text(encoding='utf-8'))
        for task in TASKS:
            for side in ('implementation', 'review'):
                with self.subTest(task=task, side=side):
                    self.assertIn('generationId', dispatch['tasks'][task][side])
                    self.assertIn('6次物理尝试', dispatch['tasks'][task][side])

    def test_milestone_totals_match_current_task_and_module_estimates(self):
        expected = defaultdict(lambda: [0, 0.0])
        tasks = (DOCS_ROOT / '04-执行/19-模块任务拆分.md').read_text(encoding='utf-8')
        for line in tasks.splitlines():
            cells = [c.strip() for c in line.split('|')[1:-1]]
            if len(cells) == 8 and re.fullmatch(r'M\d+-T\d+', cells[0]):
                expected[cells[2]][0] += 1
                expected[cells[2]][1] += float(re.fullmatch(r'([\d.]+)d', cells[7])[1])
        total_tasks = sum(value[0] for value in expected.values())
        total_days = sum(value[1] for value in expected.values())
        milestones = (DOCS_ROOT / '04-执行/20-里程碑与交付顺序.md').read_text(encoding='utf-8')
        declared = re.search(r'总量\s*(\d+)\s*个任务、([\d.]+)\s*人天', milestones)
        self.assertIsNotNone(declared)
        self.assertEqual((int(declared[1]), float(declared[2])), (total_tasks, total_days))
        modules, phase_days = {}, 0.0
        for line in milestones.splitlines():
            cells = [c.strip() for c in line.split('|')[1:-1]]
            if len(cells) == 3 and re.fullmatch(r'M\d+', cells[0]):
                modules[cells[0]] = [int(cells[1]), float(cells[2])]
            elif len(cells) == 4 and re.fullmatch(r'[\d.]+', cells[2]):
                phase_days += float(cells[2])
        self.assertEqual(modules, dict(expected))
        self.assertEqual(phase_days, total_days)


if __name__ == '__main__':
    unittest.main()
