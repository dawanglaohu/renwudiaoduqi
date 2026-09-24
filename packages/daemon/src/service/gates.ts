import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginState } from '@agent-scheduler/shared/api/agents';
import type { BatchGateOverrides } from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type {
	DecideGateResponse,
	GateContext,
	GateContextStderrTail,
	GateDto,
	ListGatesResponse,
} from '@agent-scheduler/shared/api/gates';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import {
	type GateKind,
	type GateOverrides,
	type ResolveAfterReviewResult,
	resolveAfterReview,
} from '../domain/gates.ts';
import { freeLaneNumbers } from '../domain/lane-slots.ts';
import { type RunState, isTerminalRunState } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchWrapupsRepo } from '../repo/batch-wrapups.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { GateRow, GatesRepo } from '../repo/gates.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';
import type { AgentService } from './agents.ts';
import type { BatchService } from './batch.ts';
import type { ReworkService } from './rework.ts';
import type { ArchiveTaskContext, SessionArchiveService } from './session-archive.ts';
import type { SettingsService } from './settings.ts';

export interface GateServiceDeps {
	readonly gatesRepo: GatesRepo;
	readonly tasksRepo?: TasksRepo;
	readonly runsRepo?: RunsRepo;
	readonly batchesRepo?: BatchesRepo;
	readonly batchWrapupsRepo?: BatchWrapupsRepo;
	readonly batchService?: BatchService;
	readonly documentsRepo?: DocumentsRepo;
	readonly reworkService?: ReworkService;
	readonly nudgeTick?: () => void;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly unitOfWork: UnitOfWork;
	readonly settingsService: SettingsService;
	readonly getBatchGateOverrides?: (batchId: string) => BatchGateOverrides | undefined;
	readonly sessionArchiveService?: SessionArchiveService;
	readonly agentService?: AgentService;
	readonly getRunExitedTail?: (runId: string) => { readonly stderrTail?: readonly string[] } | null;
	readonly dataDir?: string;
}

export interface GateService {
	readonly decideGate: (input: {
		readonly gateId: string;
		readonly decision: 'pass' | 'reject';
		readonly comment?: string;
		readonly actorDeviceId: string | null;
	}) => Promise<DecideGateResponse>;
	readonly listGates: (params?: {
		readonly pendingOnly?: boolean;
		readonly agentService?: AgentService;
	}) => Promise<ListGatesResponse>;
	readonly createWaitingGate: (input: {
		readonly taskId: string;
		readonly runId?: string | null;
		readonly kind: 'dispatch' | 'review' | 'landing';
		readonly comment?: string;
	}) => Promise<GateDto>;
	readonly resolveAfterReviewAndApply: (input: {
		readonly taskId: string;
		readonly runId?: string | null;
		readonly reviewVerdict: string;
		readonly overrides?: GateOverrides | null;
	}) => Promise<ResolveAfterReviewResult>;
	/**
	 * Releases waiting gates for kinds that just switched to 'auto' (R2, E-56).
	 *
	 * Runs inside the caller's `unitOfWork.run` — it opens no transaction of its own and
	 * publishes nothing (08 节：一个 HTTP 请求最多开一次事务，跨 service 的复合写必须聚进
	 * 同一个 run；事件一律在事务返回后由调用方 publish)。Returns the events to publish.
	 */
	readonly reEvaluateWaitingGatesInTx: (
		newGates: GateSettings,
		previousGates: GateSettings | undefined,
		actorDeviceId: string | null,
	) => readonly EventEnvelope[];
	readonly setBatchGateOverrides: (batchId: string, overrides: BatchGateOverrides) => void;
	readonly getBatchGateOverrides: (batchId: string) => BatchGateOverrides | undefined;
}

function rowToGateDto(row: GateRow, context?: GateContext | null): GateDto {
	return Object.freeze({
		id: row.id,
		taskId: row.task_id,
		runId: row.run_id,
		kind: row.kind as 'dispatch' | 'review' | 'landing',
		state: row.state as 'waiting' | 'decided',
		decision: row.decision as 'pass' | 'rework' | 'reject' | null,
		comment: row.comment,
		decidedByDeviceId: row.decided_by_device_id,
		createdAt: row.created_at,
		decidedAt: row.decided_at,
		context: context ?? null,
	});
}

