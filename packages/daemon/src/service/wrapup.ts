import type {
	BatchDto,
	BatchWrapupDto,
	BatchWrapupLandingDto,
} from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { assertWrapupRoundAllowed } from '../domain/wrapup-policy.ts';
import { type WrapupTaskItem, assembleWrapupPrompt } from '../domain/wrapup-prompt.ts';
import { parseWrapupReport } from '../domain/wrapup-report.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { LogFileSystem } from '../logstore/contract.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import { type BatchWrapupsRepo, toBatchWrapupDto } from '../repo/batch-wrapups.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { GatesRepo } from '../repo/gates.ts';
import { type RunRow, type RunsRepo, toRunDto } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';
import type { AgentService } from './agents.ts';
import type { BatchService } from './batch.ts';
import type { DocsService } from './docs.ts';
import { assertSessionRefFree } from './session-guard.ts';

export interface WrapupServiceDeps {
	readonly batchesRepo: BatchesRepo;
	readonly tasksRepo: TasksRepo;
	readonly runsRepo: RunsRepo;
	readonly dispatchSnapshotsRepo: DispatchSnapshotsRepo;
	readonly batchWrapupsRepo: BatchWrapupsRepo;
	readonly gatesRepo: GatesRepo;
	readonly documentsRepo: DocumentsRepo;
	readonly batchService: BatchService;
	readonly docsService: DocsService;
	readonly unitOfWork: UnitOfWork;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly agentRegistry?: AgentRegistry;
	readonly agentService?: AgentService;
	readonly workspace?: {
		readonly prepareWrapupWorktree?: (input: {
			readonly repoPath: string;
			readonly batchId: string | number;
			readonly round: number;
		}) => Promise<{
			readonly worktreePath: string;
			readonly branchName: string;
			readonly baseSha?: string;
		}>;
		readonly getDiffStat?: (worktreePath: string) => Promise<string>;
	};
	readonly logstorePaths?: LogstorePaths;
	readonly logFs?: LogFileSystem;
	readonly nudgeTick?: () => void;
}

export interface TriggerWrapupInput {
	readonly batchId: string;
	readonly trigger?: 'auto' | 'manual';
	readonly idempotencyKey?: string;
	readonly agentId?: string;
	readonly model?: string | null;
	readonly effortTier?: 'low' | 'medium' | 'high' | null;
	readonly actorDeviceId?: string | null;
}

export interface RecordWrapupResultInput {
	readonly runId: string;
	readonly rawText?: string;
	readonly exitCode?: number | null;
}

export interface WrapupService {
	readonly triggerWrapup: (
		input: TriggerWrapupInput,
	) => Promise<{ readonly run: RunDto; readonly batch: BatchDto }>;
	readonly recordWrapupResult: (input: RecordWrapupResultInput) => Promise<void>;
	readonly listWrapups: (batchId: string) => Promise<readonly BatchWrapupDto[]>;
}

