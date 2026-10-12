import type { DocumentDefaultAssignment } from '@agent-scheduler/shared/api/document-execution';
import type { BatchRow } from '../repo/batches.ts';
import type { TaskRow } from '../repo/tasks.ts';

export interface DocumentPlanBatch {
	readonly batchId: string;
	readonly batchNo: number;
	readonly members: readonly {
		readonly taskId: string;
		readonly taskKey: string;
		readonly contractHash: string;
	}[];
	readonly membershipFingerprint: string;
	readonly generationId: number;
	readonly wrapupRunIds: readonly string[];
	readonly completion: { readonly wrapupId: string; readonly completionFingerprint: string } | null;
}

export type DocumentPlan = readonly DocumentPlanBatch[];

export function membershipFingerprint(
	members: readonly Pick<TaskRow, 'task_key' | 'contract_hash'>[],
	hash: (value: string) => string,
): string {
	const pairs = members.map((member) => [member.task_key, member.contract_hash]);
	pairs.sort((left, right) => {
		const a = left[0] ?? '';
		const b = right[0] ?? '';
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return hash(JSON.stringify(pairs));
}

export function buildDocumentPlan(
	batches: readonly BatchRow[],
	tasks: readonly TaskRow[],
	version: number,
	hash: (value: string) => string,
	previous: DocumentPlan = [],
): DocumentPlan {
	const byId = new Map(previous.map((entry) => [entry.batchId, entry]));
	return batches.flatMap((batch) => {
		const members = tasks
			.filter((task) => task.batch_id === batch.id && task.is_removed_from_doc === 0)
			.map((task) => ({
				taskId: task.id,
				taskKey: task.task_key,
				contractHash: task.contract_hash,
			}))
			.sort((a, b) => (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0));
		if (members.length === 0) return [];
		const fingerprint = membershipFingerprint(
			members.map((member) => ({ task_key: member.taskKey, contract_hash: member.contractHash })),
			hash,
		);
		const old = byId.get(batch.id);
		const unchanged = old?.membershipFingerprint === fingerprint;
		return [
			{
				batchId: batch.id,
				batchNo: batch.batch_no,
				members,
				membershipFingerprint: fingerprint,
				generationId: unchanged ? old.generationId : version,
				wrapupRunIds: unchanged ? old.wrapupRunIds : [],
				completion: unchanged ? old.completion : null,
			},
		];
	});
}

export function sameAssignment(
	a: DocumentDefaultAssignment | null,
	b: DocumentDefaultAssignment,
): boolean {
	if (!a || a.agentId !== b.agentId || a.modelName !== b.modelName) return false;
	if (a.effort === null || b.effort === null) return a.effort === b.effort;
	if ('tier' in a.effort) return 'tier' in b.effort && a.effort.tier === b.effort.tier;
	return 'vendor' in b.effort && a.effort.vendor === b.effort.vendor;
}
