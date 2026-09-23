import type {
	BatchDto,
	BatchWrapupDto,
	BatchWrapupLandingDto,
} from '@agent-scheduler/shared/api/batches';
import {
	AGENT_MESSAGE_CHUNK_EVENT_KIND,
	type EventEnvelope,
} from '@agent-scheduler/shared/api/events';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { latestImplementationRunByTaskId, summarizeBatchLanding } from '../domain/batch-landing.ts';
import { freeLaneNumbers } from '../domain/lane-slots.ts';
import { type RunState, isTerminalRunState } from '../domain/run-state-machine.ts';
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
import type { SettingsRepo } from '../repo/settings.ts';
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
	readonly settingsRepo?: SettingsRepo;
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

/**
 * 收口运行的最终文本（E-274 解析输入）。
 * 逐段读 events 流，把 `agent_message_chunk.payload.chunk` 按顺序拼起来；一条内容事件都没有时回落到 raw 流。
 * 段文件按 fileSeq 递增直到读不到为止（200 MiB 轮转后最终文本可能在 fileSeq ≥ 1）。
 */
export async function readWrapupReportText(
	paths: LogstorePaths,
	fs: LogFileSystem,
	runId: string,
): Promise<string> {
	const readStream = async (stream: 'events' | 'raw'): Promise<string[]> => {
		const chunks: string[] = [];
		for (let fileSeq = 0; ; fileSeq += 1) {
			let bytes: Uint8Array;
			try {
				bytes = await fs.readFile(paths.segmentPath(runId, stream, fileSeq));
			} catch {
				break;
			}
			chunks.push(Buffer.from(bytes).toString('utf8'));
		}
		return chunks;
	};

	const eventSegments = await readStream('events');
	const messageParts: string[] = [];
	for (const segment of eventSegments) {
		for (const line of segment.split('\n')) {
			if (line.trim().length === 0) continue;
			let envelope: { kind?: unknown; payload?: { chunk?: unknown } } | null = null;
			try {
				envelope = JSON.parse(line) as { kind?: unknown; payload?: { chunk?: unknown } };
			} catch {
				continue;
			}
			if (
				envelope?.kind === AGENT_MESSAGE_CHUNK_EVENT_KIND &&
				typeof envelope.payload?.chunk === 'string'
			) {
				messageParts.push(envelope.payload.chunk);
			}
		}
	}
	if (messageParts.length > 0) {
		return messageParts.join('');
	}
	return (await readStream('raw')).join('');
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

			// Mode validation (AC 6, E-312):
			// triggerWrapup({trigger:'auto'}) in manual mode throws E_PIPELINE_STAGE_DISABLED{stage:'wrapup'}
			if (trigger === 'auto') {
				let wrapupMode: 'auto' | 'manual' = 'auto';
				if (deps.settingsRepo) {
					const row = deps.settingsRepo.get('pipeline');
					if (row) {
						try {
							const parsed = JSON.parse(row.value_json);
							if (parsed.wrapupMode === 'manual') {
								wrapupMode = 'manual';
							}
						} catch {
							// Corrupted row falls back to auto
						}
					}
				}
				if (wrapupMode === 'manual') {
					throw new AppError(
						'E_PIPELINE_STAGE_DISABLED',
						'Automated wrap-up is disabled because pipeline wrapupMode is manual (AC 6, E-312)',
						{
							details: { stage: 'wrapup' },
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

			// Check task landed & in_head statuses — 与 tick / getBatch 同一判定（domain/batch-landing.ts）
			const tasks = deps.tasksRepo.listByBatchId(batchId);
			const landing = summarizeBatchLanding(tasks, deps.runsRepo.listAll());
			const notLandedTaskKeys = [...landing.notLandedTaskKeys];
			const notInHeadTaskKeys = [...landing.notInHeadTaskKeys];

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

			if (!repoPath || !deps.workspace?.prepareWrapupWorktree) {
				if (batch.state !== 'needs_attention') {
					deps.batchService.transitionBatch(
						batchId,
						'needs_attention',
						'wrapup_workspace_unavailable',
					);
				}
				throw new AppError('E_WORKSPACE_UNAVAILABLE', 'Wrapup workspace is not available.', {
					details: { batchId, repoPath: repoPath || null },
				});
			}

			try {
				const prepared = await deps.workspace.prepareWrapupWorktree({
					repoPath,
					batchId: batch.batch_no,
					round: nextRound,
				});
				worktreePath = prepared.worktreePath;
				branchName = prepared.branchName;
				if (prepared.baseSha) baseSha = prepared.baseSha;
			} catch (cause) {
				if (batch.state !== 'needs_attention') {
					deps.batchService.transitionBatch(
						batchId,
						'needs_attention',
						'wrapup_workspace_unavailable',
					);
				}
				throw new AppError('E_WORKSPACE_UNAVAILABLE', 'Failed to prepare wrapup workspace.', {
					cause,
					details: { batchId, repoPath },
				});
			}

			let diffStat = '';
			if (!deps.workspace.getDiffStat) {
				if (batch.state !== 'needs_attention') {
					deps.batchService.transitionBatch(batchId, 'needs_attention', 'wrapup_diff_unavailable');
				}
				throw new AppError('E_WORKSPACE_UNAVAILABLE', 'Wrapup diff reader is not available.', {
					details: { batchId, worktreePath },
				});
			}
			try {
				diffStat = await deps.workspace.getDiffStat(worktreePath);
			} catch (cause) {
				if (batch.state !== 'needs_attention') {
					deps.batchService.transitionBatch(batchId, 'needs_attention', 'wrapup_diff_unavailable');
				}
				throw new AppError('E_WORKSPACE_UNAVAILABLE', 'Failed to read wrapup diff stat.', {
					cause,
					details: { batchId, worktreePath },
				});
			}

			// If round >= 2, retrieve previous wrapup report for section 3
			let previousReportText: string | null = null;
			if (nextRound >= 2) {
				const prevWrapupRecord = deps.batchWrapupsRepo.findLatestByBatchId(batchId);
				previousReportText = prevWrapupRecord?.report_text ?? null;
			}

			// 6. Assemble wrapup prompt (AC 3, E-285, E-296)
			const latestImplRunByTaskId = latestImplementationRunByTaskId(deps.runsRepo.listAll());
			const taskItems: WrapupTaskItem[] = tasks.map((t) => {
				const run = latestImplRunByTaskId.get(t.id);
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

				// Slot allocation for wrapup run (AC 6, E-283):
				// If free lane available, hold slot immediately; otherwise queued_reason='lane_full'
				const doc = deps.documentsRepo.findById(batch.doc_id);
				const docLaneCount = doc?.lane_count ?? 2;
				const docTasks = deps.tasksRepo.listByDocId(batch.doc_id);
				const docRuns = deps.runsRepo.listAll();
				const occupiedLanes = new Set<number>();
				for (const t of docTasks) {
					if (typeof t.lane_no === 'number' && t.lane_no >= 1) {
						occupiedLanes.add(t.lane_no);
					}
				}
				for (const r of docRuns) {
					if (
						r.kind === 'wrapup' &&
						typeof r.lane_no === 'number' &&
						r.lane_no >= 1 &&
						!isTerminalRunState(r.state as RunState)
					) {
						occupiedLanes.add(r.lane_no);
					}
				}
				const availableLanes = freeLaneNumbers(docLaneCount, occupiedLanes);
				const allocatedLaneNo = availableLanes.length > 0 ? (availableLanes[0] ?? null) : null;
				const queuedReason = allocatedLaneNo === null ? 'lane_full' : null;

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
						queued_reason: queuedReason,
						lane_no: allocatedLaneNo,
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
								trigger,
								promptSource: wrapupContext.promptSource,
								branchName,
							},
						}),
					);

					if (allocatedLaneNo !== null) {
						pendingEnvelopes.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'lane.assigned',
								actorDeviceId: actorDeviceId ?? null,
								payload: {
									docId: batch.doc_id,
									laneNo: allocatedLaneNo,
									taskId: null,
									runId,
								},
							}),
						);
					}
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

			// Read report text：先从 events 流拼 agent 的最终文本（所有受支持 agent 的 stdout 都是 JSON 行流，
			// 八段段头只出现在 agent_message_chunk 里）；没有内容事件时（纯文本 agent）才回落到 raw 流原文。
			let rawText = input.rawText ?? '';
			if (!rawText && deps.logstorePaths && deps.logFs) {
				rawText = await readWrapupReportText(deps.logstorePaths, deps.logFs, runId);
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
				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'batch.wrapup_finished',
							payload: {
								batchId,
								batchNo: batch.batch_no,
								runId,
								round: deps.batchWrapupsRepo.getMaxRound(batchId) + 1,
								wrapupId: null,
								verdict: 'unparsed',
								declaredVerdict: null,
								fixRunIds: [],
								unassignedCount: 0,
								batchState: 'needs_attention',
							},
						}),
					);
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
				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'batch.wrapup_finished',
							payload: {
								batchId,
								batchNo: batch.batch_no,
								runId,
								round: deps.batchWrapupsRepo.getMaxRound(batchId) + 1,
								wrapupId: null,
								verdict: 'unparsed',
								declaredVerdict: null,
								fixRunIds: [],
								unassignedCount: 0,
								batchState: 'needs_attention',
							},
						}),
					);
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

			let finalBatchState = batch.state;
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

				if (run.lane_no !== null && run.lane_no !== undefined && deps.envelopeFactory) {
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'lane.released',
							actorDeviceId: null,
							payload: {
								docId: batch.doc_id,
								laneNo: run.lane_no,
								taskId: null,
								runId: run.id,
								reason: 'landed',
							},
						}),
					);
				}

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
					finalBatchState = transRes.updatedBatch.state;
				} else {
					// Verdict is 'open'
					// If round 2 is still open, transition to needs_attention (E-276, E-288)
					if (nextValidRound >= 2) {
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'needs_attention',
							'wrapup_round_limit_reached',
						);
						pendingEnvelopes.push(transRes.envelope);
						finalBatchState = transRes.updatedBatch.state;

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
						finalBatchState = transRes.updatedBatch.state;
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
								round: nextValidRound,
								wrapupId: wrapupRecordId,
								verdict: effectiveVerdict,
								declaredVerdict: parsed.declaredVerdict,
								fixRunIds: [],
								unassignedCount: parsed.unassigned.length,
								batchState: finalBatchState,
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
			deps.nudgeTick?.();
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
