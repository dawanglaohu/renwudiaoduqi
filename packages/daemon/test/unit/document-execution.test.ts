import { describe, expect, it } from 'vitest';
import { buildDocumentPlan, membershipFingerprint } from '../../src/domain/document-execution.ts';
import type { BatchRow } from '../../src/repo/batches.ts';
import type { TaskRow } from '../../src/repo/tasks.ts';

const hash = (value: string) => value;
const batch = {
	id: 'batch-1',
	doc_id: 'doc-1',
	batch_no: 1,
	state: 'done',
	started_at: null,
	finished_at: null,
} as BatchRow;
const task = {
	id: 'task-1',
	doc_id: 'doc-1',
	batch_id: 'batch-1',
	task_key: 'M1-T1',
	contract_hash: 'hash-1',
	is_removed_from_doc: 0,
} as TaskRow;

describe('document plan membership', () => {
	it('uses sorted task keys and contract hashes, independent of readiness', () => {
		const a = { ...task, id: 'task-2', task_key: 'M1-T2' };
		const expected = membershipFingerprint([task, a], hash);
		expect(membershipFingerprint([a, task], hash)).toBe(expected);
		expect(membershipFingerprint([{ ...task, is_contract_ready: 0 }, a], hash)).toBe(expected);
	});

	it('retains a generation only for unchanged members and clears stale completion evidence', () => {
		const first = buildDocumentPlan([batch], [task], 1, hash);
		const baseline = first[0];
		expect(baseline).toBeDefined();
		if (!baseline) return;
		const previous = [
			{
				...baseline,
				wrapupRunIds: ['wrapup-1'],
				completion: {
					wrapupId: 'verdict-1',
					completionFingerprint: baseline.membershipFingerprint,
				},
			},
		];
		const same = buildDocumentPlan([batch], [{ ...task, is_contract_ready: 0 }], 2, hash, previous);
		expect(same[0]).toMatchObject({
			generationId: 1,
			wrapupRunIds: ['wrapup-1'],
			completion: previous[0]?.completion,
		});
		const changed = buildDocumentPlan(
			[batch],
			[{ ...task, contract_hash: 'hash-2' }],
			3,
			hash,
			previous,
		);
		expect(changed[0]).toMatchObject({ generationId: 3, wrapupRunIds: [], completion: null });
	});
});
