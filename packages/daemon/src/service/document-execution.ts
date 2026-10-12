import { createHash } from 'node:crypto';
import type { EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import type {
	DocumentDefaultAssignment,
	DocumentExecutionBlocker,
	DocumentExecutionDto,
	DocumentExecutionResponse,
	PauseDocumentExecutionBody,
	ResumeDocumentExecutionBody,
	StartDocumentExecutionBody,
} from '@agent-scheduler/shared/api/document-execution';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { summarizeBatchLanding } from '../domain/batch-landing.ts';
import {
	type DocumentPlan,
	type DocumentPlanBatch,
	buildDocumentPlan,
	sameAssignment,
} from '../domain/document-execution.ts';
import { assertVendorEffortInDomain } from '../domain/effort-value.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchWrapupRow, BatchWrapupsRepo } from '../repo/batch-wrapups.ts';
import type { BatchRow, BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentExecutionRow, DocumentExecutionsRepo } from '../repo/document-executions.ts';
import type { DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';
import { parseAssignmentDraft } from './assignments.ts';
import type { BatchService, TransitionBatchInTxResult } from './batch.ts';

export interface DocumentExecutionDeps {
	readonly executions: DocumentExecutionsRepo;
	readonly documents: DocumentsRepo;
	readonly batches: BatchesRepo;
	readonly tasks: TasksRepo;
	readonly runs: RunsRepo;
	readonly snapshots: DispatchSnapshotsRepo;
	readonly wrapups: BatchWrapupsRepo;
	readonly batchService: BatchService;
	readonly unitOfWork: UnitOfWork;
	readonly clock: { readonly now: () => string };
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly validateWorkspace: (docId: string) => Promise<void>;
	readonly validateSourceAtCommit: (docId: string) => void;
	readonly registeredAgent: (
		agentId: string,
	) => { readonly effortVendorMap: EffortVendorMap } | null;
	readonly listVendorEffortDomain: (agentId: string) => Promise<readonly string[]>;
	readonly modelEffortOptions: (
		agentId: string,
		modelName: string | null,
	) => readonly string[] | undefined;
	readonly isAgentAvailable: (agentId: string) => boolean;
	readonly nudgeTick?: () => void;
}

export interface DocumentExecutionService {
	readonly get: (docId: string) => DocumentExecutionResponse;
	readonly list: () => readonly DocumentExecutionDto[];
	readonly start: (
		docId: string,
		body: StartDocumentExecutionBody,
		actorDeviceId?: string | null,
	) => Promise<DocumentExecutionResponse>;
	readonly pause: (
		docId: string,
		body: PauseDocumentExecutionBody,
		actorDeviceId?: string | null,
	) => DocumentExecutionResponse;
	readonly resume: (
		docId: string,
		body: ResumeDocumentExecutionBody,
		actorDeviceId?: string | null,
	) => Promise<DocumentExecutionResponse>;
	readonly pauseRunningOnRestart: () => void;
	readonly publishIfVersionChanged: (
		docId: string,
		previousVersion: number,
		actorDeviceId?: string | null,
	) => void;
}

const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const ACTIVE_BATCH_STATES = new Set([
	'running',
	'paused',
	'awaiting_landing',
	'wrapping',
	'needs_attention',
]);

function parsePlan(json: string): DocumentPlan {
	try {
		const value: unknown = JSON.parse(json);
		if (Array.isArray(value)) return value as DocumentPlan;
	} catch {
		/* A corrupt plan must not be interpreted as an empty plan. */
	}
	throw new AppError('E_INTERNAL', 'Stored document execution plan is invalid.');
}

function parseAssignment(json: string | null): DocumentDefaultAssignment | null {
	if (json === null) return null;
	try {
		return JSON.parse(json) as DocumentDefaultAssignment;
	} catch (cause) {
		throw new AppError('E_INTERNAL', 'Stored document assignment is invalid.', { cause });
	}
}

function sameMembers(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function buildPlanFromRows(
	batches: readonly BatchRow[],
	tasks: readonly TaskRow[],
	version: number,
	previous: DocumentPlan,
): DocumentPlan {
	return buildDocumentPlan(
		batches.map((batch) => ({ id: batch.id, batchNo: batch.batch_no })),
		tasks.map((task) => ({
			id: task.id,
			batchId: task.batch_id,
			taskKey: task.task_key,
			contractHash: task.contract_hash,
			isRemovedFromDoc: task.is_removed_from_doc === 1,
		})),
		version,
		hash,
		previous,
	);
}

export function createDocumentExecutionService(
	deps: DocumentExecutionDeps,
): DocumentExecutionService {
	function requireDocument(docId: string): DocumentRow {
		const doc = deps.documents.findById(docId);
		if (!doc)
			throw new AppError('E_NOT_FOUND', `Document not found: ${docId}`, { details: { docId } });
		return doc;
	}

	function evidenceIsValid(
		entry: DocumentPlanBatch,
		batch: BatchRow,
		tasks: readonly TaskRow[],
		runs: readonly RunRow[],
	): boolean {
		if (batch.state !== 'done') return false;
		if (!entry.completion || entry.completion.completionFingerprint !== entry.membershipFingerprint)
			return false;
		const wrapup = deps.wrapups.findById(entry.completion.wrapupId);
		if (
			!wrapup ||
			wrapup.batch_id !== batch.id ||
			(wrapup.verdict !== 'clean' && wrapup.verdict !== 'fixed')
		)
			return false;
		const currentVerdicts = deps.wrapups
			.listByBatchId(batch.id)
			.filter((item) => entry.wrapupRunIds.includes(item.run_id));
		if (currentVerdicts.at(-1)?.id !== wrapup.id) return false;
		let covered: unknown;
		try {
			covered = JSON.parse(wrapup.tasks_json);
		} catch {
			return false;
		}
		const taskKeys = tasks.map((task) => task.task_key).sort();
		if (!Array.isArray(covered) || !sameMembers(covered, taskKeys)) return false;
		if (!summarizeBatchLanding(tasks, runs).allInHead) return false;
		const wrapupRun = deps.runs.findById(wrapup.run_id);
		if (!wrapupRun || wrapupRun.is_in_head !== 1) return false;
		return tasks.every((task) =>
			runs.some((run) => {
				if (
					run.task_id !== task.id ||
					run.kind !== 'implement' ||
					run.state !== 'landed' ||
					run.is_in_head !== 1
				)
					return false;
				const snapshot = deps.snapshots.findById(run.snapshot_id);
				return snapshot?.contract_hash === task.contract_hash;
			}),
		);
	}

	function adoptLegacyEvidence(
		entry: DocumentPlanBatch,
		batch: BatchRow,
		tasks: readonly TaskRow[],
		runs: readonly RunRow[],
	): DocumentPlanBatch {
		if (batch.state !== 'done') return entry;
		const latest = deps.wrapups.findLatestByBatchId(batch.id);
		if (!latest || (latest.verdict !== 'clean' && latest.verdict !== 'fixed')) return entry;
		if (!legacyCompletionIsProven(entry, latest, tasks, runs)) return entry;
		const candidate = {
			...entry,
			completion: { wrapupId: latest.id, completionFingerprint: entry.membershipFingerprint },
		};
		return evidenceIsValid(candidate, batch, tasks, runs) ? candidate : entry;
	}

	function legacyCompletionIsProven(
		entry: DocumentPlanBatch,
		wrapup: BatchWrapupRow,
		tasks: readonly TaskRow[],
		runs: readonly RunRow[],
	): boolean {
		const wrapupRun = deps.runs.findById(wrapup.run_id);
		if (!wrapupRun?.started_at) return false;
		const frozen = deps.snapshots.findById(wrapupRun.snapshot_id);
		if (!frozen?.input_text) return false;
		let input: unknown;
		try {
			input = JSON.parse(frozen.input_text);
		} catch {
			return false;
		}
		if (!input || typeof input !== 'object') return false;
		const record = input as Record<string, unknown>;
		if (
			record.generationId !== entry.generationId ||
			record.membershipFingerprint !== entry.membershipFingerprint ||
			!Array.isArray(record.members) ||
			record.members.length !== tasks.length
		)
			return false;
		const currentMembers = tasks
			.map((task) => ({ task_key: task.task_key, contractHash: task.contract_hash }))
			.sort((a, b) => (a.task_key < b.task_key ? -1 : a.task_key > b.task_key ? 1 : 0));
		if (
			!record.members.every((member, index) => {
				const expected = currentMembers[index];
				return (
					!!expected &&
					!!member &&
					typeof member === 'object' &&
					(member as Record<string, unknown>).task_key === expected.task_key &&
					(member as Record<string, unknown>).contractHash === expected.contractHash
				);
			})
		)
			return false;
		const acceptedAt = wrapupRun.started_at;
		return tasks.every((task) =>
			runs.some((run) => {
				if (
					run.task_id !== task.id ||
					run.kind !== 'implement' ||
					run.state !== 'landed' ||
					run.is_in_head !== 1 ||
					!run.ended_at ||
					run.ended_at > acceptedAt ||
					!run.in_head_checked_at ||
					run.in_head_checked_at > acceptedAt
				)
					return false;
				const snapshot = deps.snapshots.findById(run.snapshot_id);
				return snapshot?.contract_hash === task.contract_hash && snapshot.created_at <= acceptedAt;
			}),
		);
	}

	function adoptLegacyGeneration(
		entry: DocumentPlanBatch,
		batch: BatchRow,
		runs: readonly RunRow[],
	): DocumentPlanBatch {
		const historicalRuns = runs
			.filter((run) => run.kind === 'wrapup' && run.batch_id === batch.id)
			.sort((a, b) => a.attempt_no - b.attempt_no);
		if (batch.state === 'idle' && historicalRuns.length === 0) return entry;
		return {
			...entry,
			generationId: 0,
			wrapupRunIds: historicalRuns.map((run) => run.id),
		};
	}

	function toDto(doc: DocumentRow, row: DocumentExecutionRow | null): DocumentExecutionDto {
		const plan = row ? parsePlan(row.plan_json) : [];
		const batches = deps.batches.listByDocId(doc.id);
		const tasks = deps.tasks.listByDocId(doc.id);
		const runs = deps.runs.listAll();
		const storedById = new Map(plan.map((entry) => [entry.batchId, entry]));
		const planned = buildPlanFromRows(batches, tasks, row?.version ?? 0, plan).map((entry) => {
			const stored = storedById.get(entry.batchId);
			return stored
				? {
						...entry,
						generationId: stored.generationId,
						wrapupRunIds: stored.wrapupRunIds,
						completion: stored.completion,
					}
				: entry;
		});
		const byId = new Map(batches.map((batch) => [batch.id, batch]));
		const done = planned.filter((entry) => {
			const batch = byId.get(entry.batchId);
			return (
				batch &&
				evidenceIsValid(
					entry,
					batch,
					tasks.filter((task) => task.batch_id === batch.id && task.is_removed_from_doc === 0),
					runs,
				)
			);
		});
		const current = row?.current_batch_id
			? planned.find((entry) => entry.batchId === row.current_batch_id)
			: null;
		const currentTasks = current
			? tasks.filter((task) => task.batch_id === current.batchId && task.is_removed_from_doc === 0)
			: [];
		const blockers: DocumentExecutionBlocker[] = [];
		if (doc.is_source_readable !== 1)
			blockers.push({ code: 'source_unreadable', batchId: current?.batchId ?? null, taskIds: [] });
		if (row?.state === 'paused' && row.pause_reason === 'doc_changed')
			blockers.push({ code: 'doc_changed', batchId: current?.batchId ?? null, taskIds: [] });
		if (currentTasks.some((task) => task.is_contract_ready !== 1))
			blockers.push({
				code: 'contract_pending',
				batchId: current?.batchId ?? null,
				taskIds: currentTasks.filter((task) => task.is_contract_ready !== 1).map((task) => task.id),
			});
		const hasMultipleActiveBatches =
			batches.filter((batch) => ACTIVE_BATCH_STATES.has(batch.state)).length > 1;
		if (hasMultipleActiveBatches)
			blockers.push({ code: 'legacy_batches_active', batchId: null, taskIds: [] });
		const assignment = row ? parseAssignment(row.default_assignment_json) : null;
		if (assignment) {
			const pendingTaskKeys = new Set(summarizeBatchLanding(currentTasks, runs).notLandedTaskKeys);
			const affected = currentTasks
				.filter((task) => pendingTaskKeys.has(task.task_key))
				.filter((task) => {
					const agentId =
						parseAssignmentDraft(task.assignment_draft_json)?.agentId ?? assignment.agentId;
					return !deps.isAgentAvailable(agentId);
				})
				.map((task) => task.id);
			if (affected.length)
				blockers.push({
					code: 'agent_unavailable',
					batchId: current?.batchId ?? null,
					taskIds: affected,
				});
		}
		const wrapupRows = current ? deps.wrapups.listByBatchId(current.batchId) : [];
		const currentWrapups = wrapupRows.filter((item) => current?.wrapupRunIds.includes(item.run_id));
		return Object.freeze({
			docId: doc.id,
			state: row?.state ?? 'idle',
			version: row?.version ?? 0,
			contentFingerprint: row?.content_fingerprint ?? null,
			defaultAssignment: assignment,
			currentBatchId: current?.batchId ?? null,
			currentBatchNo: current?.batchNo ?? null,
			completedBatchCount: done.length,
			totalBatchCount: planned.length,
			pauseReason: row?.pause_reason ?? null,
			blockers: Object.freeze(blockers),
			canStart:
				(row?.state ?? 'idle') === 'idle' &&
				doc.is_source_readable === 1 &&
				!hasMultipleActiveBatches,
			canPause: row?.state === 'running',
			canResume: row?.state === 'paused' && doc.is_source_readable === 1,
			updatedAt: row?.updated_at ?? null,
			wrapupProgress: current
				? {
						generationId: current.generationId,
						validRounds: new Set(currentWrapups.map((item) => item.round)).size,
						physicalAttempts: current.wrapupRunIds.length,
					}
				: null,
		});
	}

	function currentResponse(docId: string): DocumentExecutionResponse {
		const doc = requireDocument(docId);
		return { execution: toDto(doc, deps.executions.findByDocId(docId)) };
	}

	function assertVersion(
		expectedVersion: number,
		docId: string,
		row: DocumentExecutionRow | null,
	): void {
		const actualVersion = row?.version ?? 0;
		if (expectedVersion !== actualVersion)
			throw new AppError('E_VALIDATION', 'Document execution version changed.', {
				details: { expectedVersion, actualVersion, execution: currentResponse(docId).execution },
			});
	}

	function assertFingerprint(expected: string, doc: DocumentRow): void {
		if (doc.content_fingerprint !== expected)
			throw new AppError('E_SNAPSHOT_STALE', 'Document fingerprint changed.', {
				details: { expectedFingerprint: expected, actualFingerprint: doc.content_fingerprint },
			});
		if (doc.is_source_readable !== 1)
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Document source is unreadable.', {
				details: { docId: doc.id },
			});
	}

	async function validateAssignment(assignment: DocumentDefaultAssignment): Promise<void> {
		const agent = deps.registeredAgent(assignment.agentId);
		if (!agent)
			throw new AppError('E_VALIDATION', 'Agent is not registered.', {
				details: { agentId: assignment.agentId, field: 'defaultAssignment.agentId' },
			});
		if (assignment.effort !== null && agent.effortVendorMap === null)
			throw new AppError('E_VALIDATION', 'Agent does not support reasoning effort.', {
				details: { agentId: assignment.agentId },
			});
		if (assignment.effort && 'vendor' in assignment.effort) {
			const allowed = await deps.listVendorEffortDomain(assignment.agentId);
			assertVendorEffortInDomain(assignment.effort.vendor, allowed, 'defaultAssignment.effort');
		}
		const options = deps.modelEffortOptions(assignment.agentId, assignment.modelName);
		if (assignment.effort && options && options.length === 0)
			throw new AppError('E_VALIDATION', 'Selected model does not support reasoning effort.');
	}

	function publishChanged(
		docId: string,
		batchEvents: readonly TransitionBatchInTxResult[],
		actorDeviceId: string | null = null,
	): DocumentExecutionResponse {
		for (const item of batchEvents) deps.bus.publish(item.envelope);
		const result = currentResponse(docId);
		deps.bus.publish(
			deps.envelopeFactory.createEnvelope({
				kind: 'document.execution_changed',
				actorDeviceId,
				payload: { execution: result.execution },
			}),
		);
		return result;
	}

	function publishIfVersionChanged(
		docId: string,
		previousVersion: number,
		actorDeviceId: string | null = null,
	): void {
		const current = currentResponse(docId);
		if (current.execution.version !== previousVersion)
			deps.bus.publish(
				deps.envelopeFactory.createEnvelope({
					kind: 'document.execution_changed',
					actorDeviceId,
					payload: { execution: current.execution },
				}),
			);
	}

	async function activate(
		docId: string,
		expectedVersion: number,
		expectedFingerprint: string,
		assignment: DocumentDefaultAssignment | null,
		mode: 'start' | 'resume',
		actorDeviceId: string | null,
	): Promise<DocumentExecutionResponse> {
		const initial = requireDocument(docId);
		assertFingerprint(expectedFingerprint, initial);
		const previousVersion = deps.executions.findByDocId(docId)?.version ?? 0;
		const isIdempotentRetry = (row: DocumentExecutionRow | null): boolean =>
			mode === 'start'
				? row?.state === 'running' &&
					row.content_fingerprint === expectedFingerprint &&
					assignment !== null &&
					sameAssignment(parseAssignment(row.default_assignment_json), assignment)
				: row?.state === 'running' && row.version === expectedVersion + 1;
		try {
			if (isIdempotentRetry(deps.executions.findByDocId(docId))) {
				deps.validateSourceAtCommit(docId);
				return currentResponse(docId);
			}
			await deps.validateWorkspace(docId);
			const observed = deps.executions.findByDocId(docId);
			if (isIdempotentRetry(observed)) {
				deps.validateSourceAtCommit(docId);
				return currentResponse(docId);
			}
			if (mode === 'start' && observed?.state === 'running') {
				throw new AppError('E_VALIDATION', 'Active document execution has different settings.', {
					details: { execution: currentResponse(docId).execution },
				});
			}
			assertVersion(expectedVersion, docId, observed);
			if (mode === 'start' && (observed?.state ?? 'idle') !== 'idle')
				throw new AppError('E_VALIDATION', 'Document execution is not idle.');
			if (mode === 'resume' && observed?.state !== 'paused')
				throw new AppError('E_VALIDATION', 'Document execution is not paused.');
			if (assignment) await validateAssignment(assignment);
			if (mode === 'resume' && observed) {
				const savedAssignment = parseAssignment(observed.default_assignment_json);
				if (!savedAssignment)
					throw new AppError('E_INTERNAL', 'Stored document assignment is missing.');
				await validateAssignment(savedAssignment);
			}
			deps.validateSourceAtCommit(docId);
		} catch (error) {
			if (error instanceof AppError && error.code === 'E_DOC_SOURCE_UNREADABLE') {
				const row = deps.executions.findByDocId(docId);
				if (row?.state === 'paused' && row.pause_reason === 'source_unreadable')
					publishIfVersionChanged(docId, previousVersion, actorDeviceId);
			}
			throw error;
		}
		const batchEvents: TransitionBatchInTxResult[] = [];
		let changed = false;
		deps.unitOfWork.run(() => {
			const doc = requireDocument(docId);
			const row = deps.executions.findByDocId(docId);
			assertFingerprint(expectedFingerprint, doc);
			if (mode === 'start' && row?.state === 'running') {
				if (
					row.content_fingerprint === expectedFingerprint &&
					assignment &&
					sameAssignment(parseAssignment(row.default_assignment_json), assignment)
				)
					return;
				throw new AppError('E_VALIDATION', 'Active document execution has different settings.', {
					details: { execution: currentResponse(docId).execution },
				});
			}
			if (mode === 'resume' && row?.state === 'running' && row.version === expectedVersion + 1)
				return;
			assertVersion(expectedVersion, docId, row);
			if (mode === 'start' && (row?.state ?? 'idle') !== 'idle')
				throw new AppError('E_VALIDATION', 'Document execution is not idle.');
			if (mode === 'resume' && row?.state !== 'paused')
				throw new AppError('E_VALIDATION', 'Document execution is not paused.');
			const batches = deps.batches.listByDocId(docId);
			const tasks = deps.tasks.listByDocId(docId);
			const runs = deps.runs.listAll();
			const oldPlan = row ? parsePlan(row.plan_json) : [];
			let plan = buildPlanFromRows(batches, tasks, expectedVersion + 1, oldPlan).map((entry) => {
				const batch = batches.find((item) => item.id === entry.batchId);
				return batch && !oldPlan.some((item) => item.batchId === entry.batchId)
					? adoptLegacyEvidence(
							adoptLegacyGeneration(entry, batch, runs),
							batch,
							tasks.filter((task) => task.batch_id === batch.id && task.is_removed_from_doc === 0),
							runs,
						)
					: entry;
			});
			const active = batches.filter((batch) => ACTIVE_BATCH_STATES.has(batch.state));
			if (active.length > 1)
				throw new AppError('E_VALIDATION', 'Multiple legacy batches are active.', {
					details: { batchIds: active.map((batch) => batch.id) },
				});
			const oldById = new Map(oldPlan.map((item) => [item.batchId, item]));
			const plannedBatchIds = new Set(plan.map((entry) => entry.batchId));
			for (const old of oldPlan) {
				if (plannedBatchIds.has(old.batchId) || old.members.length === 0) continue;
				const batch = batches.find((item) => item.id === old.batchId);
				if (!batch || (!ACTIVE_BATCH_STATES.has(batch.state) && batch.state !== 'done')) continue;
				const currentMembers = tasks.filter(
					(task) => task.batch_id === batch.id && task.is_removed_from_doc === 0,
				);
				if (currentMembers.length !== 0) continue;
				batchEvents.push(
					deps.batchService.transitionBatchInTx(batch.id, 'idle', 'membership_invalidated', {
						sourceConfirmed: true,
						versionMatched: true,
						membersChanged: true,
						completionInvalid: true,
					}),
				);
			}
			plan = plan.map((entry) => {
				const batch = batches.find((item) => item.id === entry.batchId);
				if (!batch) return entry;
				const members = tasks.filter(
					(task) => task.batch_id === batch.id && task.is_removed_from_doc === 0,
				);
				const old = oldById.get(batch.id);
				const changedMembers = !!old && old.membershipFingerprint !== entry.membershipFingerprint;
				const valid = evidenceIsValid(entry, batch, members, runs);
				if (
					(batch.state === 'done' && !valid) ||
					(ACTIVE_BATCH_STATES.has(batch.state) && changedMembers)
				) {
					batchEvents.push(
						deps.batchService.transitionBatchInTx(batch.id, 'idle', 'membership_invalidated', {
							sourceConfirmed: true,
							versionMatched: true,
							membersChanged: changedMembers,
							completionInvalid: !valid,
						}),
					);
					return { ...entry, completion: null };
				}
				return entry;
			});
			const byId = new Map(deps.batches.listByDocId(docId).map((batch) => [batch.id, batch]));
			const earliest = plan.find((entry) => {
				const batch = byId.get(entry.batchId);
				return (
					batch &&
					!evidenceIsValid(
						entry,
						batch,
						tasks.filter((task) => task.batch_id === batch.id && task.is_removed_from_doc === 0),
						runs,
					)
				);
			});
			const stillActive = Array.from(byId.values()).filter((batch) =>
				ACTIVE_BATCH_STATES.has(batch.state),
			);
			if (stillActive.length === 1 && stillActive[0]?.id !== earliest?.batchId)
				throw new AppError(
					'E_VALIDATION',
					'Legacy active batch is not the earliest incomplete batch.',
					{ details: { batchIds: stillActive.map((batch) => batch.id) } },
				);
			if (
				earliest &&
				(byId.get(earliest.batchId)?.state === 'idle' ||
					byId.get(earliest.batchId)?.state === 'paused')
			)
				batchEvents.push(
					deps.batchService.transitionBatchInTx(earliest.batchId, 'running', 'document_execution'),
				);
			const now = deps.clock.now();
			deps.executions.save({
				doc_id: docId,
				state: earliest ? 'running' : 'completed',
				version: expectedVersion + 1,
				content_fingerprint: doc.content_fingerprint,
				plan_json: JSON.stringify(plan),
				default_assignment_json: JSON.stringify(
					assignment ?? parseAssignment(row?.default_assignment_json ?? null),
				),
				current_batch_id: earliest?.batchId ?? null,
				pause_reason: null,
				started_at: row?.started_at ?? now,
				updated_at: now,
				completed_at: earliest ? null : now,
			});
			changed = true;
		});
		if (!changed) return currentResponse(docId);
		const result = publishChanged(docId, batchEvents, actorDeviceId);
		if (result.execution.state === 'running') deps.nudgeTick?.();
		return result;
	}

	return Object.freeze({
		get: currentResponse,
		list: () =>
			deps.documents.listAll().map((doc) => toDto(doc, deps.executions.findByDocId(doc.id))),
		start: (docId: string, body: StartDocumentExecutionBody, actorDeviceId: string | null = null) =>
			activate(
				docId,
				body.expectedVersion,
				body.expectedFingerprint,
				body.defaultAssignment,
				'start',
				actorDeviceId,
			),
		resume: (
			docId: string,
			body: ResumeDocumentExecutionBody,
			actorDeviceId: string | null = null,
		) =>
			activate(
				docId,
				body.expectedVersion,
				body.expectedFingerprint,
				null,
				'resume',
				actorDeviceId,
			),
		pause(docId: string, body: PauseDocumentExecutionBody, actorDeviceId: string | null = null) {
			requireDocument(docId);
			let changed = false;
			deps.unitOfWork.run(() => {
				const row = deps.executions.findByDocId(docId);
				if (row?.state === 'paused' && row.version === body.expectedVersion + 1) return;
				assertVersion(body.expectedVersion, docId, row);
				if (row?.state !== 'running')
					throw new AppError('E_VALIDATION', 'Document execution is not running.');
				deps.executions.save({
					...row,
					state: 'paused',
					pause_reason: 'user_paused',
					version: row.version + 1,
					updated_at: deps.clock.now(),
				});
				changed = true;
			});
			return changed ? publishChanged(docId, [], actorDeviceId) : currentResponse(docId);
		},
		pauseRunningOnRestart() {
			let ids: readonly string[] = [];
			deps.unitOfWork.run(() => {
				ids = deps.executions.pauseRunningOnRestart(deps.clock.now());
			});
			for (const id of ids) publishChanged(id, []);
		},
		publishIfVersionChanged,
	});
}
