"""新增文档执行合同与既有指派格式、控制版本的接缝检查。"""
import json
from pathlib import Path
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


if __name__ == '__main__':
    unittest.main()
