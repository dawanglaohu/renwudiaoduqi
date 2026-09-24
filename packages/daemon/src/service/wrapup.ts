import type { EffortTier } from '@agent-scheduler/shared/api/agents';
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
import type { RecallTaskResponse } from '@agent-scheduler/shared/api/tasks';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { resolveAssignment } from '../domain/assignment.ts';
import { latestImplementationRunByTaskId, summarizeBatchLanding } from '../domain/batch-landing.ts';
import { freeLaneNumbers } from '../domain/lane-slots.ts';
import {
	buildWrapupFixSerialReason,
	evaluatePathClashQueue,
	parseTaskPaths,
} from '../domain/path-clash.ts';
import { parsePipelineSettings } from '../domain/pipeline-settings.ts';
import {
	BUILTIN_REWORK_RULES,
	REWORK_COMMIT_PUSH_CONSTRAINT,
	extractReworkRules,
} from '../domain/rework-prompt.ts';
import {
	type RunState,
	TERMINAL_RUN_STATES,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { assertWrapupRoundAllowed } from '../domain/wrapup-policy.ts';
import { type WrapupTaskItem, assembleWrapupPrompt } from '../domain/wrapup-prompt.ts';
import { type WrapupFixItem, parseWrapupReport, planWrapupFixes } from '../domain/wrapup-report.ts';
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
import type { TaskRow, TasksRepo } from '../repo/tasks.ts';
import type { AgentService } from './agents.ts';
import { createAssignmentReader } from './assignment-reader.ts';
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
	/** E-318：流水线设置损坏/未知值时的告警出口；未注入时回落 console.warn。 */
	readonly warn?: (message: string, ...args: unknown[]) => void;
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

export interface RecallTaskInput {
	readonly taskId: string;
	readonly comment: string;
	readonly idempotencyKey: string;
	readonly actorDeviceId?: string | null;
}

export interface WrapupService {
	readonly triggerWrapup: (
		input: TriggerWrapupInput,
	) => Promise<{ readonly run: RunDto; readonly batch: BatchDto }>;
	readonly recordWrapupResult: (input: RecordWrapupResultInput) => Promise<void>;
	readonly listWrapups: (batchId: string) => Promise<readonly BatchWrapupDto[]>;
	readonly recallTask: (input: RecallTaskInput) => Promise<RecallTaskResponse>;
}

export function createWrapupService(deps: WrapupServiceDeps): WrapupService {
	const logWarn =
		deps.warn ??
		((message: string, ...args: unknown[]) => {
			console.warn(`[wrapup] ${message}`, ...args);
		});

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
		readonly effortVendor?: string | null;
		readonly source: string;
		readonly followedTaskId: string | null;
	} {
		const assignmentReader = createAssignmentReader({
			runsRepo: deps.runsRepo,
			dispatchSnapshotsRepo: deps.dispatchSnapshotsRepo,
		});

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
			const prevAssignment = assignmentReader.readTaskAssignment(latestWrapup.id);
			const agentId = prevAssignment?.agentId ?? latestWrapup.agent_id;
			assertAgentAvailable(agentId);
			return {
				agentId,
				modelName: prevAssignment?.modelName ?? latestWrapup.model_name ?? null,
				effortTier:
					prevAssignment?.effortTier ?? (latestWrapup.effort_tier as EffortTier | null) ?? null,
				effortVendor: prevAssignment?.effortVendor ?? latestWrapup.effort_vendor ?? null,
				source: 'wrapup_settings',
				followedTaskId: prevAssignment?.followedTaskId ?? null,
			};
		}

		// Follow candidate from batch
		const landedRuns = deps.runsRepo.findLandedImplementationRunsByBatchId?.(batchId) ?? [];
		const sourceRun = landedRuns.length > 0 ? landedRuns[0] : null;
		let followAssignment = null;
		if (sourceRun?.task_id) {
			const taskAssignment = assignmentReader.readTaskAssignment(sourceRun.id);
			if (taskAssignment) {
				followAssignment = {
					taskId: sourceRun.task_id,
					assignment: {
						agentId: taskAssignment.agentId,
						modelName: taskAssignment.modelName,
						effortTier: taskAssignment.effortTier,
						effortVendor: taskAssignment.effortVendor,
					},
				};
			}
		}

		const pipeline = deps.settingsRepo
			? parsePipelineSettings(deps.settingsRepo.get('pipeline')?.value_json)
			: undefined;

		const resolved = resolveAssignment({
			stage: 'wrapup',
			body: override,
			wrapupSettings: pipeline?.wrapupAssignment ?? { mode: 'follow' },
			followAssignment,
			agentDefaults: deps.agentRegistry
				? (id) => {
						const a = deps.agentRegistry?.getSnapshot().agents[id];
						return a
							? {
									agentId: id,
									defaultModel: a.defaultModel,
									defaultEffortTier: a.defaultEffortTier,
									effortVendorMap: a.effortVendorMap,
								}
							: null;
					}
				: undefined,
		});

		if ('failureReason' in resolved && resolved.failureReason === 'follow_source_missing') {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				'No landed implementation run found to follow assignment from.',
				{
					details: { reason: 'follow_source_missing', batchId },
				},
			);
		}

		const finalAgentId = resolved.agentId;
		assertAgentAvailable(finalAgentId);

		return {
			agentId: finalAgentId,
			modelName: resolved.modelName ?? null,
			effortTier: resolved.effortTier ?? null,
			effortVendor: resolved.effortVendor ?? null,
			source: resolved.source ?? 'wrapup_settings',
			followedTaskId: resolved.followedTaskId ?? null,
		};
	}

	function isAgentAvailable(agentId: string): boolean {
		if (deps.agentRegistry) {
			const snapshot = deps.agentRegistry.getSnapshot();
			if (!snapshot.agents[agentId]) {
				return false;
			}
		}
		if (deps.agentService) {
			const availability = deps.agentService.getAvailability(agentId);
			if (availability && !availability.canDispatch) {
				return false;
			}
		}
		return true;
	}

	function assertAgentAvailable(agentId: string): void {
		if (!isAgentAvailable(agentId)) {
			throw new AppError(
				'E_AGENT_UNAVAILABLE',
				`Agent '${agentId}' is not available for dispatch.`,
				{
					details: { reason: 'agent_unavailable', agentId },
				},
			);
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

			// Mode validation (AC 6, E-312, E-318):
			// triggerWrapup({trigger:'auto'}) in manual mode throws E_PIPELINE_STAGE_DISABLED{stage:'wrapup'}。
			// 读设置一律走严格 reader 并带 warn：损坏行也要告警、回落默认、不覆盖坏值。
			if (trigger === 'auto') {
				let wrapupMode: 'auto' | 'manual' = 'auto';
				if (deps.settingsRepo) {
					const row = deps.settingsRepo.get('pipeline');
					const settings = parsePipelineSettings(row?.value_json, logWarn);
					wrapupMode = settings.wrapupMode;
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

			// AC 3 & E-272 & R3: For auto trigger, if round >= 1, previous wrapup run branch must be merged into HEAD (is_in_head=1)
			// AND all fix runs from prior round (including cross-batch) must be landed
			if (trigger === 'auto' && validRoundCount >= 1) {
				if (latestWrapup && latestWrapup.is_in_head !== 1) {
					throw new AppError(
						'E_BATCH_NOT_WRAPPABLE',
						'Previous wrapup branch has not been merged into HEAD.',
						{
							details: {
								state: batch.state,
								reason: 'not_in_head',
								notLandedTaskKeys: [],
								notInHeadTaskKeys: [],
								activeWrapupRunId: null,
								wrapupRunId: latestWrapup.id,
							},
						},
					);
				}

				const latestWrapupRecord = deps.batchWrapupsRepo.findLatestByBatchId(batchId);
				if (latestWrapupRecord) {
					let prevFixRunIds: string[] = [];
					try {
						prevFixRunIds = JSON.parse(latestWrapupRecord.fix_run_ids_json);
					} catch {
						prevFixRunIds = [];
					}
					for (const fixId of prevFixRunIds) {
						const fixRun = deps.runsRepo.findById(fixId);
						if (!fixRun || fixRun.state !== 'landed') {
							throw new AppError(
								'E_BATCH_NOT_WRAPPABLE',
								`Fix run '${fixId}' from previous wrapup round is still in flight (state=${fixRun?.state ?? 'unknown'}).`,
								{
									details: {
										state: batch.state,
										reason: 'fix_runs_in_flight',
										notLandedTaskKeys: [],
										notInHeadTaskKeys: [],
										activeWrapupRunId: null,
										fixRunId: fixId,
									},
								},
							);
						}
					}
				}
			}

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
					assignmentJson,
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
									reason: 'awaiting_human',
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
									reason: 'awaiting_human',
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

			const fixRunIds: string[] = [];
			let finalUnassigned: string[] = [...parsed.unassigned];
			const fixRunsToInsert: Array<{
				runRow: Parameters<typeof deps.runsRepo.insert>[0];
				taskId: string;
			}> = [];
			let openShouldNeedAttention = false;

			if (effectiveVerdict === 'open') {
				if (nextValidRound >= 2) {
					// Round 2 open -> needs_attention (E-276)
					openShouldNeedAttention = true;
				} else {
					// Round 1 open -> plan wrapup fixes (AC 1, AC 3, E-275, E-280, E-290)
					const allDocTasks = deps.tasksRepo.listByDocId(batch.doc_id);
					const knownTaskKeys = new Set(allDocTasks.map((t) => t.task_key));
					const planned = planWrapupFixes(parsed, { knownTaskKeys });
					finalUnassigned = [...planned.unassigned];

					const fixCandidates: Array<{
						task: TaskRow;
						items: readonly WrapupFixItem[];
						agentId: string;
						modelName: string | null;
						effortTier: string | null;
						effortVendor: string | null;
						assignmentSource: string;
						assignmentSerialized: string;
						latestImplRun: RunRow | null;
					}> = [];

					for (const group of planned.groups) {
						const task = allDocTasks.find((t) => t.task_key === group.taskKey);
						if (!task) {
							for (const item of group.items) {
								finalUnassigned.push(item.raw);
							}
							continue;
						}

						const taskRuns = deps.runsRepo.listByTaskId(task.id);
						const implRuns = taskRuns.filter((r) => r.kind === 'implement');
						const latestImplRun =
							implRuns.length > 0
								? implRuns.reduce((max, r) => (r.attempt_no > max.attempt_no ? r : max))
								: null;

						const assignmentReader = createAssignmentReader({
							runsRepo: deps.runsRepo,
							dispatchSnapshotsRepo: deps.dispatchSnapshotsRepo,
						});
						const taskAssignment = latestImplRun
							? assignmentReader.readTaskAssignment(latestImplRun.id)
							: null;
						const resolved = resolveAssignment({
							stage: 'wrapup-fix',
							taskAssignment,
						});

						const agentId = resolved.agentId || latestImplRun?.agent_id;
						if (!agentId || !isAgentAvailable(agentId)) {
							// AC 1: agent 不可用则该组不派并计入 unassigned
							for (const item of group.items) {
								finalUnassigned.push(item.raw);
							}
							continue;
						}

						const modelName = resolved.modelName ?? null;
						const effortTier = resolved.effortTier ?? null;
						const effortVendor = resolved.effortVendor ?? null;
						const assignmentSource = resolved.source ?? 'task';
						const assignmentSerialized = assignmentReader.serializeTaskAssignment({
							agentId,
							modelName,
							effortTier,
							effortVendor,
							source: assignmentSource,
							followedTaskId: resolved.followedTaskId ?? null,
							capturedAt: now,
						});

						// E-300 / R5: 每任务同时只允许一条在途修复运行；后到的合并进落地清单提示而不再派
						const inFlightFix = taskRuns.find((r) => {
							const isFix = r.origin === 'wrapup-fix';
							const isInFlight =
								!(TERMINAL_RUN_STATES as readonly string[]).includes(r.state) &&
								r.state !== 'landed';
							return isFix && isInFlight;
						});

						if (inFlightFix) {
							const existingSnapshot = inFlightFix.snapshot_id
								? deps.dispatchSnapshotsRepo.findById(inFlightFix.snapshot_id)
								: null;
							const existingPrompt = existingSnapshot?.impl_prompt ?? task.impl_prompt ?? '';
							const additionalRItemsText = group.items
								.map((item) => {
									const itemText = item.raw.replace(/^[-\s*]+/, '').trim();
									return itemText.startsWith(item.id)
										? `- ${itemText}`
										: `- ${item.id}: ${itemText}`;
								})
								.join('\n');
							const mergedPrompt = `${existingPrompt}\n\n## 补充修复要求（重复判修）\n${additionalRItemsText}\n`;
							if (deps.dispatchSnapshotsRepo) {
								const mergedSnapshotId = `snap_${deps.ids.newId().slice(0, 16)}`;
								deps.dispatchSnapshotsRepo.insert({
									id: mergedSnapshotId,
									task_id: task.id,
									batch_id: null,
									input_text: existingSnapshot?.input_text ?? task.input_text,
									output_text: existingSnapshot?.output_text ?? task.output_text,
									accept_text: existingSnapshot?.accept_text ?? task.accept_text,
									impl_prompt: mergedPrompt,
									review_prompt: existingSnapshot?.review_prompt ?? task.review_prompt,
									bug_prompt: existingSnapshot?.bug_prompt ?? task.bug_prompt,
									contract_hash: task.contract_hash,
									task_paths_json: task.task_paths_json ?? '[]',
									launch_spec_json: existingSnapshot?.launch_spec_json ?? '{}',
									assignmentJson: assignmentReader.getRawAssignmentJson(existingSnapshot),
									created_at: now,
								});
								deps.runsRepo.updateSnapshotId?.(inFlightFix.id, mergedSnapshotId);
							}
							fixRunIds.push(inFlightFix.id);
							continue;
						}

						fixCandidates.push({
							task,
							items: group.items,
							agentId,
							modelName,
							effortTier,
							effortVendor,
							assignmentSource,
							assignmentSerialized,
							latestImplRun,
						});
					}

					if (fixCandidates.length === 0 && fixRunIds.length === 0) {
						// E-290: 全部开放项无主才 needs_attention（可派修复条目为零）
						openShouldNeedAttention = true;
					} else {
						let priorFixRunId: string | null = null;
						for (let idx = 0; idx < fixCandidates.length; idx++) {
							const candidate = fixCandidates[idx];
							if (!candidate) continue;
							const fixRunId = `run_${deps.ids.newId().slice(0, 16)}`;
							const taskRuns = deps.runsRepo.listByTaskId(candidate.task.id);
							const nextAttemptNo =
								(taskRuns.length > 0 ? Math.max(...taskRuns.map((r) => r.attempt_no)) : 0) + 1;

							const rItemsText = candidate.items
								.map((item) => {
									const itemText = item.raw.replace(/^[-\s*]+/, '').trim();
									return itemText.startsWith(item.id)
										? `- ${itemText}`
										: `- ${item.id}: ${itemText}`;
								})
								.join('\n');

							const prevSnapshot = candidate.latestImplRun?.snapshot_id
								? deps.dispatchSnapshotsRepo.findById(candidate.latestImplRun.snapshot_id)
								: null;
							const reworkRules =
								extractReworkRules(prevSnapshot?.impl_prompt ?? candidate.task.impl_prompt) ??
								BUILTIN_REWORK_RULES;
							const fixPrompt = `# 收口修复指令（任务 ${candidate.task.task_key}）\n\n## 修复要求\n${rItemsText}\n\n## 收到返工指令时\n${reworkRules}\n\n## 约束要求\n- ${REWORK_COMMIT_PUSH_CONSTRAINT}\n`;

							let fixSnapshotId = candidate.latestImplRun?.snapshot_id ?? '';
							if (deps.dispatchSnapshotsRepo) {
								fixSnapshotId = `snap_${deps.ids.newId().slice(0, 16)}`;
								const prevLaunchSpec = (() => {
									try {
										return JSON.parse(prevSnapshot?.launch_spec_json ?? '{}');
									} catch {
										return {};
									}
								})();
								const fixLaunchSpec = {
									...prevLaunchSpec,
									worktreeMode: 'reuse',
									targetWorktreePath: run.worktree_path,
									preferredBranchName: run.branch_name,
								};
								deps.dispatchSnapshotsRepo.insert({
									id: fixSnapshotId,
									task_id: candidate.task.id,
									batch_id: null, // dispatch_snapshots CHECK ((task_id IS NOT NULL) <> (batch_id IS NOT NULL))
									input_text: prevSnapshot?.input_text ?? candidate.task.input_text,
									output_text: prevSnapshot?.output_text ?? candidate.task.output_text,
									accept_text: prevSnapshot?.accept_text ?? candidate.task.accept_text,
									impl_prompt: fixPrompt,
									review_prompt: prevSnapshot?.review_prompt ?? candidate.task.review_prompt,
									bug_prompt: prevSnapshot?.bug_prompt ?? candidate.task.bug_prompt,
									contract_hash: candidate.task.contract_hash,
									task_paths_json: candidate.task.task_paths_json ?? '[]',
									launch_spec_json: JSON.stringify(fixLaunchSpec),
									assignmentJson: candidate.assignmentSerialized,
									created_at: now,
								});
							}

							let queuedReason: string | null = null;
							if (priorFixRunId !== null) {
								// Serialized behind prior fix run from same wrapup (AC 2, E-280)
								queuedReason = buildWrapupFixSerialReason(priorFixRunId);
							} else {
								// First candidate: check path clash against active tasks (E-46)
								const activeTasks = (deps.runsRepo.listActive?.() ?? []).map((r) => ({
									taskId: r.task_id ?? '',
									taskKey: undefined,
									taskPaths: parseTaskPaths(
										r.task_id ? deps.tasksRepo.findById(r.task_id)?.task_paths_json : null,
									),
									state: r.state,
									runId: r.id,
									batchId: r.batch_id,
								}));

								const firstCandidateTask = {
									taskId: candidate.task.id,
									taskKey: candidate.task.task_key,
									taskPaths: parseTaskPaths(candidate.task.task_paths_json),
									state: 'queued',
									batchId,
								};

								const clashResult = evaluatePathClashQueue({
									activeTasks,
									candidates: [firstCandidateTask],
									sameBatchOnly: false,
								});

								if (clashResult.blocked.length > 0) {
									queuedReason = clashResult.blocked[0]?.queuedReason ?? null;
								}
							}

							fixRunsToInsert.push({
								runRow: {
									id: fixRunId,
									task_id: candidate.task.id,
									batch_id: batchId, // 归触发批次 (AC 1, AC 4, E-275)
									attempt_no: nextAttemptNo,
									kind: 'implement',
									origin: 'wrapup-fix',
									spawned_by_run_id: runId, // 收口运行 (AC 1)
									state: 'queued',
									rework_count: 0, // rework_count = 0 (AC 1)
									permission_tier: 'workspaceWrite',
									worktree_path: run.worktree_path, // 复用收口 worktree (AC 1, E-280)
									branch_name: run.branch_name,
									agent_id: candidate.agentId,
									model_name: candidate.modelName,
									effort_tier: candidate.effortTier,
									effort_vendor: candidate.effortVendor ?? null,
									snapshot_id: fixSnapshotId,
									queued_reason: queuedReason,
									idempotency_key: `wrapup-fix-${runId}-${candidate.task.id}`,
									assignment_source: candidate.assignmentSource,
									actor_device_id: null,
									started_at: null,
									ended_at: null,
								},
								taskId: candidate.task.id,
							});

							fixRunIds.push(fixRunId);
							priorFixRunId = fixRunId;
						}
					}
				}
			}

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
					unassigned_json: JSON.stringify(finalUnassigned),
					fix_run_ids_json: JSON.stringify(fixRunIds),
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

				// Insert planned fix runs into runs table (AC 1)
				for (const fixItem of fixRunsToInsert) {
					assertSessionRefFree(
						{ taskId: fixItem.taskId, vendorSessionRef: null },
						{ runsRepo: deps.runsRepo, tasksRepo: deps.tasksRepo },
					);
					deps.runsRepo.insert(fixItem.runRow);
					if (deps.bus && deps.envelopeFactory) {
						pendingEnvelopes.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId: fixItem.runRow.id,
								taskId: fixItem.taskId,
								actorDeviceId: null,
								payload: {
									from: 'none',
									to: 'queued',
									reason: 'wrapup_fix_dispatched',
								},
							}),
						);
					}
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
					if (openShouldNeedAttention) {
						const reason =
							nextValidRound >= 2
								? 'wrapup_round_limit_reached'
								: 'wrapup_all_open_items_unassigned';
						const transRes = deps.batchService.transitionBatchInTx(
							batchId,
							'needs_attention',
							reason,
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
						// Round 1 open with dispatched fixes -> batch returns to running
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
								fixRunIds,
								unassignedCount: finalUnassigned.length,
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

		async recallTask(input: RecallTaskInput): Promise<RecallTaskResponse> {
			const { taskId, comment, idempotencyKey, actorDeviceId } = input;
			if (!comment || comment.trim().length === 0) {
				throw new AppError('E_VALIDATION', 'Comment is required');
			}
			if (!idempotencyKey || idempotencyKey.trim().length === 0) {
				throw new AppError('E_VALIDATION', 'Idempotency key is required');
			}

			const task = deps.tasksRepo.findById(taskId);
			if (!task) {
				throw new AppError('E_NOT_FOUND', `Task not found: ${taskId}`, {
					details: { taskId },
				});
			}

			// Idempotency check: duplicate idempotencyKey returns 409 E_RUN_ALREADY_EXISTS with existing run in details (AC 5, 10 节)
			const existingRun = deps.runsRepo.findByIdempotencyKey(idempotencyKey.trim());
			if (existingRun && existingRun.task_id === taskId) {
				throw new AppError(
					'E_RUN_ALREADY_EXISTS',
					`Run already exists for idempotency key: ${idempotencyKey}`,
					{
						details: { run: toRunDto(existingRun) },
					},
				);
			}

			const taskRuns = deps.runsRepo.listByTaskId(taskId);

			// E-293 / E-300 / R6: Check if task already has ANY in-flight run (normal implement, review, fix, or rework)
			const inFlightRun = taskRuns.find((r) => {
				return (
					!(TERMINAL_RUN_STATES as readonly string[]).includes(r.state) && r.state !== 'landed'
				);
			});

			if (inFlightRun) {
				throw new AppError(
					'E_FIX_RUN_IN_FLIGHT',
					`Task '${taskId}' already has a run in flight: ${inFlightRun.id} (${inFlightRun.state})`,
					{
						details: { taskId, runId: inFlightRun.id },
					},
				);
			}

			// E-293: Check if batch wrapup run is currently in flight
			if (task.batch_id) {
				const activeWrapup = deps.runsRepo.findActiveWrapupByBatchId?.(task.batch_id);
				if (activeWrapup) {
					throw new AppError(
						'E_FIX_RUN_IN_FLIGHT',
						`Wrapup run is already in flight for batch: ${task.batch_id}`,
						{
							details: { taskId, batchId: task.batch_id, wrapupRunId: activeWrapup.id },
						},
					);
				}
			}

			const implRuns = taskRuns.filter((r) => r.kind === 'implement');
			const latestImplRun =
				implRuns.length > 0
					? implRuns.reduce((max, r) => (r.attempt_no > max.attempt_no ? r : max))
					: null;
			const landingGate = deps.gatesRepo.findLatestByTaskIdAndKind(taskId, 'landing');
			const wasAutomaticallyLanded =
				latestImplRun !== null &&
				(task.manual_state === 'landed' || latestImplRun.state === 'landed') &&
				landingGate?.run_id === latestImplRun.id &&
				landingGate.state === 'decided' &&
				landingGate.decision === 'pass' &&
				(landingGate.comment === 'auto_landing_gate' ||
					landingGate.comment === 'auto_released_on_settings_change');
			if (!wasAutomaticallyLanded) {
				throw new AppError(
					'E_VALIDATION',
					`Task '${taskId}' cannot be recalled because it was not automatically landed.`,
					{
						details: {
							taskId,
							manualState: task.manual_state,
							latestRunState: latestImplRun?.state ?? null,
						},
					},
				);
			}

			const agentId = latestImplRun?.agent_id;
			if (!agentId || !isAgentAvailable(agentId)) {
				throw new AppError('E_AGENT_UNAVAILABLE', `Agent '${agentId}' is unavailable`, {
					details: { agentId },
				});
			}

			const now = deps.clock.now();
			const nextAttemptNo =
				(taskRuns.length > 0 ? Math.max(...taskRuns.map((r) => r.attempt_no)) : 0) + 1;
			const runId = `run_${deps.ids.newId().slice(0, 16)}`;

			const worktreePath = latestImplRun?.worktree_path ?? null;
			const branchName = latestImplRun?.branch_name ?? null;

			const prevSnapshot = latestImplRun?.snapshot_id
				? deps.dispatchSnapshotsRepo.findById(latestImplRun.snapshot_id)
				: null;
			const reworkRules =
				extractReworkRules(prevSnapshot?.impl_prompt ?? task.impl_prompt) ?? BUILTIN_REWORK_RULES;
			const recallPrompt = `# 任务撤回修复指令（任务 ${task.task_key}）\n\n## 撤回原因与修复要求\n${comment.trim()}\n\n## 收到返工指令时\n${reworkRules}\n\n## 约束要求\n- ${REWORK_COMMIT_PUSH_CONSTRAINT}\n`;

			let snapshotId = latestImplRun?.snapshot_id ?? '';
			if (deps.dispatchSnapshotsRepo) {
				snapshotId = `snap_${deps.ids.newId().slice(0, 16)}`;
				const prevLaunchSpec = (() => {
					try {
						return JSON.parse(prevSnapshot?.launch_spec_json ?? '{}');
					} catch {
						return {};
					}
				})();
				const recallLaunchSpec = {
					...prevLaunchSpec,
					worktreeMode: 'reuse',
					targetWorktreePath: worktreePath,
					preferredBranchName: branchName,
				};
				deps.dispatchSnapshotsRepo.insert({
					id: snapshotId,
					task_id: taskId,
					batch_id: null, // dispatch_snapshots CHECK ((task_id IS NOT NULL) <> (batch_id IS NOT NULL))
					input_text: prevSnapshot?.input_text ?? task.input_text,
					output_text: prevSnapshot?.output_text ?? task.output_text,
					accept_text: prevSnapshot?.accept_text ?? task.accept_text,
					impl_prompt: recallPrompt,
					review_prompt: prevSnapshot?.review_prompt ?? task.review_prompt,
					bug_prompt: prevSnapshot?.bug_prompt ?? task.bug_prompt,
					contract_hash: task.contract_hash,
					task_paths_json: task.task_paths_json ?? '[]',
					launch_spec_json: JSON.stringify(recallLaunchSpec),
					created_at: now,
				});
			}

			// Check path clash against active tasks
			const activeTasks = (deps.runsRepo.listActive?.() ?? []).map((r) => ({
				taskId: r.task_id ?? '',
				taskKey: undefined,
				taskPaths: parseTaskPaths(
					r.task_id ? deps.tasksRepo.findById(r.task_id)?.task_paths_json : null,
				),
				state: r.state,
				runId: r.id,
				batchId: r.batch_id,
			}));

			const candidateTask = {
				taskId: task.id,
				taskKey: task.task_key,
				taskPaths: parseTaskPaths(task.task_paths_json),
				state: 'queued',
				runId,
				batchId: task.batch_id,
			};

			const clashResult = evaluatePathClashQueue({
				activeTasks,
				candidates: [candidateTask],
				sameBatchOnly: false,
			});

			let queuedReason: string | null = null;
			if (clashResult.blocked.length > 0) {
				queuedReason = clashResult.blocked[0]?.queuedReason ?? null;
			}

			let createdRunRow: RunRow | null = null;
			const pendingEnvelopes: EventEnvelope[] = [];

			deps.unitOfWork.run(() => {
				assertSessionRefFree(
					{ taskId, vendorSessionRef: null },
					{ runsRepo: deps.runsRepo, tasksRepo: deps.tasksRepo },
				);
				deps.runsRepo.insert({
					id: runId,
					task_id: taskId,
					batch_id: task.batch_id,
					attempt_no: nextAttemptNo,
					kind: 'implement',
					origin: 'wrapup-fix',
					spawned_by_run_id: null, // AC 5: spawned_by_run_id 为空
					state: 'queued',
					rework_count: 0, // AC 5: 不计入 E-55 计数
					permission_tier: 'workspaceWrite',
					worktree_path: worktreePath,
					branch_name: branchName,
					agent_id: agentId,
					model_name: latestImplRun?.model_name ?? null,
					effort_tier: latestImplRun?.effort_tier ?? null,
					effort_vendor: latestImplRun?.effort_vendor ?? null,
					snapshot_id: snapshotId,
					assignment_source: 'task',
					queued_reason: queuedReason,
					idempotency_key: idempotencyKey.trim(),
					actor_device_id: actorDeviceId ?? null,
					started_at: null,
					ended_at: null,
				});

				createdRunRow = deps.runsRepo.findById(runId);

				if (deps.bus && deps.envelopeFactory) {
					pendingEnvelopes.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId,
							taskId,
							actorDeviceId: actorDeviceId ?? null,
							payload: {
								from: 'none',
								to: 'queued',
								reason: 'task_recalled',
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

			if (!createdRunRow) {
				throw new AppError('E_INTERNAL', 'Failed to retrieve created recalled run.');
			}

			return Object.freeze({ run: toRunDto(createdRunRow) });
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
