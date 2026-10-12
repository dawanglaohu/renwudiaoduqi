import { describe, expect, it } from 'vitest';
import { buildDocumentPlan, membershipFingerprint } from '../../src/domain/document-execution.ts';
import type {
	DocumentPlanBatchInput,
	DocumentPlanTaskInput,
} from '../../src/domain/document-execution.ts';

const hash = (value: string) => value;
const batch = {
	id: 'batch-1',
	batchNo: 1,
} satisfies DocumentPlanBatchInput;
const task = {
	id: 'task-1',
	batchId: 'batch-1',
	taskKey: 'M1-T1',
	contractHash: 'hash-1',
	isRemovedFromDoc: false,
} satisfies DocumentPlanTaskInput;

describe('document plan membership', () => {
	it('uses sorted task keys and contract hashes, independent of readiness', () => {
		const a = { ...task, id: 'task-2', taskKey: 'M1-T2' };
		const notReady = { ...task, isContractReady: false };
		const expected = membershipFingerprint([task, a], hash);
		expect(membershipFingerprint([a, task], hash)).toBe(expected);
		expect(membershipFingerprint([notReady, a], hash)).toBe(expected);
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
		const notReady = { ...task, isContractReady: false };
		const same = buildDocumentPlan([batch], [notReady], 2, hash, previous);
		expect(same[0]).toMatchObject({
			generationId: 1,
			wrapupRunIds: ['wrapup-1'],
			completion: previous[0]?.completion,
		});
		const changed = buildDocumentPlan(
			[batch],
			[{ ...task, contractHash: 'hash-2' }],
			3,
			hash,
			previous,
		);
		expect(changed[0]).toMatchObject({ generationId: 3, wrapupRunIds: [], completion: null });
	});
});