export function createGateService(deps: GateServiceDeps): GateService {
	const batchGateOverridesMap = new Map<string, BatchGateOverrides>();

	function resolveGateContext(
		row: GateRow,
		overrideAgentService?: AgentService,
	): GateContext | null {
		if (row.comment !== 'exited_before_output') {
			return null;
		}
		const runId = row.run_id;
		if (!runId || !deps.runsRepo) {
			return null;
		}
		const run = deps.runsRepo.findById(runId);
		const exitCode = run ? (run.exit_code ?? null) : null;
		const exitSignal = run ? (run.exit_signal ?? null) : null;

		let stderrTail: GateContextStderrTail = {
			kind: 'unavailable',
			reason: 'event_missing',
			lines: [],
		};

		const memTail = deps.getRunExitedTail?.(runId);
		if (memTail?.stderrTail !== undefined) {
			stderrTail = {
				kind: 'lines',
				lines: memTail.stderrTail,
			};
		} else {
			const candidates = [
				deps.dataDir ? join(deps.dataDir, runId, 'events.ndjson') : null,
				deps.dataDir ? join(deps.dataDir, 'runs', runId, 'events.ndjson') : null,
			].filter((c): c is string => Boolean(c));

			let foundFile = false;
			for (const path of candidates) {
				if (existsSync(path)) {
					foundFile = true;
					try {
						const content = readFileSync(path, 'utf8');
						const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
						for (let i = lines.length - 1; i >= 0; i--) {
							const line = lines[i];
							if (line?.includes('"run.exited"')) {
								try {
									const parsed = JSON.parse(line);
									if (parsed.kind === 'run.exited') {
										const tail = parsed.payload?.stderrTail;
										if (Array.isArray(tail)) {
											stderrTail = { kind: 'lines', lines: tail };
										} else {
											stderrTail = { kind: 'unavailable', reason: 'legacy_run', lines: [] };
										}
										break;
									}
								} catch {}
							}
						}
					} catch {}
					break;
				}
			}
			if (!foundFile && stderrTail.kind === 'unavailable') {
				stderrTail = { kind: 'unavailable', reason: 'event_missing', lines: [] };
			}
		}

		let login: LoginState | null = null;
		const agentId = run?.agent_id;
		const agentSvc = overrideAgentService ?? deps.agentService;
		if (agentId && agentSvc) {
			try {
				if (typeof agentSvc.getLogin === 'function') {
					login = agentSvc.getLogin(agentId);
				} else if (typeof agentSvc.getAgent === 'function') {
					const agent = agentSvc.getAgent(agentId) as { login?: LoginState } | null;
					login = agent?.login ?? null;
				}
			} catch {
				login = null;
			}
		}

		return Object.freeze({
			exitCode,
			exitSignal,
			stderrTail,
			login,
		});
	}

	return Object.freeze({
		/**
		 * Decides a waiting gate (AC 1, AC 2b, AC 5, AC 6, E-05, E-53, E-57):
		 * - If gate not found: returns 404 E_NOT_FOUND.
		 * - If gate is already decided: idempotent 409 E_GATE_ALREADY_DECIDED with prior details (E-57).
		 * - Updates gate state to 'decided' within transaction.
		 * - If kind is 'landing' and decision is 'pass': marks task landed, emits task.landed with by='human' and gateId (AC 2b).
		 * - Emits task.gate_passed or records human rejection without auto-rescheduling (E-05).
		 */
		async decideGate(input: {
			readonly gateId: string;
			readonly decision: 'pass' | 'reject';
			readonly comment?: string;
			readonly actorDeviceId: string | null;
		}): Promise<DecideGateResponse> {
			const gate = deps.gatesRepo.findById(input.gateId);
			if (!gate) {
				throw new AppError('E_NOT_FOUND', `Gate ${input.gateId} not found.`);
			}

			// E-57 Idempotency: second decision returns E_GATE_ALREADY_DECIDED with prior decider details
			if (gate.state === 'decided') {
				throw new AppError('E_GATE_ALREADY_DECIDED', 'Gate already decided by another device.', {
					details: {
						decidedByDeviceId: gate.decided_by_device_id,
						decidedAt: gate.decided_at,
						decision: gate.decision,
						gateId: gate.id,
					},
				});
			}

			const now = deps.clock.now();
			const comment = input.comment ?? null;

			// AC 5, E-288: Batch-level wrapup gate (task_id IS NULL)
			if (!gate.task_id && gate.run_id) {
				if (input.decision === 'pass') {
					if (!comment || comment.trim().length === 0) {
						throw new AppError(
							'E_VALIDATION',
							'Comment is required when passing a batch wrapup gate.',
							{
								details: { field: 'comment' },
							},
						);
					}

					const pendingEnvelopes: EventEnvelope[] = [];
					const humanWrapupId = `wrapup_${deps.ids.newId().slice(0, 16)}`;
					const humanRound =
						gate.run_id && deps.runsRepo?.findById(gate.run_id)?.batch_id
							? (deps.batchWrapupsRepo?.getMaxRound(
									deps.runsRepo.findById(gate.run_id)?.batch_id ?? '',
								) ?? 0) + 1
							: 1;
					deps.unitOfWork.run(() => {
						deps.gatesRepo.updateDecision(input.gateId, 'pass', comment, input.actorDeviceId, now);

						const runId = gate.run_id;
						const wrapupRun = runId ? deps.runsRepo?.findById(runId) : null;
						if (wrapupRun?.batch_id) {
							const batch = deps.batchesRepo?.findById(wrapupRun.batch_id);
							if (batch) {
								// Write human verdict wrapup record
								if (deps.batchWrapupsRepo) {
									const tasks = deps.tasksRepo?.listByBatchId(batch.id) ?? [];
									const taskKeys = tasks.map((t) => t.task_key);
									deps.batchWrapupsRepo.insert({
										id: humanWrapupId,
										batch_id: batch.id,
										batch_no: batch.batch_no,
										tasks_json: JSON.stringify(taskKeys),
										round: humanRound,
										run_id: wrapupRun.id,
										verdict: 'clean',
										declared_verdict: null,
										is_human_verdict: 1,
										prompt_source: (wrapupRun.prompt_source as 'docs' | 'builtin') ?? 'docs',
										tests_json: JSON.stringify({ status: 'pass', items: [] }),
										summary_text: comment,
										findings_json: '[]',
										unassigned_json: '[]',
										fix_run_ids_json: '[]',
										report_text: comment,
										created_at: now,
									});
								}

								// Batch transitions to done via batchService (R1)
								if (deps.batchService && batch.state !== 'done') {
									const transRes = deps.batchService.transitionBatchInTx(
										batch.id,
										'done',
										'human_wrapup_passed',
									);
									pendingEnvelopes.push(transRes.envelope);
								}

								pendingEnvelopes.push(
									deps.envelopeFactory.createEnvelope({
										kind: 'batch.wrapup_finished',
										payload: {
											batchId: batch.id,
											batchNo: batch.batch_no,
											runId: wrapupRun.id,
											round: humanRound,
											wrapupId: humanWrapupId,
											verdict: 'clean',
											declaredVerdict: null,
											fixRunIds: [],
											unassignedCount: 0,
											batchState: 'done',
											isHumanVerdict: true,
										},
									}),
								);

								// Wrapup run transitions to landed
								deps.runsRepo?.updateState({
									id: wrapupRun.id,
									toState: 'landed',
									endedAt: now,
								});

								pendingEnvelopes.push(
									deps.envelopeFactory.createEnvelope({
										kind: 'run.state_changed',
										runId: wrapupRun.id,
										taskId: null,
										payload: {
											from: wrapupRun.state,
											to: 'landed',
											reason: 'human_wrapup_passed',
										},
									}),
								);
							}
						}
					});

					for (const env of pendingEnvelopes) {
						deps.bus.publish(env);
					}
					return Object.freeze({ applied: true as const });
				}

				// Reject on batch-level gate: only close the gate, leave batch in needs_attention (AC 5, E-288)
				deps.unitOfWork.run(() => {
					deps.gatesRepo.updateDecision(input.gateId, 'reject', comment, input.actorDeviceId, now);
				});
				return Object.freeze({ applied: true as const });
			}

			let archiveContext: ArchiveTaskContext | null = null;
			let laneReleasedEvent: EventEnvelope | null = null;
			let laneAssignedEnvelope: EventEnvelope | null = null;
			let reworkStateEnvelope: EventEnvelope | null = null;
			let reworkDeliveryInput: {
				readonly reviewRunId?: string | null;
				readonly targetRunId: string;
				readonly reworkText: string;
				readonly source: 'human';
				readonly actorDeviceId?: string | null;
				readonly countAlreadyApplied: true;
			} | null = null;

			deps.unitOfWork.run(() => {
				deps.gatesRepo.updateDecision(
					input.gateId,
					input.decision,
					comment,
					input.actorDeviceId,
					now,
				);

				if (input.decision === 'reject' && gate.comment === 'exited_before_output') {
					// AC 8: decide{decision:'reject'} goes awaiting_human -> failed (human judged failure), NOT rework
					if (gate.run_id && deps.runsRepo) {
						deps.runsRepo.updateState({
							id: gate.run_id,
							fromState: 'awaiting_human',
							toState: 'failed',
							queuedReason: 'human_rejected',
							endedAt: now,
						});
						if (deps.envelopeFactory) {
							reworkStateEnvelope = deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId: gate.run_id,
								taskId: gate.task_id,
								actorDeviceId: input.actorDeviceId,
								payload: {
									from: 'awaiting_human',
									to: 'failed',
									reason: 'human_rejected',
								},
							});
						}
					}
					return;
				}

				if (input.decision === 'pass' && gate.kind === 'landing' && gate.task_id) {
					if (deps.tasksRepo) {
						deps.tasksRepo.updateManualState(gate.task_id, 'landed');
					}
					if (deps.runsRepo && gate.run_id) {
						deps.runsRepo.updateState({
							id: gate.run_id,
							toState: 'landed',
							endedAt: now,
						});
					}
					// R4: 人工 landed 完成会话归档与槽位释放
					if (deps.sessionArchiveService && gate.task_id) {
						archiveContext = deps.sessionArchiveService.archiveTaskInTx({
							taskId: gate.task_id,
							runId: gate.run_id ?? '',
							actorDeviceId: input.actorDeviceId,
							now,
						});
						if (archiveContext.laneReleased) {
							laneReleasedEvent = deps.envelopeFactory.createEnvelope({
								kind: 'lane.released',
								taskId: gate.task_id,
								runId: gate.run_id ?? '',
								actorDeviceId: input.actorDeviceId ?? null,
								payload: {
									docId: archiveContext.docId,
									laneNo: archiveContext.laneNo,
									taskId: gate.task_id,
									runId: gate.run_id ?? '',
									reason: 'landed',
								},
							});
						}
					} else if (deps.tasksRepo && gate.task_id) {
						const laneRes = deps.tasksRepo.clearLaneNo(gate.task_id);
						if (laneRes.changes === 1) {
							laneReleasedEvent = deps.envelopeFactory.createEnvelope({
								kind: 'lane.released',
								taskId: gate.task_id,
								runId: gate.run_id ?? '',
								actorDeviceId: input.actorDeviceId ?? null,
								payload: {
									docId: laneRes.docId,
									laneNo: laneRes.previousLaneNo,
									taskId: gate.task_id,
									runId: gate.run_id ?? '',
									reason: 'landed',
								},
							});
						}
					}
				} else if (input.decision === 'reject' && deps.tasksRepo && gate.task_id) {
					// E-327: 人工打回进入返工。
					// 这里只做闸门决定、意见落库、运行状态与泳道归属，全部在同一事务里；
					// 人工决定当场计数；等泳道或批次恢复后投递不得再消耗一次额度。
					const task = deps.tasksRepo.findById(gate.task_id);
					const doc = task && deps.documentsRepo ? deps.documentsRepo.findById(task.doc_id) : null;
					const reworkText = comment || 'Rejected by human';

					let targetRun: RunRow | null = null;
					if (gate.run_id && deps.runsRepo) {
						const run = deps.runsRepo.findById(gate.run_id);
						if (run && run.kind === 'implement') {
							targetRun = run;
						}
					}
					if (!targetRun && deps.runsRepo) {
						const runs = deps.runsRepo.listByTaskId(gate.task_id);
						const implRuns = runs.filter((r) => r.kind === 'implement');
						if (implRuns.length > 0) {
							targetRun = implRuns.reduce((prev, curr) =>
								curr.attempt_no > prev.attempt_no ? curr : prev,
							);
						}
					}
					if (targetRun && deps.runsRepo) {
						deps.runsRepo.updateReworkCount({
							id: targetRun.id,
							reworkCount: (targetRun.rework_count ?? 0) + 1,
						});
					}

					const docLaneCount = doc?.lane_count ?? 2;
					const docTasks = task ? deps.tasksRepo.listByDocId(task.doc_id) : [];
					const allRuns = deps.runsRepo?.listAll() ?? [];
					const docBatchIds = new Set(
						task && deps.batchesRepo
							? deps.batchesRepo.listByDocId(task.doc_id).map((batch) => batch.id)
							: [],
					);
					const occupiedLanes = new Set<number>();
					for (const t of docTasks) {
						if (typeof t.lane_no === 'number' && t.lane_no >= 1) {
							occupiedLanes.add(t.lane_no);
						}
					}
					for (const r of allRuns) {
						if (
							r.kind === 'wrapup' &&
							Boolean(r.batch_id && docBatchIds.has(r.batch_id)) &&
							typeof r.lane_no === 'number' &&
							r.lane_no >= 1 &&
							!isTerminalRunState(r.state as RunState) &&
							r.state !== 'awaiting_human' &&
							r.state !== 'orphaned'
						) {
							occupiedLanes.add(r.lane_no);
						}
					}
					const freeLanes = freeLaneNumbers(docLaneCount, occupiedLanes);

					// E-327: 批次暂停期间一律不入道（哪怕有空槽），等恢复后由 tick 先于新任务入道
					const batch =
						task?.batch_id && deps.batchesRepo ? deps.batchesRepo.findById(task.batch_id) : null;
					const batchPaused = batch?.state === 'paused';

					if (!batchPaused && freeLanes.length > 0) {
						const allocatedLaneNo = freeLanes[0] ?? 1;
						deps.tasksRepo.assignLaneNo(gate.task_id, allocatedLaneNo);
						deps.tasksRepo.updateManualState(gate.task_id, null);

						if (targetRun && deps.runsRepo) {
							deps.runsRepo.updateLaneNo?.(targetRun.id, allocatedLaneNo);
							deps.runsRepo.updateState({
								id: targetRun.id,
								state: 'reworking',
								queuedReason: null,
							});
						}

						if (deps.envelopeFactory) {
							laneAssignedEnvelope = deps.envelopeFactory.createEnvelope({
								kind: 'lane.assigned',
								actorDeviceId: input.actorDeviceId,
								payload: {
									docId: task?.doc_id ?? '',
									laneNo: allocatedLaneNo,
									taskId: gate.task_id,
									runId: targetRun?.id ?? gate.run_id ?? '',
								},
							});
							if (targetRun) {
								reworkStateEnvelope = deps.envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: targetRun.id,
									taskId: gate.task_id,
									actorDeviceId: input.actorDeviceId,
									payload: {
										from: targetRun.state as RunState,
										to: 'reworking',
										reason: 'human_rework',
									},
								});
							}
						}

						reworkDeliveryInput =
							targetRun && deps.reworkService
								? {
										reviewRunId: gate.run_id,
										targetRunId: targetRun.id,
										reworkText,
										source: 'human',
										actorDeviceId: input.actorDeviceId,
										countAlreadyApplied: true,
									}
								: null;
					} else {
						// 无空槽或批次暂停：任务留在泳道外（E-326, E-327），
						// 恢复/空槽后由 tick 先于新任务入道并按 M7-T5 三分支投递
						deps.tasksRepo.clearLaneNo(gate.task_id);
						deps.tasksRepo.updateManualState(gate.task_id, null);

						if (targetRun && deps.runsRepo) {
							deps.runsRepo.updateLaneNo?.(targetRun.id, null);
							deps.runsRepo.updateState({
								id: targetRun.id,
								state: 'reworking',
								queuedReason: batchPaused ? 'batch_paused' : 'lane_full',
							});
						}

						if (targetRun && deps.envelopeFactory) {
							reworkStateEnvelope = deps.envelopeFactory.createEnvelope({
								kind: 'run.state_changed',
								runId: targetRun.id,
								taskId: gate.task_id,
								actorDeviceId: input.actorDeviceId,
								payload: {
									from: targetRun.state as RunState,
									to: 'reworking',
									reason: 'human_rework',
								},
							});
						}
					}
				}
			});

			// Outside transaction: publish events
			if (input.decision === 'reject' && gate.comment === 'exited_before_output') {
				if (reworkStateEnvelope) {
					deps.bus.publish(reworkStateEnvelope);
				}
				return Object.freeze({ applied: true as const });
			}

			if (laneReleasedEvent) {
				deps.bus.publish(laneReleasedEvent);
			}
			if (laneAssignedEnvelope) {
				deps.bus.publish(laneAssignedEnvelope);
			}
			if (reworkStateEnvelope) {
				deps.bus.publish(reworkStateEnvelope);
			}
			if (input.decision === 'reject') {
				if (reworkDeliveryInput && deps.reworkService) {
					const result = await deps.reworkService.dispatchRework(reworkDeliveryInput);
					// #136：handover 与 undeliverable 都是「没人接住这次返工」。
					// 闸门决定与计数已经落库，但投递没成功，必须回类型化错误，不能报成功。
					if (result.mode === 'undeliverable') {
						throw new AppError('E_MESSAGE_UNDELIVERED', result.message, {
							details: {
								gateId: gate.id,
								decisionApplied: true,
								targetRunId: result.targetRunId,
								reworkRunId: result.reworkRunId ?? null,
								reason: result.reason,
							},
						});
					}
					if (result.mode === 'handover') {
						throw new AppError(
							'E_MESSAGE_UNDELIVERED',
							'Rework was recorded but no session dispatcher accepted it.',
							{
								details: {
									gateId: gate.id,
									decisionApplied: true,
									targetRunId: result.handover.targetRunId,
									reason: 'session_dispatch_unavailable',
								},
							},
						);
					}
				}
				deps.nudgeTick?.();
			}
			if (input.decision === 'pass') {
				if (gate.kind === 'landing') {
					if (gate.run_id) {
						const stateEnvelope = deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: gate.run_id,
							taskId: gate.task_id,
							actorDeviceId: input.actorDeviceId,
							payload: {
								from: 'reviewing',
								to: 'landed',
								reason: 'human_landing_gate_passed',
							},
						});
						deps.bus.publish(stateEnvelope);
					}

					const landedEnvelope = deps.envelopeFactory.createEnvelope({
						kind: 'task.landed',
						taskId: gate.task_id,
						runId: gate.run_id,
						actorDeviceId: input.actorDeviceId,
						payload: {
							by: 'human',
							gateId: gate.id,
						},
					});
					deps.bus.publish(landedEnvelope);
				}

				const passedEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'task.gate_passed',
					taskId: gate.task_id,
					runId: gate.run_id,
					actorDeviceId: input.actorDeviceId,
					payload: {
						gate: gate.kind,
					},
				});
				deps.bus.publish(passedEnvelope);

				if (archiveContext && deps.sessionArchiveService) {
					await deps.sessionArchiveService.terminateArchived(archiveContext);
				}
			}

			return Object.freeze({ applied: true as const });
		},

		/**
		 * Lists all gates with optional filter for pending (waiting) gates.
		 */
		async listGates(params?: {
			readonly pendingOnly?: boolean;
			readonly agentService?: AgentService;
		}): Promise<ListGatesResponse> {
			const rows = deps.gatesRepo.list(params);
			return Object.freeze({
				gates: rows.map((row) => rowToGateDto(row, resolveGateContext(row, params?.agentService))),
			});
		},

		/**
		 * Creates a new waiting gate (E-54: releases concurrency, does not occupy running slot).
		 */
		async createWaitingGate(input: {
			readonly taskId: string;
			readonly runId?: string | null;
			readonly kind: 'dispatch' | 'review' | 'landing';
			readonly comment?: string;
		}): Promise<GateDto> {
			const gateId = deps.ids.newId();
			const now = deps.clock.now();

			deps.unitOfWork.run(() => {
				deps.gatesRepo.create({
					id: gateId,
					task_id: input.taskId,
					run_id: input.runId ?? null,
					kind: input.kind,
					state: 'waiting',
					comment: input.comment ?? null,
					created_at: now,
				});
			});

			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'task.gate_waiting',
				taskId: input.taskId,
				runId: input.runId ?? null,
				actorDeviceId: null,
				payload: {
					gate: input.kind,
				},
			});
			deps.bus.publish(envelope);

			const created = deps.gatesRepo.findById(gateId);
			if (!created) {
				throw new AppError('E_INTERNAL', `Failed to create gate ${gateId}`);
			}
			return rowToGateDto(created);
		},

		/**
		 * Evaluates post-review progression using resolveAfterReview domain logic (AC 1, AC 2, AC 2b):
		 * - Checks batch-level gateOverrides if task belongs to a batch and no explicit overrides were handed in.
		 * - If resolved to 'landed' (auto review + auto landing):
		 *   marks task landed, creates decided landing gate, publishes task.landed with by='auto' and gateId.
		 * - If resolved to 'await_human':
		 *   creates waiting gate, releases concurrency (AC 3, E-54), publishes task.gate_waiting.
		 */
		async resolveAfterReviewAndApply(input: {
			readonly taskId: string;
			readonly runId?: string | null;
			readonly reviewVerdict: string;
			readonly overrides?: GateOverrides | null;
		}): Promise<ResolveAfterReviewResult> {
			const settings = deps.settingsService.getGates();
			const batchId = deps.tasksRepo?.findById(input.taskId)?.batch_id;
			const batchOverrides =
				batchId !== undefined && batchId !== null
					? (input.overrides ??
						deps.getBatchGateOverrides?.(batchId) ??
						batchGateOverridesMap.get(batchId))
					: input.overrides;

			const result = resolveAfterReview({
				reviewVerdict: input.reviewVerdict,
				settings,
				overrides: batchOverrides,
			});

			const now = deps.clock.now();

			if (result.outcome === 'landed') {
				// A landed run may still need its landing gate and task state recorded.
				const existingTask = deps.tasksRepo?.findById(input.taskId);
				if (existingTask?.manual_state === 'landed') {
					return result;
				}

				// AC 1 & AC 2b: automatic pass lands directly with zero git operations
				const gateId = deps.ids.newId();
				let archiveContext: ArchiveTaskContext | null = null;
				let laneReleasedEvent: EventEnvelope | null = null;

				deps.unitOfWork.run(() => {
					deps.gatesRepo.create({
						id: gateId,
						task_id: input.taskId,
						run_id: input.runId,
						kind: 'landing',
						state: 'decided',
						decision: 'pass',
						comment: 'auto_landing_gate',
						decided_by_device_id: null,
						created_at: now,
						decided_at: now,
					});

					if (deps.tasksRepo) {
						deps.tasksRepo.updateManualState(input.taskId, 'landed');
					}
					if (deps.runsRepo && input.runId) {
						deps.runsRepo.updateState({
							id: input.runId,
							toState: 'landed',
							endedAt: now,
						});
					}

					// R4: 自动 landed 完成会话归档与槽位释放
					if (deps.sessionArchiveService) {
						archiveContext = deps.sessionArchiveService.archiveTaskInTx({
							taskId: input.taskId,
							runId: input.runId ?? '',
							now,
						});
						if (archiveContext.laneReleased) {
							laneReleasedEvent = deps.envelopeFactory.createEnvelope({
								kind: 'lane.released',
								taskId: input.taskId,
								runId: input.runId ?? '',
								actorDeviceId: null,
								payload: {
									docId: archiveContext.docId,
									laneNo: archiveContext.laneNo,
									taskId: input.taskId,
									runId: input.runId ?? '',
									reason: 'landed',
								},
							});
						}
					} else if (deps.tasksRepo) {
						const laneRes = deps.tasksRepo.clearLaneNo(input.taskId);
						if (laneRes.changes === 1) {
							laneReleasedEvent = deps.envelopeFactory.createEnvelope({
								kind: 'lane.released',
								taskId: input.taskId,
								runId: input.runId ?? '',
								actorDeviceId: null,
								payload: {
									docId: laneRes.docId,
									laneNo: laneRes.previousLaneNo,
									taskId: input.taskId,
									runId: input.runId ?? '',
									reason: 'landed',
								},
							});
						}
					}
				});

				if (laneReleasedEvent) {
					deps.bus.publish(laneReleasedEvent);
				}
				if (input.runId) {
					const stateEnvelope = deps.envelopeFactory.createEnvelope({
						kind: 'run.state_changed',
						runId: input.runId,
						taskId: input.taskId,
						actorDeviceId: null,
						payload: {
							from: 'reviewing',
							to: 'landed',
							reason: 'auto_landing_gate_passed',
						},
					});
					deps.bus.publish(stateEnvelope);
				}

				const landedEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'task.landed',
					taskId: input.taskId,
					runId: input.runId,
					actorDeviceId: null,
					payload: {
						by: 'auto',
						gateId,
					},
				});
				deps.bus.publish(landedEnvelope);

				const passedEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'task.gate_passed',
					taskId: input.taskId,
					runId: input.runId,
					actorDeviceId: null,
					payload: {
						gate: 'landing',
					},
				});
				deps.bus.publish(passedEnvelope);

				if (archiveContext && deps.sessionArchiveService) {
					await deps.sessionArchiveService.terminateArchived(archiveContext);
				}
			} else {
				// Stays in awaiting_human; creates waiting gate (AC 3, E-54)
				const gateId = deps.ids.newId();
				deps.unitOfWork.run(() => {
					deps.gatesRepo.create({
						id: gateId,
						task_id: input.taskId,
						run_id: input.runId,
						kind: result.gateKind,
						state: 'waiting',
						comment: result.reason,
						created_at: now,
					});

					if (deps.tasksRepo) {
						deps.tasksRepo.updateManualState(input.taskId, 'awaiting_human');
					}
				});

				const waitingEnvelope = deps.envelopeFactory.createEnvelope({
					kind: 'task.gate_waiting',
					taskId: input.taskId,
					runId: input.runId,
					actorDeviceId: null,
					payload: {
						gate: result.gateKind,
					},
				});
				deps.bus.publish(waitingEnvelope);
			}

			return result;
		},

		/**
		 * Re-evaluates waiting gates when gate settings change (R2, E-56):
		 * - For gate kinds changed to 'auto': immediately releases waiting gates without restarting batches.
		 * - For gate kinds remaining 'manual': keeps waiting without rollback or disturbance.
		 * - Caller owns the transaction and the publishing; this method only writes rows and
		 *   returns the events to publish.
		 */
		reEvaluateWaitingGatesInTx(
			newGates: GateSettings,
			previousGates: GateSettings | undefined,
			actorDeviceId: string | null,
		): readonly EventEnvelope[] {
			const now = deps.clock.now();
			const eventsToPublish: EventEnvelope[] = [];

			const kindsToCheck: GateKind[] = [];
			if (newGates.dispatch === 'auto' && (!previousGates || previousGates.dispatch === 'manual')) {
				kindsToCheck.push('dispatch');
			}
			if (newGates.review === 'auto' && (!previousGates || previousGates.review === 'manual')) {
				kindsToCheck.push('review');
			}
			if (newGates.landing === 'auto' && (!previousGates || previousGates.landing === 'manual')) {
				kindsToCheck.push('landing');
			}

			if (kindsToCheck.length === 0) {
				return eventsToPublish;
			}

			const waitingGates = deps.gatesRepo.list({ pendingOnly: true });

			for (const kind of kindsToCheck) {
				const matchingGates = waitingGates.filter((g) => g.kind === kind);

				for (const gate of matchingGates) {
					if (kind === 'dispatch') {
						deps.gatesRepo.updateDecision(
							gate.id,
							'pass',
							'auto_released_on_settings_change',
							actorDeviceId,
							now,
						);
						eventsToPublish.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'task.gate_passed',
								taskId: gate.task_id,
								runId: gate.run_id,
								actorDeviceId,
								payload: { gate: 'dispatch' },
							}),
						);
					} else if (kind === 'review') {
						deps.gatesRepo.updateDecision(
							gate.id,
							'pass',
							'auto_released_on_settings_change',
							actorDeviceId,
							now,
						);
						eventsToPublish.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'task.gate_passed',
								taskId: gate.task_id,
								runId: gate.run_id,
								actorDeviceId,
								payload: { gate: 'review' },
							}),
						);

						if (newGates.landing === 'auto') {
							const landingGateId = deps.ids.newId();
							deps.gatesRepo.create({
								id: landingGateId,
								task_id: gate.task_id,
								run_id: gate.run_id,
								kind: 'landing',
								state: 'decided',
								decision: 'pass',
								comment: 'auto_released_on_settings_change',
								decided_by_device_id: actorDeviceId,
								created_at: now,
								decided_at: now,
							});

							if (deps.tasksRepo && gate.task_id) {
								deps.tasksRepo.updateManualState(gate.task_id, 'landed');
							}

							eventsToPublish.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'task.landed',
									taskId: gate.task_id,
									runId: gate.run_id,
									actorDeviceId,
									payload: { by: 'auto', gateId: landingGateId },
								}),
							);
							eventsToPublish.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'task.gate_passed',
									taskId: gate.task_id,
									runId: gate.run_id,
									actorDeviceId,
									payload: { gate: 'landing' },
								}),
							);
						} else {
							const landingGateId = deps.ids.newId();
							deps.gatesRepo.create({
								id: landingGateId,
								task_id: gate.task_id,
								run_id: gate.run_id,
								kind: 'landing',
								state: 'waiting',
								comment: 'landing_manual_gate',
								created_at: now,
							});

							if (deps.tasksRepo && gate.task_id) {
								deps.tasksRepo.updateManualState(gate.task_id, 'awaiting_human');
							}

							eventsToPublish.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'task.gate_waiting',
									taskId: gate.task_id,
									runId: gate.run_id,
									actorDeviceId,
									payload: { gate: 'landing' },
								}),
							);
						}
					} else if (kind === 'landing') {
						deps.gatesRepo.updateDecision(
							gate.id,
							'pass',
							'auto_released_on_settings_change',
							actorDeviceId,
							now,
						);

						if (deps.tasksRepo && gate.task_id) {
							deps.tasksRepo.updateManualState(gate.task_id, 'landed');
						}

						eventsToPublish.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'task.landed',
								taskId: gate.task_id,
								runId: gate.run_id,
								actorDeviceId,
								payload: { by: 'auto', gateId: gate.id },
							}),
						);
						eventsToPublish.push(
							deps.envelopeFactory.createEnvelope({
								kind: 'task.gate_passed',
								taskId: gate.task_id,
								runId: gate.run_id,
								actorDeviceId,
								payload: { gate: 'landing' },
							}),
						);
					}
				}
			}

			return eventsToPublish;
		},

		setBatchGateOverrides(batchId: string, overrides: BatchGateOverrides): void {
			batchGateOverridesMap.set(batchId, Object.freeze({ ...overrides }));
		},

		getBatchGateOverrides(batchId: string): BatchGateOverrides | undefined {
			return batchGateOverridesMap.get(batchId);
		},
	});
}
