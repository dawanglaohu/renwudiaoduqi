import type { DocumentDefaultAssignment } from '@agent-scheduler/shared/api/document-execution';

export interface DocumentPlanBatchInput {
	readonly id: string;
	readonly batchNo: number;
}

export interface DocumentPlanTaskInput {
	readonly id: string;
	readonly batchId: string | null;
	readonly taskKey: string;
	readonly contractHash: string;
	readonly isRemovedFromDoc: boolean;
}

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
	members: readonly Pick<DocumentPlanTaskInput, 'taskKey' | 'contractHash'>[],
	hash: (value: string) => string,
): string {
	const pairs = members.map((member) => [member.taskKey, member.contractHash]);
	pairs.sort((left, right) => {
		const a = left[0] ?? '';
		const b = right[0] ?? '';
		return a < b ? -1 : a > b ? 1 : 0;
	});
	return hash(JSON.stringify(pairs));
}

export function buildDocumentPlan(
	batches: readonly DocumentPlanBatchInput[],
	tasks: readonly DocumentPlanTaskInput[],
	version: number,
	hash: (value: string) => string,
	previous: DocumentPlan = [],
): DocumentPlan {
	const byId = new Map(previous.map((entry) => [entry.batchId, entry]));
	return batches.flatMap((batch) => {
		const members = tasks
			.filter((task) => task.batchId === batch.id && !task.isRemovedFromDoc)
			.map((task) => ({
				taskId: task.id,
				taskKey: task.taskKey,
				contractHash: task.contractHash,
			}))
			.sort((a, b) => (a.taskKey < b.taskKey ? -1 : a.taskKey > b.taskKey ? 1 : 0));
		if (members.length === 0) return [];
		const fingerprint = membershipFingerprint(members, hash);
		const old = byId.get(batch.id);
		const unchanged = old?.membershipFingerprint === fingerprint;
		return [
			{
				batchId: batch.id,
				batchNo: batch.batchNo,
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
