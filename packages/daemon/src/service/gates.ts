import type { BatchGateOverrides } from '@agent-scheduler/shared/api/batches';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type {
	DecideGateResponse,
	GateDto,
	ListGatesResponse,
} from '@agent-scheduler/shared/api/gates';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { assertCanTransitionBatch } from '../domain/batch-state-machine.ts';
import {
	type GateKind,
	type GateOverrides,
	type ResolveAfterReviewResult,
	resolveAfterReview,
} from '../domain/gates.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { BatchWrapupsRepo } from '../repo/batch-wrapups.ts';
import type { BatchesRepo } from '../repo/batches.ts';
import type { GateRow, GatesRepo } from '../repo/gates.ts';
import type { RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';
import type { SettingsService } from './settings.ts';

export interface GateServiceDeps {
	readonly gatesRepo: GatesRepo;
	readonly tasksRepo?: TasksRepo;
	readonly runsRepo?: RunsRepo;
	readonly batchesRepo?: BatchesRepo;
	readonly batchWrapupsRepo?: BatchWrapupsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly unitOfWork: UnitOfWork;
	readonly settingsService: SettingsService;
	readonly getBatchGateOverrides?: (batchId: string) => BatchGateOverrides | undefined;
}

export interface GateService {
	readonly decideGate: (input: {
		readonly gateId: string;
		readonly decision: 'pass' | 'reject';
		readonly comment?: string;
		readonly actorDeviceId: string | null;
	}) => Promise<DecideGateResponse>;
	readonly listGates: (params?: { readonly pendingOnly?: boolean }) => Promise<ListGatesResponse>;
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

function rowToGateDto(row: GateRow): GateDto {
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
	});
}

export function createGateService(deps: GateServiceDeps): GateService {
	const batchGateOverridesMap = new Map<string, BatchGateOverrides>();

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
										id: `wrapup_${deps.ids.newId().slice(0, 16)}`,
										batch_id: batch.id,
										batch_no: batch.batch_no,
										tasks_json: JSON.stringify(taskKeys),
										round: wrapupRun.attempt_no,
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

								// Batch transitions to done
								if (batch.state !== 'done') {
									assertCanTransitionBatch(batch.state, 'done');
									deps.batchesRepo?.updateState({
										id: batch.id,
										state: 'done',
										finished_at: now,
									});

									pendingEnvelopes.push(
										deps.envelopeFactory.createEnvelope({
											kind: 'batch.advanced',
											payload: {
												batchId: batch.id,
												batchNo: batch.batch_no,
												from: batch.state,
												to: 'done',
												reason: 'human_wrapup_passed',
											},
										}),
									);
								}

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

			deps.unitOfWork.run(() => {
				deps.gatesRepo.updateDecision(
					input.gateId,
					input.decision,
					comment,
					input.actorDeviceId,
					now,
				);

				if (
					input.decision === 'pass' &&
					gate.kind === 'landing' &&
					deps.tasksRepo &&
					gate.task_id
				) {
					deps.tasksRepo.updateManualState(gate.task_id, 'landed');
				} else if (input.decision === 'reject' && deps.tasksRepo && gate.task_id) {
					// E-05: Human rejection sets manual state, automatic dispatch must not override human judgment
					deps.tasksRepo.updateManualState(gate.task_id, 'paused');
				}
			});

			// Outside transaction: publish events
			if (input.decision === 'pass') {
				if (gate.kind === 'landing') {
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
			}

			return Object.freeze({ applied: true as const });
		},

		/**
		 * Lists all gates with optional filter for pending (waiting) gates.
		 */
		async listGates(params?: { readonly pendingOnly?: boolean }): Promise<ListGatesResponse> {
			const rows = deps.gatesRepo.list(params);
			return Object.freeze({
				gates: rows.map(rowToGateDto),
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
				// AC 1 & AC 2b: automatic pass lands directly with zero git operations
				const gateId = deps.ids.newId();
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
				});

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
