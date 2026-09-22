import type { EffortValue, EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import type {
	BatchAssignmentsResponse,
	ConcurrencyPreview,
	TaskAssignmentDraft,
	TaskAssignmentDto,
} from '@agent-scheduler/shared/api/batches';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import {
	type ReleasableTaskCandidate,
	buildConcurrencyPreview,
	listReleasableTaskIds,
	numberDraftSessions,
} from '../domain/concurrency.ts';
import { isEffortTier } from '../domain/effort-tier.ts';
import { assertVendorEffortInDomain } from '../domain/effort-value.ts';
import { isTaskLanded } from '../domain/path-clash.ts';
import {
	type RunState,
	countsTowardAgentConcurrency,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';

/**
 * Shape persisted in `tasks.assignment_draft_json` (09 节): the draft as posted plus the write
 * time. Dispatch reads it through `parseAssignmentDraft()`; nothing else parses the column.
 */
export interface StoredAssignmentDraft {
	readonly agentId: string;
	readonly model: string | null;
	readonly effort: EffortValue;
	readonly draftedAt: string;
}

/** Registry facts the service needs per agent; the caller projects them from the registry. */
export interface RegistryAgentSummary {
	readonly agentId: string;
	readonly maxConcurrency: number;
	readonly effortVendorMap: EffortVendorMap;
}

export interface AssignmentsServiceDeps {
	readonly unitOfWork?: UnitOfWork;
	readonly tasksRepo: TasksRepo;
	readonly batchesRepo: BatchesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly runsRepo: RunsRepo;
	readonly clock: { readonly now: () => string };
	/** Every agent in the registry, whatever its availability or login state (E-336). */
	readonly listRegistryAgents: () => readonly RegistryAgentSummary[];
	/**
	 * Vendor reasoning-effort values accepted for an agent (config current value, live model
	 * options). Without it, only the registry `effortVendorMap` values are accepted.
	 */
	readonly listVendorEffortDomain?: (
		agentId: string,
	) => Promise<readonly string[]> | readonly string[];
}

export interface PutDraftsInput {
	readonly batchId: string;
	readonly assignments: readonly TaskAssignmentDraft[];
	readonly actorDeviceId?: string | null;
}

export interface AssignmentsService {
	/** Drafts of the batch's pending tasks, taskKey order, with their preview session numbers. */
	readDrafts(batchId: string): readonly TaskAssignmentDto[];
	/** Concurrency preview of the batch computed from the pending drafts (E-52, E-245). */
	previewConcurrency(batchId: string): ConcurrencyPreview;
	/** Both halves of the GET response from one consistent read. */
	readAssignments(batchId: string): BatchAssignmentsResponse;
	/** Whole-batch overwrite: pending tasks not listed lose their draft (E-108). */
	putDrafts(input: PutDraftsInput): Promise<BatchAssignmentsResponse>;
}

const TERMINAL_FAILURE_STATES: readonly string[] = Object.freeze([
	'failed',
	'aborted',
	'interrupted',
]);

function parseEffortValue(value: unknown): EffortValue | undefined {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== 'object') {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (isEffortTier(record.tier)) {
		return Object.freeze({ tier: record.tier });
	}
	if (typeof record.vendor === 'string' && record.vendor.length > 0) {
		return Object.freeze({ vendor: record.vendor });
	}
	return undefined;
}

/**
 * Decodes `tasks.assignment_draft_json`. Anything that is not a complete draft written by
 * `putDrafts()` reads as "no draft", so a damaged column falls back to the M8-T3 agent choice
 * instead of blocking dispatch.
 */
export function parseAssignmentDraft(
	json: string | null | undefined,
): StoredAssignmentDraft | null {
	if (!json) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== 'object') {
		return null;
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.agentId !== 'string' || record.agentId.length === 0) {
		return null;
	}
	if (typeof record.draftedAt !== 'string' || record.draftedAt.length === 0) {
		return null;
	}
	const effort = parseEffortValue(record.effort);
	if (effort === undefined) {
		return null;
	}
	const model = typeof record.model === 'string' && record.model.length > 0 ? record.model : null;
	return Object.freeze({
		agentId: record.agentId,
		model,
		effort,
		draftedAt: record.draftedAt,
	});
}

interface BatchTaskFacts {
	readonly task: TaskRow;
	readonly isLanded: boolean;
	readonly hasActiveRun: boolean;
	readonly isTerminalFailed: boolean;
	readonly isRemovedFromDoc: boolean;
	readonly draft: StoredAssignmentDraft | null;
}

function isPending(facts: BatchTaskFacts): boolean {
	return (
		!facts.isLanded && !facts.hasActiveRun && !facts.isTerminalFailed && !facts.isRemovedFromDoc
	);
}

function latestRunOf(runs: readonly RunRow[]): RunRow | null {
	let latest: RunRow | null = null;
	for (const run of runs) {
		if (!latest || run.attempt_no > latest.attempt_no) {
			latest = run;
		}
	}
	return latest;
}

export function createAssignmentsService(deps: AssignmentsServiceDeps): AssignmentsService {
	function requireBatch(batchId: string) {
		if (!batchId || typeof batchId !== 'string' || batchId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'batchId must be a non-empty string', {
				details: { field: 'batchId' },
			});
		}
		const batch = deps.batchesRepo.findById(batchId);
		if (!batch) {
			throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`, {
				details: { batchId },
			});
		}
		const doc = deps.documentsRepo.findById(batch.doc_id);
		if (!doc) {
			throw new AppError('E_NOT_FOUND', `Document not found: ${batch.doc_id}`, {
				details: { docId: batch.doc_id },
			});
		}
		return { batch, doc };
	}

	function isTaskLandedAnywhere(task: TaskRow, runs: readonly RunRow[]): boolean {
		return isTaskLanded(task.manual_state) || runs.some((run) => run.state === 'landed');
	}

	function collectTaskFacts(batchId: string): readonly BatchTaskFacts[] {
		const activeTaskIds = new Set(
			deps.runsRepo
				.listActive()
				.map((run) => run.task_id)
				.filter((taskId): taskId is string => taskId !== null),
		);
		return deps.tasksRepo.listByBatchId(batchId).map((task) => {
			const runs = deps.runsRepo.listByTaskId(task.id);
			const latest = latestRunOf(runs);
			const isTerminalFailed =
				latest !== null &&
				isTerminalRunState(latest.state as RunState) &&
				TERMINAL_FAILURE_STATES.includes(latest.state);
			return Object.freeze({
				task,
				isLanded: isTaskLandedAnywhere(task, runs),
				hasActiveRun: activeTaskIds.has(task.id),
				isTerminalFailed,
				isRemovedFromDoc: task.is_removed_from_doc === 1,
				draft: parseAssignmentDraft(task.assignment_draft_json),
			});
		});
	}

	function landedTaskKeysOfDoc(docId: string): ReadonlySet<string> {
		const landed = new Set<string>();
		for (const task of deps.tasksRepo.listByDocId(docId)) {
			if (isTaskLandedAnywhere(task, deps.runsRepo.listByTaskId(task.id))) {
				landed.add(task.task_key);
			}
		}
		return landed;
	}

	function countActiveRunsByAgent(): (agentId: string) => number {
		const counts = new Map<string, number>();
		for (const run of deps.runsRepo.listActive()) {
			if (countsTowardAgentConcurrency(run.state as RunState)) {
				counts.set(run.agent_id, (counts.get(run.agent_id) ?? 0) + 1);
			}
		}
		return (agentId) => counts.get(agentId) ?? 0;
	}

	function computeBatchView(batchId: string): BatchAssignmentsResponse {
		const { batch, doc } = requireBatch(batchId);
		const facts = collectTaskFacts(batch.id);
		const registryAgents = deps.listRegistryAgents();
		const limitByAgent = new Map(
			registryAgents.map((agent) => [agent.agentId, agent.maxConcurrency] as const),
		);
		const activeRunsByAgent = countActiveRunsByAgent();

		const landedKeys = landedTaskKeysOfDoc(doc.id);
		const candidates: ReleasableTaskCandidate[] = facts.map((item) => {
			let depKeys: string[] = [];
			try {
				depKeys = JSON.parse(item.task.deps_json);
			} catch {
				depKeys = [];
			}
			return Object.freeze({
				taskId: item.task.id,
				taskKey: item.task.task_key,
				deps: Object.freeze(depKeys),
				isLanded: item.isLanded,
				hasActiveRun: item.hasActiveRun,
				isRemovedFromDoc: item.isRemovedFromDoc,
				isTerminalFailed: item.isTerminalFailed,
			});
		});
		const windowCount = listReleasableTaskIds(candidates, landedKeys).length;

		const pendingDrafts = facts.filter(
			(item): item is BatchTaskFacts & { readonly draft: StoredAssignmentDraft } =>
				isPending(item) && item.draft !== null,
		);
		const sessionNoByTaskId = numberDraftSessions(
			pendingDrafts.map((item) => ({
				taskId: item.task.id,
				taskKey: item.task.task_key,
				agentId: item.draft.agentId,
			})),
			activeRunsByAgent,
		);
		const drafts: TaskAssignmentDto[] = pendingDrafts.map((item) =>
			Object.freeze({
				taskId: item.task.id,
				taskKey: item.task.task_key,
				agentId: item.draft.agentId,
				model: item.draft.model,
				effort: item.draft.effort,
				sessionNo: sessionNoByTaskId.get(item.task.id) ?? 1,
				draftedAt: item.draft.draftedAt,
			}),
		);

		const preview = buildConcurrencyPreview({
			userSetting: doc.lane_count,
			windowCount,
			drafts: pendingDrafts.map((item) => ({
				taskId: item.task.id,
				agentId: item.draft.agentId,
			})),
			agentIds: registryAgents.map((agent) => agent.agentId),
			activeRunsByAgent,
			agentLimits: (agentId) => limitByAgent.get(agentId) ?? 1,
		});

		return Object.freeze({ drafts: Object.freeze(drafts), preview });
	}

	function rejectTask(index: number, reason: string, taskId: string): never {
		throw new AppError('E_VALIDATION', `assignments[${index}].taskId is not draftable: ${reason}`, {
			details: { field: `assignments[${index}].taskId`, reason, taskId },
		});
	}

	async function validateEffort(
		index: number,
		agent: RegistryAgentSummary,
		effort: EffortValue,
	): Promise<void> {
		if (effort === null) {
			return;
		}
		const field = `assignments[${index}].effort`;
		if (agent.effortVendorMap === null) {
			throw new AppError(
				'E_VALIDATION',
				`Agent '${agent.agentId}' does not support reasoning effort.`,
				{ details: { field, reason: 'effort_unsupported', agentId: agent.agentId } },
			);
		}
		if ('vendor' in effort) {
			const domain = new Set<string>(Object.values(agent.effortVendorMap));
			if (deps.listVendorEffortDomain) {
				for (const value of await deps.listVendorEffortDomain(agent.agentId)) {
					domain.add(value);
				}
			}
			assertVendorEffortInDomain(effort.vendor, Array.from(domain), field);
		}
	}

	async function putDrafts(input: PutDraftsInput): Promise<BatchAssignmentsResponse> {
		const { batch } = requireBatch(input.batchId);
		if (!Array.isArray(input.assignments)) {
			throw new AppError('E_VALIDATION', 'assignments must be an array', {
				details: { field: 'assignments' },
			});
		}

		const facts = collectTaskFacts(batch.id);
		const factsByTaskId = new Map(facts.map((item) => [item.task.id, item] as const));
		const agentsById = new Map(
			deps.listRegistryAgents().map((agent) => [agent.agentId, agent] as const),
		);

		const draftByTaskId = new Map<string, StoredAssignmentDraft>();
		const draftedAt = deps.clock.now();
		for (const [index, assignment] of input.assignments.entries()) {
			const taskId = assignment.taskId;
			const item = factsByTaskId.get(taskId);
			if (!item) {
				rejectTask(index, 'task_not_in_batch', taskId);
			}
			if (draftByTaskId.has(taskId)) {
				rejectTask(index, 'duplicate_task', taskId);
			}
			if (item.isRemovedFromDoc) {
				rejectTask(index, 'task_removed_from_doc', taskId);
			}
			if (item.isLanded) {
				rejectTask(index, 'task_landed', taskId);
			}
			if (item.hasActiveRun || item.isTerminalFailed) {
				rejectTask(index, 'task_dispatched', taskId);
			}

			const agent = agentsById.get(assignment.agentId);
			if (!agent) {
				throw new AppError(
					'E_VALIDATION',
					`assignments[${index}].agentId '${assignment.agentId}' is not in the agent registry`,
					{
						details: {
							field: `assignments[${index}].agentId`,
							reason: 'agent_not_registered',
							agentId: assignment.agentId,
						},
					},
				);
			}

			const effort = parseEffortValue(assignment.effort);
			if (effort === undefined) {
				throw new AppError('E_VALIDATION', `assignments[${index}].effort is malformed`, {
					details: { field: `assignments[${index}].effort`, reason: 'effort_malformed' },
				});
			}
			await validateEffort(index, agent, effort);

			const model =
				typeof assignment.model === 'string' && assignment.model.trim().length > 0
					? assignment.model
					: null;
			draftByTaskId.set(
				taskId,
				Object.freeze({ agentId: agent.agentId, model, effort, draftedAt }),
			);
		}

		const writes: Array<{ readonly taskId: string; readonly json: string | null }> = [];
		for (const item of facts) {
			if (!isPending(item)) {
				continue;
			}
			const draft = draftByTaskId.get(item.task.id);
			writes.push({
				taskId: item.task.id,
				json: draft ? JSON.stringify(draft) : null,
			});
		}

		const persist = () => {
			for (const write of writes) {
				deps.tasksRepo.setAssignmentDraft(write.taskId, write.json);
			}
		};
		if (deps.unitOfWork) {
			deps.unitOfWork.run(persist);
		} else {
			persist();
		}

		return computeBatchView(batch.id);
	}

	return Object.freeze({
		readDrafts(batchId: string): readonly TaskAssignmentDto[] {
			return computeBatchView(batchId).drafts;
		},
		previewConcurrency(batchId: string): ConcurrencyPreview {
			return computeBatchView(batchId).preview;
		},
		readAssignments(batchId: string): BatchAssignmentsResponse {
			return computeBatchView(batchId);
		},
		putDrafts,
	});
}