export function createWrapupService(deps: WrapupServiceDeps): WrapupService {
	function resolveWrapupAssignment(
		batchId: string,
		round: number,
		latestWrapup: RunRow | null,
		override?: {
			readonly agentId?: string;
			readonly model?: string | null;
			readonly effortTier?: 'low' | 'medium' | 'high' | null;
		},
	): {
		readonly agentId: string;
		readonly modelName: string | null;
		readonly effortTier: 'low' | 'medium' | 'high' | null;
		readonly source: string;
		readonly followedTaskId: string | null;
	} {
		// Manual override has highest priority
		if (override?.agentId && override.agentId.trim().length > 0) {
			const agentId = override.agentId.trim();
			assertAgentAvailable(agentId);
			return {
				agentId,
				modelName: override.model ?? null,
				effortTier: override.effortTier ?? null,
				source: 'wrapup_settings',
				followedTaskId: null,
			};
		}

		// Round >= 2: follow previous round's wrapup assignment
		if (round >= 2 && latestWrapup) {
			assertAgentAvailable(latestWrapup.agent_id);
			return {
				agentId: latestWrapup.agent_id,
				modelName: latestWrapup.model_name ?? null,
				effortTier: (latestWrapup.effort_tier as 'low' | 'medium' | 'high') ?? null,
				source: 'wrapup_settings',
				followedTaskId: null,
			};
		}

		// Round 1 (follow mode): follow the latest ended_at landed implementation run in this batch
		const landedRuns = deps.runsRepo.findLandedImplementationRunsByBatchId?.(batchId) ?? [];
		if (landedRuns.length === 0) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				'No landed implementation run found to follow assignment from.',
				{
					details: { reason: 'follow_source_missing', batchId },
				},
			);
		}

		// SQL orders by ended_at DESC NULLS LAST, id DESC (tie-breaker: lexicographically largest run id)
		const sourceRun = landedRuns[0];
		if (!sourceRun) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				'No landed implementation run found to follow assignment from.',
				{
					details: { reason: 'follow_source_missing', batchId },
				},
			);
		}
		assertAgentAvailable(sourceRun.agent_id);

		return {
			agentId: sourceRun.agent_id,
			modelName: sourceRun.model_name ?? null,
			effortTier: (sourceRun.effort_tier as 'low' | 'medium' | 'high') ?? null,
			source: 'wrapup_settings',
			followedTaskId: sourceRun.task_id,
		};
	}

	function assertAgentAvailable(agentId: string): void {
		if (deps.agentRegistry) {
			const snapshot = deps.agentRegistry.getSnapshot();
			if (!snapshot.agents[agentId]) {
				throw new AppError('E_AGENT_UNAVAILABLE', `Agent '${agentId}' is not found in registry.`, {
					details: { reason: 'agent_unavailable', agentId },
				});
			}
		}
		if (deps.agentService) {
			const availability = deps.agentService.getAvailability(agentId);
			if (availability && !availability.canDispatch) {
				throw new AppError(
					'E_AGENT_UNAVAILABLE',
					`Agent '${agentId}' is not available for dispatch.`,
					{
						details: { reason: 'agent_unavailable', agentId },
					},
				);
			}
		}
	}

	return Object.freeze({
		async triggerWrapup(
			input: TriggerWrapupInput,
		): Promise<{ readonly run: RunDto; readonly batch: BatchDto }> {
			const { batchId, trigger = 'manual', idempotencyKey, actorDeviceId } = input;
			const batch = deps.batchesRepo.findById(batchId);
			if (!batch) {
				throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`);
			}

			// Idempotency check: duplicate idempotencyKey returns 409 E_RUN_ALREADY_EXISTS with details.run (AC 5, 10 节)
			if (idempotencyKey && idempotencyKey.trim().length > 0) {
				const existingRun = deps.runsRepo.findByIdempotencyKey(idempotencyKey.trim());
				if (existingRun && existingRun.batch_id === batchId) {
					throw new AppError(
						'E_RUN_ALREADY_EXISTS',
						`Run already exists for idempotency key: ${idempotencyKey}`,
						{
							details: { run: toRunDto(existingRun) },
						},
					);
				}
			}

			// 1. Batch wrappable checks (AC 5, E-272, E-283)
			if (batch.state === 'done') {
				throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Batch is already done.', {
					details: {
						state: batch.state,
						reason: 'done',
						notLandedTaskKeys: [],
						notInHeadTaskKeys: [],
						activeWrapupRunId: null,
					},
				});
			}

			if (batch.state === 'paused') {
				throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Batch is paused.', {
					details: {
						state: batch.state,
						reason: 'paused',
						notLandedTaskKeys: [],
						notInHeadTaskKeys: [],
						activeWrapupRunId: null,
					},
				});
			}

			if (batch.state === 'idle') {
				throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Batch is idle.', {
					details: {
						state: batch.state,
						reason: 'idle',
						notLandedTaskKeys: [],
						notInHeadTaskKeys: [],
						activeWrapupRunId: null,
					},
				});
			}

			// Check task landed & in_head statuses
			const tasks = deps.tasksRepo.listByBatchId(batchId);
			const allRuns = deps.runsRepo.listAll();
			const latestRunByTaskId = new Map<string, RunRow>();
			for (const r of allRuns) {
				if (!r.task_id) continue;
				const existing = latestRunByTaskId.get(r.task_id);
				if (!existing || r.attempt_no > existing.attempt_no) {
					latestRunByTaskId.set(r.task_id, r);
				}
			}

			const notLandedTaskKeys: string[] = [];
			const notInHeadTaskKeys: string[] = [];

			for (const t of tasks) {
				const r = latestRunByTaskId.get(t.id);
				if (!r || r.state !== 'landed') {
					notLandedTaskKeys.push(t.task_key);
				} else if (r.is_in_head === 0) {
					notInHeadTaskKeys.push(t.task_key);
				}
			}

			if (notLandedTaskKeys.length > 0) {
				throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Not all tasks in batch are landed.', {
					details: {
						state: batch.state,
						reason: 'not_all_landed',
						notLandedTaskKeys,
						notInHeadTaskKeys,
						activeWrapupRunId: null,
					},
				});
			}

			if (notInHeadTaskKeys.length > 0) {
				throw new AppError(
					'E_BATCH_NOT_WRAPPABLE',
					'Not all landed branches have been merged into HEAD.',
					{
						details: {
							state: batch.state,
							reason: 'not_in_head',
							notLandedTaskKeys: [],
							notInHeadTaskKeys,
							activeWrapupRunId: null,
						},
					},
				);
			}

			// Check active wrapup run
			const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(batchId);
			if (activeWrapup) {
				throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Wrapup run is already in flight.', {
					details: {
						state: batch.state,
						reason: 'wrapup_in_flight',
						notLandedTaskKeys: [],
						notInHeadTaskKeys: [],
						activeWrapupRunId: activeWrapup.id,
					},
				});
			}

			// 2. Round limit check (R4, AC 5, E-274, E-276, E-288)
			const validRoundCount = deps.batchWrapupsRepo.getMaxRound(batchId);
			const wrapupRuns = deps.runsRepo.listWrapupsByBatchId?.(batchId) ?? [];
			const physicalAttempts = wrapupRuns.length;
			const nextAttemptNo = physicalAttempts + 1;
			const nextRound = validRoundCount + 1;
			const latestWrapup = wrapupRuns.length > 0 ? wrapupRuns[wrapupRuns.length - 1] : null;

			assertWrapupRoundAllowed({
				validRound: validRoundCount,
				physicalAttempts,
				trigger,
			});

			// 3. Resolve assignment (AC 2, E-287, E-344)
			let assignment: ReturnType<typeof resolveWrapupAssignment>;
			try {
				assignment = resolveWrapupAssignment(batchId, nextAttemptNo, latestWrapup ?? null, {
					agentId: input.agentId,
					model: input.model,
					effortTier: input.effortTier,
				});
			} catch (err: unknown) {
				// If agent unavailable or follow source missing, transition batch to needs_attention (E-287, E-344)
				if (err instanceof AppError && err.code === 'E_AGENT_UNAVAILABLE') {
					if (batch.state !== 'needs_attention') {
						await deps.batchService.transitionBatch(
							batchId,
							'needs_attention',
							'agent_unavailable',
						);
					}
				}
				throw err;
			}

			// 4. Get wrapup context from docs (M3-T6, E-296)
			const wrapupContext = deps.docsService.getWrapupContext(batchId);

			// 5. Prepare worktree & diff stat (E-285)
			const doc = deps.documentsRepo.findById(batch.doc_id);
			const repoPath = doc?.repo_path ?? '';
			let worktreePath = '';
			let branchName = `wrapup/batch-${batch.batch_no}-r${nextRound}`;
			let baseSha = 'HEAD';

			if (deps.workspace?.prepareWrapupWorktree && repoPath) {
				try {
					const prepared = await deps.workspace.prepareWrapupWorktree({
						repoPath,
						batchId: batch.batch_no,
						round: nextRound,
					});
					worktreePath = prepared.worktreePath;
					branchName = prepared.branchName;
					if (prepared.baseSha) baseSha = prepared.baseSha;
				} catch {
					worktreePath = repoPath;
				}
			} else {
				worktreePath = repoPath;
			}

			let diffStat = '';
			if (deps.workspace?.getDiffStat && worktreePath) {
				try {
					diffStat = await deps.workspace.getDiffStat(worktreePath);
				} catch {
					diffStat = '';
				}
			}

			// If round >= 2, retrieve previous wrapup report for section 3
			let previousReportText: string | null = null;
			if (nextRound >= 2) {
				const prevWrapupRecord = deps.batchWrapupsRepo.findLatestByBatchId(batchId);
				previousReportText = prevWrapupRecord?.report_text ?? null;
			}

			// 6. Assemble wrapup prompt (AC 3, E-285, E-296)
			const taskItems: WrapupTaskItem[] = tasks.map((t) => {
				const run = latestRunByTaskId.get(t.id);
				return {
					taskId: t.id,
					taskKey: t.task_key,
					title: t.title,
					branchName: run?.branch_name ?? null,
					worktreePath: run?.worktree_path ?? null,
				};
			});

			const fullPrompt = assembleWrapupPrompt({
				worktreePath,
				branchName,
				baseSha,
				wrapupMaterial: wrapupContext.wrapup,
				promptSource: wrapupContext.promptSource,
				tasks: taskItems,
				testCommands: null,
				diffStat,
				round: nextRound,
				previousReportText,
			});

			// Deep copy launch spec from registry
			let launchSpecJson = '{}';
			if (deps.agentRegistry) {
				const snapshot = deps.agentRegistry.getSnapshot();
				const entry = snapshot.agents[assignment.agentId];
				if (entry) {
					launchSpecJson = JSON.stringify(entry);
				}
			}

			const snapshotId = `snap_${deps.ids.newId().slice(0, 16)}`;
			const runId = `run_${deps.ids.newId().slice(0, 16)}`;
			const generatedIdempotencyKey = idempotencyKey ?? `wrapup-${batchId}-r${nextRound}-${runId}`;
			const now = deps.clock.now();

			const assignmentJson = JSON.stringify({
				agentId: assignment.agentId,
				modelName: assignment.modelName,
				effortTier: assignment.effortTier,
				source: assignment.source,
				followedTaskId: assignment.followedTaskId,
				capturedAt: now,
			});

			let createdRunRow: RunRow | null = null;
			const pendingEnvelopes: EventEnvelope[] = [];

			// 7. Transaction: insert snapshot, insert wrapup run (queued), transitionBatch(->wrapping) (08 节, AC 1, AC 2, AC 7)
			deps.unitOfWork.run(() => {
				// Re-verify no active wrapup in tx
				const activeCheck = deps.runsRepo.findActiveWrapupByBatchId?.(batchId);
				if (activeCheck) {
					throw new AppError('E_BATCH_NOT_WRAPPABLE', 'Wrapup run is already in flight.', {
						details: {
							state: batch.state,
							reason: 'wrapup_in_flight',
							notLandedTaskKeys: [],
							notInHeadTaskKeys: [],
							activeWrapupRunId: activeCheck.id,
						},
					});
				}

				// insert snapshot
				deps.dispatchSnapshotsRepo.insert({
					id: snapshotId,
					task_id: null,
					batch_id: batchId,
					input_text: null,
					output_text: null,
					accept_text: null,
					impl_prompt: fullPrompt,
					review_prompt: null,
					contract_hash: 'wrapup',
					task_paths_json: '[]',
					launch_spec_json: launchSpecJson,
					assignment_json: assignmentJson,
					created_at: now,
				});

				// insert wrapup run (AC 2: kind='wrapup', task_id=null, permission_tier='workspaceWrite', queued)
				assertSessionRefFree(
					{ taskId: runId, vendorSessionRef: null },
					{ runsRepo: deps.runsRepo, tasksRepo: deps.tasksRepo },
				);
				try {
					deps.runsRepo.insert({
						id: runId,
						task_id: null,
						batch_id: batchId,
						attempt_no: nextAttemptNo,
						kind: 'wrapup',
						state: 'queued',
						agent_id: assignment.agentId,
						model_name: assignment.modelName,
						effort_tier: assignment.effortTier,
						permission_tier: 'workspaceWrite',
						snapshot_id: snapshotId,
						worktree_path: worktreePath,
						branch_name: branchName,
						idempotency_key: generatedIdempotencyKey,
						actor_device_id: actorDeviceId ?? null,
						started_at: null,
						last_event_at: now,
						origin: 'dispatch',
						prompt_source: wrapupContext.promptSource,
						assignment_source: assignment.source,
					});
				} catch (cause) {
					if (idempotencyKey) {
						const existing = deps.runsRepo.findByIdempotencyKey(idempotencyKey.trim());
						if (existing && existing.batch_id === batchId) {
							throw new AppError(
								'E_RUN_ALREADY_EXISTS',
								`Run already exists for idempotency key: ${idempotencyKey}`,
								{
									details: { run: toRunDto(existing) },
									cause,
								},
							);
						}
					}
					throw cause;
				}

				createdRunRow = deps.runsRepo.findById(runId);

				// Transition batch to wrapping via batchService (R1)
				const currentBatch = deps.batchesRepo.findById(batchId);
				if (currentBatch && currentBatch.state !== 'wrapping') {
					const transRes = deps.batchService.transitionBatchInTx(
						batchId,
						'wrapping',
						'wrapup_dispatched',
					);
					pendingEnvelopes.push(transRes.envelope);
				}

				if (deps.bus && deps.envelopeFactory) {
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'batch.wrapup_started',
							payload: {
								batchId,
								batchNo: currentBatch?.batch_no ?? batch.batch_no,
								runId,
								round: nextRound,
								agentId: assignment.agentId,
								trigger,
							},
						}),
					);
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId,
							taskId: null,
							actorDeviceId: actorDeviceId ?? null,
							payload: {
								from: 'none',
								to: 'queued',
								reason: 'wrapup_dispatched',
							},
						}),
					);
				}

				// If leaving needs_attention, mark any waiting gates superseded (E-288)
				if (currentBatch?.state === 'needs_attention') {
					const prevWrapups = deps.runsRepo.listWrapupsByBatchId?.(batchId) ?? [];
					const prevRunIds = prevWrapups.map((r) => r.id);
					deps.gatesRepo.supersedePendingByRunIds?.(prevRunIds, now);
				}
			});

			// Publish events outside transaction (08 节)
			if (deps.bus && pendingEnvelopes.length > 0) {
				for (const env of pendingEnvelopes) {
					deps.bus.publish(env);
				}
			}

			// Nudge tick
			deps.nudgeTick?.();

			const updatedBatch = await deps.batchService.getBatch(batchId);
			if (!createdRunRow) {
				throw new AppError('E_INTERNAL', 'Failed to retrieve created wrapup run.');
			}

			return {
				run: toRunDto(createdRunRow),
				batch: updatedBatch,
			};
		},

		async recordWrapupResult(input: RecordWrapupResultInput): Promise<void> {
			const { runId, exitCode = 0 } = input;
			const run = deps.runsRepo.findById(runId);
			if (!run || run.kind !== 'wrapup' || !run.batch_id) {
				throw new AppError('E_NOT_FOUND', `Wrapup run not found: ${runId}`);
			}

			const batchId = run.batch_id;
			const batch = deps.batchesRepo.findById(batchId);
			if (!batch) {
				throw new AppError('E_NOT_FOUND', `Batch not found: ${batchId}`);
			}

			// Read report text
			let rawText = input.rawText ?? '';
			if (!rawText && deps.logstorePaths && deps.logFs) {
				try {
					const rawLogPath = deps.logstorePaths.segmentPath(runId, 'raw', 0);
					const bytes = await deps.logFs.readFile(rawLogPath);
					rawText = Buffer.from(bytes).toString('utf8');
				} catch {
					rawText = '';
				}
			}

			const now = deps.clock.now();
			const isExitedClean =
				exitCode === 0 &&
				run.state !== 'failed' &&
				run.state !== 'aborted' &&
				run.state !== 'interrupted';

			// Case 1: Run failed / aborted / interrupted / non-zero exit (E-274, E-295)
			if (!isExitedClean) {
				const pendingEnvelopes: EventEnvelope[] = [];
				deps.unitOfWork.run(() => {
					// Wrapup run transitions to awaiting_human (E-295)
					deps.runsRepo.updateState({
						id: runId,
						toState: 'awaiting_human',
						endedAt: now,
					});

					// Create batch-level review gate with task_id = NULL (E-274, E-288, E-295)
					const gateId = `gate_${deps.ids.newId().slice(0, 16)}`;
					deps.gatesRepo.create({
						id: gateId,
						task_id: null,
						run_id: runId,
						kind: 'review',
						state: 'waiting',
						created_at: now,
					});

					// Batch transitions to needs_attention via batchService (R1)
					if (batch.state !== 'needs_attention') {
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'needs_attention',
							'wrapup_run_failed',
						);
						pendingEnvelopes.push(transRes.envelope);
					}

					if (deps.bus && deps.envelopeFactory) {
						pendingEnvelopes.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId,
								taskId: null,
								payload: {
									from: run.state,
									to: 'awaiting_human',
									reason: 'wrapup_run_failed',
								},
							}),
						);
					}
				});

				if (deps.bus && pendingEnvelopes.length > 0) {
					for (const env of pendingEnvelopes) {
						deps.bus.publish(env);
					}
				}
				return;
			}

			// Case 2: Parse 8-section report (AC 4, E-274)
			const parsed = parseWrapupReport(rawText);
			if (!parsed.ok) {
				// Parse failed: output does not conform to 8-section format (E-274)
				const pendingEnvelopes: EventEnvelope[] = [];
				deps.unitOfWork.run(() => {
					deps.runsRepo.updateState({
						id: runId,
						toState: 'awaiting_human',
						endedAt: now,
					});

					const gateId = `gate_${deps.ids.newId().slice(0, 16)}`;
					deps.gatesRepo.create({
						id: gateId,
						task_id: null,
						run_id: runId,
						kind: 'review',
						state: 'waiting',
						created_at: now,
					});

					if (batch.state !== 'needs_attention') {
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'needs_attention',
							'wrapup_report_unparsable',
						);
						pendingEnvelopes.push(transRes.envelope);
					}

					if (deps.bus && deps.envelopeFactory) {
						pendingEnvelopes.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId,
								taskId: null,
								payload: {
									from: run.state,
									to: 'awaiting_human',
									reason: 'wrapup_report_unparsable',
								},
							}),
						);
					}
				});

				if (deps.bus && pendingEnvelopes.length > 0) {
					for (const env of pendingEnvelopes) {
						deps.bus.publish(env);
					}
				}
				return;
			}

			// Case 3: Parse succeeded! Insert batch_wrapups, transition run to landed, transition batch (AC 4, E-294)
			const effectiveVerdict = parsed.verdict;
			const nextValidRound = deps.batchWrapupsRepo.getMaxRound(batchId) + 1;
			const wrapupRecordId = `wrapup_${deps.ids.newId().slice(0, 16)}`;
			const tasks = deps.tasksRepo.listByBatchId(batchId);
			const taskKeys = tasks.map((t) => t.task_key);
			const allFindings = [...parsed.bugs, ...parsed.notFixed];

			const pendingEnvelopes: EventEnvelope[] = [];

			deps.unitOfWork.run(() => {
				// insert batch_wrapups
				deps.batchWrapupsRepo.insert({
					id: wrapupRecordId,
					batch_id: batchId,
					batch_no: batch.batch_no,
					tasks_json: JSON.stringify(taskKeys),
					round: nextValidRound,
					run_id: runId,
					verdict: effectiveVerdict,
					declared_verdict: parsed.declaredVerdict ?? null,
					is_human_verdict: 0,
					prompt_source: (run.prompt_source as 'docs' | 'builtin') ?? 'docs',
					tests_json: JSON.stringify(parsed.tests),
					summary_text: parsed.summaryText,
					findings_json: JSON.stringify(allFindings),
					unassigned_json: JSON.stringify(parsed.unassigned),
					fix_run_ids_json: '[]',
					report_text: rawText,
					created_at: now,
				});

				// Transition wrapup run to landed (09 节 运行状态机: reviewing -> landed 收口运行八段解析成功)
				deps.runsRepo.updateState({
					id: runId,
					toState: 'landed',
					endedAt: now,
				});

				if (deps.bus && deps.envelopeFactory) {
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId,
							taskId: null,
							payload: {
								from: run.state,
								to: 'landed',
								reason: 'wrapup_report_parsed',
							},
						}),
					);
				}

				// Evaluate verdict via batchService (R1): clean | fixed -> done (AC 4, E-286, E-294)
				if (effectiveVerdict === 'clean' || effectiveVerdict === 'fixed') {
					const transRes = deps.batchService.transitionBatchInTx(
						batchId,
						'done',
						`wrapup_${effectiveVerdict}`,
					);
					pendingEnvelopes.push(transRes.envelope);
				} else {
					// Verdict is 'open'
					// If round 2 is still open, transition to needs_attention (E-276, E-288)
					if (run.attempt_no >= 2) {
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'needs_attention',
							'wrapup_round_limit_reached',
						);
						pendingEnvelopes.push(transRes.envelope);

						const gateId = `gate_${deps.ids.newId().slice(0, 16)}`;
						deps.gatesRepo.create({
							id: gateId,
							task_id: null,
							run_id: runId,
							kind: 'review',
							state: 'waiting',
							created_at: now,
						});
					} else {
						// Round 1 open: in M8-T6, delegate to M8-T7, batch returns to running when fixes dispatched
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'running',
							'wrapup_fixes_pending',
						);
						pendingEnvelopes.push(transRes.envelope);
					}
				}

				if (deps.bus && deps.envelopeFactory) {
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'batch.wrapup_finished',
							payload: {
								batchId,
								batchNo: batch.batch_no,
								runId,
								round: run.attempt_no,
								verdict: effectiveVerdict,
								isHumanVerdict: false,
							},
						}),
					);
				}
			});

			if (deps.bus && pendingEnvelopes.length > 0) {
				for (const env of pendingEnvelopes) {
					deps.bus.publish(env);
				}
			}
		},

		async listWrapups(batchId: string): Promise<readonly BatchWrapupDto[]> {
			const rows = deps.batchWrapupsRepo.listByBatchId(batchId);
			const result: BatchWrapupDto[] = [];

			for (const r of rows) {
				const run = deps.runsRepo.findById(r.run_id);
				let landing: BatchWrapupLandingDto | null = null;
				if (run) {
					landing = {
						worktreePath: run.worktree_path,
						branchName: run.branch_name,
						diffStat: null,
					};
				}
				result.push(toBatchWrapupDto(r, landing));
			}

			return Object.freeze(result);
		},
	});
}
