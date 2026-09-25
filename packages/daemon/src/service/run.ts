import { EVENT_DEFINITIONS, type EventEnvelope } from '@agent-scheduler/shared/api/events';
import { redactSecrets } from '../adapters/probe.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { isContentEventKind } from '../domain/content-events.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	assertValidTransition,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { AppendResult } from '../logstore/run-writer.ts';
import type { ManagedProcess, ProcessExitResult } from '../proc/spawn.ts';
import type { AppendEventResult, EventEnvelopeInput, LogstoreService } from './logstore.ts';
import type { ArchiveTaskContext, SessionArchiveService } from './session-archive.ts';

export interface RunRecord {
	readonly id: string;
	readonly taskId: string | null;
	readonly state: RunState;
	readonly pid: number | null;
	readonly kind?: string;
	readonly origin?: string;
	readonly agentId?: string;
	readonly agent_id?: string;
	readonly startedAt?: string | null;
	readonly started_at?: string | null;
	readonly sessionArchivedAt?: string | null;
	readonly session_archived_at?: string | null;
	readonly laneNo?: number | null;
	readonly lane_no?: number | null;
	readonly lastEventAt?: string | null;
	readonly unmappedEventCount?: number;
	readonly exitCode?: number | null;
	readonly exitSignal?: string | null;
	readonly endedAt?: string | null;
	readonly actorDeviceId?: string | null;
}

export interface RunsRepo {
	findById(id: string): RunRecord | null;
	updateState(input: {
		readonly id: string;
		readonly fromState: RunState;
		readonly toState: RunState;
		readonly queuedReason?: string | null;
		readonly endedAt?: string | null;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly actorDeviceId?: string | null;
		readonly pid?: number | null;
		readonly worktreePath?: string | null;
		readonly branchName?: string | null;
	}): void;
	updateLastEventAt(id: string, lastEventAt: string): void;
	incrementUnmappedEventCount(id: string): void;
	findInFlight(): readonly RunRecord[];
}

export interface ReconcileRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly pid: number | null;
	readonly state: RunState;
	readonly agentId: string;
	readonly startedAt?: string | null;
	readonly lastEventAt?: string | null;
}

export interface IngestLineResult {
	readonly rawAppended: boolean;
	readonly rawLocation?: AppendResult;
	readonly eventsAppended: number;
	readonly unmappedDiscarded: boolean;
}

export interface AttachProcessOptions {
	readonly onEvent?: (envelope: EventEnvelope) => void;
	readonly onExit?: (result: ProcessExitResult) => Promise<void> | void;
	readonly mapExitResult?: (result: ProcessExitResult) => ProcessExitResult;
	readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
	readonly acceptsPlainText?: boolean;
}

export interface AttachedProcessController {
	readonly runId: string;
	readonly detach: () => void;
	readonly waitForCompletion: () => Promise<ProcessExitResult | undefined>;
}

export interface RunServiceDeps {
	readonly logstore: LogstoreService;
	readonly clock: { readonly now: () => string };
	readonly envelopeFactory: EnvelopeFactory;
	readonly bus?: EventBus;
	readonly unitOfWork?: UnitOfWork;
	readonly runsRepo?: RunsRepo;
	readonly tasksRepo?: {
		readonly clearLaneNo: (taskId: string) => {
			readonly changes: number;
			readonly previousLaneNo: number | null;
			readonly docId: string | null;
		};
	};
	readonly sessionArchiveService?: SessionArchiveService;
	readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
	readonly logFailure?: (error: unknown) => void;
	readonly finalizeWrapup?: (input: {
		readonly runId: string;
		readonly exitCode: number | null;
	}) => Promise<void>;
	readonly finalizeReview?: (input: {
		readonly runId: string;
		readonly exitCode: number | null;
	}) => Promise<unknown>;
	readonly evaluateMechanicalCheck?: (input: {
		readonly runId: string;
		readonly exitCode?: number | null;
	}) => Promise<unknown>;
	readonly agentService?: {
		readonly refreshLogin: (
			agentId: string,
			options?: {
				readonly force?: boolean;
				readonly trigger?:
					| 'exited_before_output'
					| 'probe'
					| 'models_refresh'
					| 'availability_changed';
			},
		) => Promise<unknown>;
	};
	readonly gatesRepo?: {
		readonly create: (gate: {
			readonly id: string;
			readonly task_id: string | null;
			readonly run_id?: string | null;
			readonly kind: string;
			readonly state: string;
			readonly comment?: string | null;
			readonly created_at: string;
		}) => void;
	};
	readonly ids?: { readonly newId: () => string };
}

export interface RunService {
	ingestRaw(runId: string, rawLine: string | Uint8Array): Promise<AppendResult>;
	ingestEvent(runId: string, envelope: EventEnvelopeInput): Promise<AppendEventResult>;
	ingestLine(
		runId: string,
		line: string | Uint8Array,
		options?: {
			readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
			readonly taskId?: string | null;
			readonly actorDeviceId?: string | null;
			readonly acceptsPlainText?: boolean;
		},
	): Promise<IngestLineResult>;
	attachProcess(
		runId: string,
		process: ManagedProcess,
		options?: AttachProcessOptions,
	): AttachedProcessController;
	transitionState(input: {
		readonly runId: string;
		readonly targetState: RunState;
		readonly reason: string;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly endedAt?: string | null;
		readonly actorDeviceId?: string | null;
		readonly pid?: number | null;
		readonly worktreePath?: string | null;
		readonly branchName?: string | null;
	}): Promise<{ readonly previousState: RunState; readonly currentState: RunState }>;
	closeRunStream(runId: string): Promise<void>;
	hasContentProduced?(runId: string): boolean;
	getLatestStderrTail?(runId: string): readonly string[] | null;
	findInFlightRuns(): Promise<readonly ReconcileRunRecord[]>;
	publishStalledSuspected?: (eventInput: {
		readonly kind: 'run.stalled_suspected';
		readonly runId: string;
		readonly taskId: string;
		readonly actorDeviceId?: string | null;
		readonly payload: unknown;
	}) => Promise<void>;
	markInterrupted(
		runId: string,
		details: {
			readonly reason: string;
			readonly endedAt: string;
			readonly actorDeviceId: null;
		},
	): Promise<void>;
	markOrphaned(
		runId: string,
		details: {
			readonly reason: string;
			readonly actorDeviceId: null;
		},
	): Promise<void>;
	markAwaitingReply(
		runId: string,
		details?: {
			readonly reason?: string;
			readonly actorDeviceId?: string | null;
		},
	): Promise<void>;
	elevateRunOnce(
		runId: string,
		details?: {
			readonly reason?: string;
			readonly actorDeviceId?: string | null;
		},
	): Promise<void>;
	isAwaitingReply(runId: string): Promise<boolean>;
	isTemporarilyElevated(runId: string): boolean;
	clearTemporaryElevation(runId: string): void;
}

function normalizeRawLineBytes(rawLine: string | Uint8Array): Uint8Array {
	if (typeof rawLine === 'string') {
		const stripped = rawLine.endsWith('\r\n')
			? rawLine.slice(0, -2)
			: rawLine.endsWith('\n')
				? rawLine.slice(0, -1)
				: rawLine;
		return Buffer.from(stripped, 'utf8');
	}
	let len = rawLine.length;
	if (len > 0 && rawLine[len - 1] === 0x0a) {
		len--;
		if (len > 0 && rawLine[len - 1] === 0x0d) {
			len--;
		}
		return rawLine.subarray(0, len);
	}
	return rawLine;
}

function isCanonicalEnvelopeCandidate(val: unknown): val is EventEnvelope {
	if (!val || typeof val !== 'object') return false;
	const candidate = val as Record<string, unknown>;
	return (
		typeof candidate.kind === 'string' &&
		candidate.kind in EVENT_DEFINITIONS &&
		typeof candidate.id === 'number' &&
		typeof candidate.ts === 'string' &&
		typeof candidate.seq === 'number' &&
		'payload' in candidate
	);
}

function getRedactedStderrTailLines(proc: ManagedProcess, error?: Error): readonly string[] {
	const rawLines =
		proc.stderrTailLines && proc.stderrTailLines.length > 0
			? proc.stderrTailLines
			: proc.stderrTail
				? proc.stderrTail.split('\n')
				: error?.message
					? [error.message]
					: [];
	const sliced = rawLines.slice(-20);
	return Object.freeze(sliced.map((l) => redactSecrets(l)));
}

/**
 * Service for run stream orchestration and disk wiring (M6-T2).
 *
 * Rules:
 * 1. AC 1: Writes every raw output line to `raw.log` and every normalized event to `events.ndjson`
 *    (full original text, never truncated).
 * 2. AC 2: `events` index table only receives milestone events; high-frequency `*_chunk` kinds
 *    do not enter the table and stay in `events.ndjson`.
 * 3. AC 3: No `await` or asynchronous side effects within transaction callbacks; events are
 *    published to `bus` strictly after the transaction returns.
 * 4. E-142: Memory holds only a bounded ring buffer (EventBus/RingBuffer); historical events are
 *    flushed to disk and read back on demand via cursor pages without memory accumulation.
 */
export function createRunService(deps: RunServiceDeps): RunService {
	const logFailure = deps.logFailure ?? (() => undefined);
	const temporarilyElevatedRuns = new Set<string>();
	const runsWithContent = new Set<string>();
	const latestExitedTails = new Map<string, readonly string[]>();

	function getNow(): string {
		return deps.clock.now();
	}

	async function ingestRaw(runId: string, rawLine: string | Uint8Array): Promise<AppendResult> {
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string');
		}
		const data = normalizeRawLineBytes(rawLine);
		return await deps.logstore.appendRaw(runId, data);
	}

	async function ingestEvent(
		runId: string,
		envelope: EventEnvelopeInput,
	): Promise<AppendEventResult> {
		if (isContentEventKind(envelope.kind)) {
			runsWithContent.add(runId);
		}
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string');
		}

		let fullEnvelope: EventEnvelope;
		const candidate = envelope as {
			readonly id?: unknown;
			readonly seq?: unknown;
			readonly ts?: unknown;
		};
		if (
			'id' in envelope &&
			typeof candidate.id === 'number' &&
			'seq' in envelope &&
			'ts' in envelope
		) {
			fullEnvelope = envelope as EventEnvelope;
		} else {
			const run = deps.runsRepo?.findById(runId) as
				| (RunRecord & {
						readonly task_id?: string | null;
						readonly actor_device_id?: string | null;
				  })
				| null;
			fullEnvelope = deps.envelopeFactory.createEnvelope({
				kind: envelope.kind as Parameters<EnvelopeFactory['createEnvelope']>[0]['kind'],
				runId,
				taskId: envelope.taskId ?? run?.taskId ?? run?.task_id ?? null,
				actorDeviceId: envelope.actorDeviceId ?? run?.actorDeviceId ?? run?.actor_device_id ?? null,
				payload: envelope.payload as Parameters<EnvelopeFactory['createEnvelope']>[0]['payload'],
			}) as EventEnvelope;
		}

		// 1. 落盘：全量原文写入 events.ndjson；里程碑写入 events 索引表，*_chunk 不进索引表 (AC 1, AC 2)
		const appendResult = await deps.logstore.appendEvent(runId, fullEnvelope);

		// 2. 更新运行元数据中的 last_event_at (若提供了仓储)
		if (deps.runsRepo) {
			if (deps.unitOfWork) {
				deps.unitOfWork.run(() => {
					deps.runsRepo?.updateLastEventAt(runId, fullEnvelope.ts);
				});
			} else {
				deps.runsRepo.updateLastEventAt(runId, fullEnvelope.ts);
			}
		}

		// 3. 事件发布在任何可能有的事务之后进行 (AC 3)
		//    单条 payload 超 32 KiB 时通过 locationRef 在入缓冲前替换为引用 (08节架构规范, E-142)
		//    内存中只经由 EventBus 保留最近 5000 条环形缓冲，历史事件全部按需回读
		if (deps.bus) {
			const locationRef = {
				fileSeq: appendResult.location.fileSeq,
				byteOffset: appendResult.location.byteOffset,
				byteLen: appendResult.location.byteLen,
			};
			deps.bus.publish(fullEnvelope, locationRef);
		}

		// 4. M6-T7 状态接线：从 starting 到 running，以及自动模式下提问/权限受阻转 awaiting_reply
		if (deps.runsRepo && fullEnvelope.kind !== 'run.state_changed') {
			await handleEventStateWiring(runId, fullEnvelope);
		}

		return appendResult;
	}

	async function ingestLine(
		runId: string,
		line: string | Uint8Array,
		options?: {
			readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
			readonly taskId?: string | null;
			readonly actorDeviceId?: string | null;
			readonly acceptsPlainText?: boolean;
		},
	): Promise<IngestLineResult> {
		// 1. 每条原始输出行写一行 raw.log (AC 1)
		const rawLocation = await ingestRaw(runId, line);

		const rawText = typeof line === 'string' ? line : Buffer.from(line).toString('utf8');
		const trimmed = rawText.trim();

		// 非 JSON 格式处理 (E-140 & R2 c: 纯文本 stdout 终稿支持)
		if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
			if (options?.acceptsPlainText) {
				const mapper = options?.eventMapper ?? deps.eventMapper;
				if (mapper) {
					const mapped = mapper(rawText);
					let eventsAppended = 0;
					for (const env of mapped) {
						await ingestEvent(runId, env);
						eventsAppended++;
					}
					return {
						rawAppended: true,
						rawLocation,
						eventsAppended,
						unmappedDiscarded: false,
					};
				}
			}
			return {
				rawAppended: true,
				rawLocation,
				eventsAppended: 0,
				unmappedDiscarded: false,
			};
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// JSON 无法解析的残缺行归入 raw.log 并继续，绝不中断流 (E-140)
			return {
				rawAppended: true,
				rawLocation,
				eventsAppended: 0,
				unmappedDiscarded: false,
			};
		}

		const mapper = options?.eventMapper ?? deps.eventMapper;
		let envelopesToIngest: readonly EventEnvelopeInput[] = [];
		let unmappedDiscarded = false;

		if (mapper) {
			const mapped = mapper(parsed);
			if (mapped.length > 0) {
				envelopesToIngest = mapped;
			} else {
				// 能解析但未映射到任何已知事件 (E-202)
				unmappedDiscarded = true;
				if (deps.runsRepo) {
					if (deps.unitOfWork) {
						deps.unitOfWork.run(() => {
							deps.runsRepo?.incrementUnmappedEventCount(runId);
						});
					} else {
						deps.runsRepo.incrementUnmappedEventCount(runId);
					}
				}
			}
		} else if (isCanonicalEnvelopeCandidate(parsed)) {
			envelopesToIngest = [parsed];
		} else {
			unmappedDiscarded = true;
			if (deps.runsRepo) {
				if (deps.unitOfWork) {
					deps.unitOfWork.run(() => {
						deps.runsRepo?.incrementUnmappedEventCount(runId);
					});
				} else {
					deps.runsRepo.incrementUnmappedEventCount(runId);
				}
			}
		}

		let eventsAppended = 0;
		for (const env of envelopesToIngest) {
			await ingestEvent(runId, env);
			eventsAppended++;
		}

		return {
			rawAppended: true,
			rawLocation,
			eventsAppended,
			unmappedDiscarded,
		};
	}

	function attachProcess(
		runId: string,
		process: ManagedProcess,
		options?: AttachProcessOptions,
	): AttachedProcessController {
		let detached = false;
		let hasContent = false;
		const cleanups: Array<() => void> = [];
		const pendingWrites = new Set<Promise<unknown>>();
		const trackWrite = <T>(p: Promise<T>): Promise<T> => {
			const settled = p
				.catch(() => undefined)
				.finally(() => {
					pendingWrites.delete(settled);
				});
			pendingWrites.add(settled);
			return p;
		};

		cleanups.push(
			process.onRaw((line) => {
				if (detached) return;
				void trackWrite(ingestRaw(runId, line.text)).catch((err) => logFailure(err));
				if (options?.acceptsPlainText) {
					const trimmed = line.text.trim();
					if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
						const mapper = options?.eventMapper ?? deps.eventMapper;
						if (mapper) {
							const mapped = mapper(line.text);
							for (const env of mapped) {
								if (isContentEventKind(env.kind)) {
									hasContent = true;
									runsWithContent.add(runId);
								}
								void trackWrite(
									ingestEvent(runId, env).then(() => {
										options?.onEvent?.(env);
									}),
								).catch((err) => logFailure(err));
							}
						}
					}
				}
			}),
		);

		cleanups.push(
			process.onJson((parsed) => {
				if (detached) return;
				const mapper = options?.eventMapper ?? deps.eventMapper;
				if (mapper) {
					const mapped = mapper(parsed.value);
					if (mapped.length > 0) {
						for (const env of mapped) {
							if (isContentEventKind(env.kind)) {
								hasContent = true;
								runsWithContent.add(runId);
							}
							void trackWrite(
								ingestEvent(runId, env).then(() => {
									options?.onEvent?.(env);
								}),
							).catch((err) => logFailure(err));
						}
					} else if (deps.runsRepo) {
						try {
							if (deps.unitOfWork) {
								deps.unitOfWork.run(() => {
									deps.runsRepo?.incrementUnmappedEventCount(runId);
								});
							} else {
								deps.runsRepo.incrementUnmappedEventCount(runId);
							}
						} catch (err) {
							logFailure(err);
						}
					}
				} else if (isCanonicalEnvelopeCandidate(parsed.value)) {
					const env = parsed.value;
					if (isContentEventKind(env.kind)) {
						hasContent = true;
						runsWithContent.add(runId);
					}
					void trackWrite(
						ingestEvent(runId, env).then(() => {
							options?.onEvent?.(env);
						}),
					).catch((err) => logFailure(err));
				}
			}),
		);

		let completionResolve: (result: ProcessExitResult | undefined) => void;
		const completionPromise = new Promise<ProcessExitResult | undefined>((resolve) => {
			completionResolve = resolve;
		});

		cleanups.push(
			process.onExit((rawResult) => {
				const result = options?.mapExitResult?.(rawResult) ?? rawResult;
				if (detached) {
					completionResolve(result);
					return;
				}

				void (async () => {
					let run: RunRecord | null = null;
					try {
						// 等审查输出落盘后再关闭、回读和裁决 (R2)
						while (pendingWrites.size > 0) {
							await Promise.all(Array.from(pendingWrites));
						}

						run = deps.runsRepo?.findById(runId) ?? null;
						const isStarting = run?.state === 'starting';

						const stderrTailLines = getRedactedStderrTailLines(process, result.error);
						latestExitedTails.set(runId, stderrTailLines);
						const eventStderrTail = Array.isArray(process.stderrTailLines)
							? stderrTailLines
							: typeof process.stderrTail === 'string'
								? redactSecrets(process.stderrTail)
								: stderrTailLines;

						// 1. spawn 抛错、启动超时及 starting 状态抢先退出必须落定 starting → failed (R3)
						if (isStarting) {
							const failureReason =
								result.reason === 'startup-timeout'
									? 'startup_timeout'
									: result.reason === 'spawn-failed'
										? 'spawn_failed'
										: 'premature_exit';
							if (run && !isTerminalRunState(run.state)) {
								await transitionState({
									runId,
									targetState: 'failed',
									reason: failureReason,
									exitCode: result.exitCode,
									exitSignal: result.signal ? String(result.signal) : null,
								});
							}
							const exitedEnvelope = deps.envelopeFactory.createEnvelope({
								kind: 'run.exited',
								runId,
								taskId: run?.taskId ?? null,
								actorDeviceId: run?.actorDeviceId ?? null,
								payload: {
									exitCode: result.exitCode,
									signal: result.signal ? String(result.signal) : null,
									stderrTail: stderrTailLines,
								},
							});
							await ingestEvent(runId, exitedEnvelope);
							await closeRunStream(runId);
							return;
						}

						const contentProduced = hasContent || runsWithContent.has(runId);

						// 2. 零产出退出 (E-348 / R3 / AC 7)
						if (!contentProduced) {
							const isImplementLike =
								run?.kind === 'implement' ||
								run?.origin === 'rework' ||
								run?.origin === 'wrapup-fix';

							if (isImplementLike) {
								const pendingEnvelopes: EventEnvelope[] = [];
								const now = deps.clock.now();
								const taskId = run?.taskId ?? (run as { task_id?: string | null })?.task_id ?? null;

								const executeZeroOutputInTx = () => {
									const currentRun = deps.runsRepo?.findById(runId);
									if (!currentRun || isTerminalRunState(currentRun.state)) {
										return;
									}

									let state = currentRun.state;
									if (state !== 'exited') {
										assertValidTransition(state, 'exited', { reason: 'exited_before_output' });
										deps.runsRepo?.updateState({
											id: runId,
											fromState: state,
											toState: 'exited',
											queuedReason: 'exited_before_output',
											endedAt: now,
											exitCode: result.exitCode,
											exitSignal: result.signal ? String(result.signal) : null,
										});
										if (deps.envelopeFactory) {
											pendingEnvelopes.push(
												deps.envelopeFactory.createEnvelope({
													kind: 'run.state_changed',
													runId,
													taskId,
													actorDeviceId: run?.actorDeviceId ?? null,
													payload: {
														from: state,
														to: 'exited',
														reason: 'exited_before_output',
													},
												}),
											);
										}
										state = 'exited';
									}

									// 第一跳: exited -> reviewing
									assertValidTransition('exited', 'reviewing', { reason: 'exited_before_output' });
									deps.runsRepo?.updateState({
										id: runId,
										fromState: 'exited',
										toState: 'reviewing',
										queuedReason: 'exited_before_output',
									});
									if (deps.envelopeFactory) {
										pendingEnvelopes.push(
											deps.envelopeFactory.createEnvelope({
												kind: 'run.state_changed',
												runId,
												taskId,
												actorDeviceId: run?.actorDeviceId ?? null,
												payload: {
													from: 'exited',
													to: 'reviewing',
													reason: 'exited_before_output',
												},
											}),
										);
									}

									// 第二跳: reviewing -> awaiting_human
									assertValidTransition('reviewing', 'awaiting_human', {
										reason: 'exited_before_output',
									});
									deps.runsRepo?.updateState({
										id: runId,
										fromState: 'reviewing',
										toState: 'awaiting_human',
										queuedReason: 'exited_before_output',
										endedAt: now,
									});
									if (deps.envelopeFactory) {
										pendingEnvelopes.push(
											deps.envelopeFactory.createEnvelope({
												kind: 'run.state_changed',
												runId,
												taskId,
												actorDeviceId: run?.actorDeviceId ?? null,
												payload: {
													from: 'reviewing',
													to: 'awaiting_human',
													reason: 'exited_before_output',
												},
											}),
										);
									}

									// 释放泳道
									if (deps.tasksRepo && taskId) {
										const laneRes = deps.tasksRepo.clearLaneNo(taskId);
										if (laneRes && laneRes.changes === 1 && deps.envelopeFactory) {
											pendingEnvelopes.push(
												deps.envelopeFactory.createEnvelope({
													kind: 'lane.released',
													taskId,
													runId,
													actorDeviceId: run?.actorDeviceId ?? null,
													payload: {
														docId: laneRes.docId,
														laneNo: laneRes.previousLaneNo,
														taskId,
														runId,
														reason: 'awaiting_human',
													},
												}),
											);
										}
									}

									// 创建闸门
									if (deps.gatesRepo) {
										const gateId = deps.ids
											? `gate_${deps.ids.newId()}`
											: `gate_${runId.slice(0, 12)}`;
										deps.gatesRepo.create({
											id: gateId,
											task_id: taskId,
											run_id: runId,
											kind: 'review',
											state: 'waiting',
											comment: 'exited_before_output',
											created_at: now,
										});
									}
								};

								if (deps.unitOfWork) {
									deps.unitOfWork.run(executeZeroOutputInTx);
								} else {
									executeZeroOutputInTx();
								}

								// 事务外：落盘与事件总线发布
								for (const event of pendingEnvelopes) {
									const appendResult = await deps.logstore.appendEvent(runId, event);
									if (deps.bus) {
										const locationRef = appendResult?.location
											? {
													fileSeq: appendResult.location.fileSeq,
													byteOffset: appendResult.location.byteOffset,
													byteLen: appendResult.location.byteLen,
												}
											: undefined;
										deps.bus.publish(event, locationRef);
									}
								}

								const exitedEnvelope = deps.envelopeFactory.createEnvelope({
									kind: 'run.exited',
									runId,
									taskId,
									actorDeviceId: run?.actorDeviceId ?? null,
									payload: {
										exitCode: result.exitCode,
										signal: result.signal ? String(result.signal) : null,
										stderrTail: eventStderrTail,
									},
								});
								await ingestEvent(runId, exitedEnvelope);
								await closeRunStream(runId);

								// 事务后复探登录态（dsh 不探）
								const agentId = run?.agent_id ?? run?.agentId;
								if (agentId && agentId !== 'dsh' && deps.agentService) {
									try {
										await deps.agentService.refreshLogin(agentId, {
											force: true,
											trigger: 'exited_before_output',
										});
									} catch (err) {
										logFailure(err);
									}
								}

								// 不跑机械检查、不派审查、不增加 rework_count
								return;
							}

							if (run?.kind === 'review') {
								// E-62: 审查 agent 零产出退出走审查未完成转人
								if (run && !isTerminalRunState(run.state) && run.state !== 'exited') {
									await transitionState({
										runId,
										targetState: 'exited',
										reason: RUN_TRANSITION_REASONS.PROCESS_EXITED,
										exitCode: result.exitCode,
										exitSignal: result.signal ? String(result.signal) : null,
									});
								}
								const exitedEnvelope = deps.envelopeFactory.createEnvelope({
									kind: 'run.exited',
									runId,
									taskId: run?.taskId ?? null,
									actorDeviceId: run?.actorDeviceId ?? null,
									payload: {
										exitCode: result.exitCode,
										signal: result.signal ? String(result.signal) : null,
										stderrTail: eventStderrTail,
									},
								});
								await ingestEvent(runId, exitedEnvelope);
								await closeRunStream(runId);
								if (deps.finalizeReview) {
									await deps.finalizeReview({ runId, exitCode: result.exitCode });
								}
								return;
							}

							if (run?.kind === 'wrapup') {
								// E-295: 收口运行零产出退出
								if (run && !isTerminalRunState(run.state) && run.state !== 'exited') {
									await transitionState({
										runId,
										targetState: 'exited',
										reason: RUN_TRANSITION_REASONS.PROCESS_EXITED,
										exitCode: result.exitCode,
										exitSignal: result.signal ? String(result.signal) : null,
									});
								}
								const exitedEnvelope = deps.envelopeFactory.createEnvelope({
									kind: 'run.exited',
									runId,
									taskId: run?.taskId ?? null,
									actorDeviceId: run?.actorDeviceId ?? null,
									payload: {
										exitCode: result.exitCode,
										signal: result.signal ? String(result.signal) : null,
										stderrTail: eventStderrTail,
									},
								});
								await ingestEvent(runId, exitedEnvelope);
								await closeRunStream(runId);
								if (deps.finalizeWrapup) {
									await deps.finalizeWrapup({ runId, exitCode: result.exitCode });
								}
								return;
							}
						}

						// 3. 内容后退出才走既有机械检查/失败路径 (R3)
						if (run && !isTerminalRunState(run.state) && run.state !== 'exited') {
							await transitionState({
								runId,
								targetState: 'exited',
								reason: RUN_TRANSITION_REASONS.PROCESS_EXITED,
								exitCode: result.exitCode,
								exitSignal: result.signal ? String(result.signal) : null,
							});
						}
						const exitedEnvelope = deps.envelopeFactory.createEnvelope({
							kind: 'run.exited',
							runId,
							taskId: run?.taskId ?? null,
							actorDeviceId: run?.actorDeviceId ?? null,
							payload: {
								exitCode: result.exitCode,
								signal: result.signal ? String(result.signal) : null,
								stderrTail: eventStderrTail,
							},
						});
						await ingestEvent(runId, exitedEnvelope);
						await closeRunStream(runId);
						if (run?.kind === 'wrapup' && deps.finalizeWrapup) {
							await deps.finalizeWrapup({ runId, exitCode: result.exitCode });
						}
						if (run?.kind === 'review' && deps.finalizeReview) {
							await deps.finalizeReview({ runId, exitCode: result.exitCode });
						}

						const isImplementLike =
							run?.kind === 'implement' ||
							run?.origin === 'rework' ||
							run?.origin === 'wrapup-fix' ||
							(!run?.kind && Boolean(run?.taskId));

						let evaluatedInOnExit = false;
						if (options?.onExit) {
							await options.onExit(result);
							evaluatedInOnExit = true;
						}

						if (
							!evaluatedInOnExit &&
							isImplementLike &&
							result.exitCode === 0 &&
							deps.evaluateMechanicalCheck
						) {
							await deps.evaluateMechanicalCheck({ runId, exitCode: result.exitCode });
						}
					} catch (err) {
						logFailure(err);
					} finally {
						completionResolve(result);
					}
				})();
			}),
		);

		return {
			runId,
			detach() {
				if (detached) return;
				detached = true;
				for (const cleanup of cleanups) {
					cleanup();
				}
				cleanups.length = 0;
			},
			waitForCompletion() {
				return completionPromise;
			},
		};
	}

	async function transitionState(input: {
		readonly runId: string;
		readonly targetState: RunState;
		readonly reason: string;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly endedAt?: string | null;
		readonly actorDeviceId?: string | null;
		readonly pid?: number | null;
		readonly worktreePath?: string | null;
		readonly branchName?: string | null;
	}): Promise<{ readonly previousState: RunState; readonly currentState: RunState }> {
		const { runId, targetState, reason, exitCode, exitSignal, actorDeviceId } = input;
		const run = deps.runsRepo?.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}

		const previousState = run.state;
		assertValidTransition(previousState, targetState, { reason });

		const taskId = run.taskId ?? (run as { task_id?: string | null }).task_id;
		const now = getNow();
		const endedAt =
			isTerminalRunState(targetState) || targetState === 'exited' ? (input.endedAt ?? now) : null;

		const stateChangedEnvelope = deps.envelopeFactory.createEnvelope({
			kind: 'run.state_changed',
			runId,
			taskId: taskId ?? null,
			actorDeviceId: actorDeviceId ?? null,
			payload: {
				from: previousState,
				to: targetState,
				reason,
			},
		});

		// 事务回调内部严格禁止 await 与异步副作用；事件发布在事务返回后进行 (AC 3)
		const pendingEvents: EventEnvelope[] = [];
		let archiveContext: ArchiveTaskContext | null = null;
		const isTerminal =
			targetState === 'landed' ||
			targetState === 'failed' ||
			targetState === 'aborted' ||
			targetState === 'interrupted';
		const isImplement = !run.kind || run.kind === 'implement';

		const executeTransitionInTx = () => {
			if (deps.runsRepo) {
				deps.runsRepo.updateState({
					id: runId,
					fromState: previousState,
					toState: targetState,
					queuedReason: reason ?? null,
					endedAt,
					exitCode:
						exitCode !== undefined
							? exitCode
							: ((run as { exitCode?: number | null; exit_code?: number | null }).exitCode ??
								(run as { exitCode?: number | null; exit_code?: number | null }).exit_code ??
								null),
					exitSignal:
						exitSignal !== undefined
							? exitSignal
							: ((run as { exitSignal?: string | null; exit_signal?: string | null }).exitSignal ??
								(run as { exitSignal?: string | null; exit_signal?: string | null }).exit_signal ??
								null),
					actorDeviceId: actorDeviceId ?? null,
					pid: input.pid ?? null,
					worktreePath: input.worktreePath ?? null,
					branchName: input.branchName ?? null,
				});
			}
			pendingEvents.push(stateChangedEnvelope);

			// AC 1 & E-302: 归档只有一个触发点：kind='implement' 行迁到 landed/failed/aborted/interrupted
			if (isImplement && isTerminal && deps.sessionArchiveService && taskId) {
				archiveContext = deps.sessionArchiveService.archiveTaskInTx({
					taskId,
					runId,
					actorDeviceId,
					now,
				});
				// R1(b): 收集 lane.released（只在 changes===1 时，E-326 防止人放行后重发）
				if (archiveContext.laneReleased) {
					const laneReason = targetState as 'landed' | 'failed' | 'aborted' | 'interrupted';
					pendingEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'lane.released',
							taskId,
							runId,
							actorDeviceId: actorDeviceId ?? null,
							payload: {
								docId: archiveContext.docId,
								laneNo: archiveContext.laneNo,
								taskId,
								runId,
								reason: laneReason,
							},
						}),
					);
				}
			} else if ((targetState === 'awaiting_human' || targetState === 'orphaned') && taskId) {
				// AC 3 & E-326: awaiting_human 只置 tasks.lane_no NULL、不归档
				const laneResult = deps.tasksRepo?.clearLaneNo(taskId);
				// R1(c): 收集 lane.released（changes===1 时）
				if (laneResult && laneResult.changes === 1) {
					pendingEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'lane.released',
							taskId,
							runId,
							actorDeviceId: actorDeviceId ?? null,
							payload: {
								docId: laneResult.docId,
								laneNo: laneResult.previousLaneNo,
								taskId,
								runId,
								reason: 'awaiting_human',
							},
						}),
					);
				}
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(executeTransitionInTx);
		} else {
			executeTransitionInTx();
		}

		// 事务已成功返回，执行落盘与事件总线发布 (AC 3)
		for (const event of pendingEvents) {
			const appendResult = await deps.logstore.appendEvent(runId, event);
			if (deps.bus) {
				const locationRef = appendResult?.location
					? {
							fileSeq: appendResult.location.fileSeq,
							byteOffset: appendResult.location.byteOffset,
							byteLen: appendResult.location.byteLen,
						}
					: undefined;
				deps.bus.publish(event, locationRef);
			}
		}

		// 运行退出或进入终态时，临时权限提升失效 (E-133)
		if (targetState === 'exited' || isTerminal) {
			temporarilyElevatedRuns.delete(runId);
		}

		// AC 2 & E-322: 事务后终止残留进程并发布 task.sessions_archived
		if (archiveContext && deps.sessionArchiveService) {
			await deps.sessionArchiveService.terminateArchived(archiveContext);
		}

		return {
			previousState,
			currentState: targetState,
		};
	}

	async function closeRunStream(runId: string): Promise<void> {
		if (!runId || typeof runId !== 'string') return;
		temporarilyElevatedRuns.delete(runId);
		runsWithContent.delete(runId);
		if (deps.logstore?.closeWriter) {
			await deps.logstore.closeWriter(runId);
		}
	}

	async function findInFlightRuns(): Promise<readonly ReconcileRunRecord[]> {
		if (deps.runsRepo) {
			const runs = deps.runsRepo.findInFlight();
			return runs.map((r) => ({
				id: r.id,
				taskId: r.taskId ?? '',
				pid: r.pid,
				state: r.state,
				agentId: r.agentId ?? r.agent_id ?? 'unknown',
				startedAt: r.startedAt ?? r.started_at ?? null,
				lastEventAt: r.lastEventAt ?? null,
			}));
		}
		return [];
	}

	async function publishStalledSuspected(eventInput: {
		readonly kind: 'run.stalled_suspected';
		readonly runId: string;
		readonly taskId: string;
		readonly actorDeviceId?: string | null;
		readonly payload: unknown;
	}): Promise<void> {
		if (deps.envelopeFactory && deps.bus) {
			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'run.stalled_suspected',
				runId: eventInput.runId,
				taskId: eventInput.taskId,
				actorDeviceId: eventInput.actorDeviceId ?? null,
				payload: eventInput.payload as never,
			});
			deps.bus.publish(envelope);
		}
	}

	async function markInterrupted(
		runId: string,
		details: {
			readonly reason: string;
			readonly endedAt: string;
			readonly actorDeviceId: null;
		},
	): Promise<void> {
		await transitionState({
			runId,
			targetState: 'interrupted',
			reason: details.reason,
			endedAt: details.endedAt,
			actorDeviceId: details.actorDeviceId,
		});
	}

	async function markOrphaned(
		runId: string,
		details: {
			readonly reason: string;
			readonly actorDeviceId: null;
		},
	): Promise<void> {
		await transitionState({
			runId,
			targetState: 'orphaned',
			reason: details.reason,
			actorDeviceId: details.actorDeviceId,
		});
	}

	async function handleEventStateWiring(
		runId: string,
		envelope: EventEnvelopeInput,
	): Promise<void> {
		if (!deps.runsRepo || envelope.kind === 'run.state_changed' || envelope.kind === 'run.started')
			return;

		let currentRun = deps.runsRepo.findById(runId);
		if (!currentRun) return;

		// 收到第一条可解析事件，starting -> running (09节状态机与生命周期规范)
		if (currentRun.state === 'starting') {
			await transitionState({
				runId,
				targetState: 'running',
				reason: 'first_event_received',
			});
			currentRun = deps.runsRepo.findById(runId);
			if (!currentRun) return;
		}

		if (currentRun.state === 'running') {
			const payload = envelope.payload as Record<string, unknown> | undefined;
			const isBlocked = envelope.kind === 'run.permission_blocked';
			const isQuestion = Boolean(
				payload?.requiresReply === true ||
					payload?.requires_reply === true ||
					payload?.isQuestion === true ||
					payload?.is_question === true ||
					payload?.requiresHumanInput === true,
			);

			// E-115: 自动模式下 agent 提问一律不代答，转「等待人回话」并计入停滞检测，继续占用该 agent 并发额度
			// E-133: 沙箱拦下越界写入记「权限受阻」，不判失败
			// E-134: agent 联网装依赖由适配器归一化为 run.permission_blocked 并转回话通路由人决策
			if (isBlocked || isQuestion) {
				await transitionState({
					runId,
					targetState: 'awaiting_reply',
					reason: RUN_TRANSITION_REASONS.AGENT_QUESTION,
				});
			}
		}
	}

	async function markAwaitingReply(
		runId: string,
		details?: {
			readonly reason?: string;
			readonly actorDeviceId?: string | null;
		},
	): Promise<void> {
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string');
		}
		const run = deps.runsRepo?.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}
		if (run.state === 'awaiting_reply') {
			return; // Idempotent: already awaiting reply
		}
		const reason = details?.reason ?? RUN_TRANSITION_REASONS.AGENT_QUESTION;
		if (run.state === 'starting') {
			await transitionState({
				runId,
				targetState: 'running',
				reason: 'first_event_received',
				actorDeviceId: details?.actorDeviceId ?? null,
			});
		}
		await transitionState({
			runId,
			targetState: 'awaiting_reply',
			reason,
			actorDeviceId: details?.actorDeviceId ?? null,
		});
	}

	async function elevateRunOnce(
		runId: string,
		details?: {
			readonly reason?: string;
			readonly actorDeviceId?: string | null;
		},
	): Promise<void> {
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string');
		}
		const run = deps.runsRepo?.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}
		if (run.state !== 'awaiting_reply' && run.state !== 'running') {
			assertValidTransition(run.state, 'running', {
				reason: details?.reason ?? RUN_TRANSITION_REASONS.HUMAN_REPLIED,
			});
		}
		// 仅本次运行临时提升，绝不改写默认档位（不落库、结束失效、事件留痕）(E-133)
		temporarilyElevatedRuns.add(runId);
		if (run.state === 'awaiting_reply') {
			const reason = details?.reason ?? RUN_TRANSITION_REASONS.HUMAN_REPLIED;
			try {
				await transitionState({
					runId,
					targetState: 'running',
					reason,
					actorDeviceId: details?.actorDeviceId ?? null,
				});
			} catch (err) {
				temporarilyElevatedRuns.delete(runId);
				throw err;
			}
		}
	}

	async function isAwaitingReply(runId: string): Promise<boolean> {
		if (!runId || typeof runId !== 'string') return false;
		const run = deps.runsRepo?.findById(runId);
		return run?.state === 'awaiting_reply';
	}

	function isTemporarilyElevated(runId: string): boolean {
		return temporarilyElevatedRuns.has(runId);
	}

	function clearTemporaryElevation(runId: string): void {
		temporarilyElevatedRuns.delete(runId);
	}

	return Object.freeze({
		ingestRaw,
		ingestEvent,
		ingestLine,
		attachProcess,
		transitionState,
		closeRunStream,
		findInFlightRuns,
		publishStalledSuspected,
		markInterrupted,
		markOrphaned,
		markAwaitingReply,
		elevateRunOnce,
		isAwaitingReply,
		isTemporarilyElevated,
		clearTemporaryElevation,
		hasContentProduced(runId: string): boolean {
			return runsWithContent.has(runId);
		},
		getLatestStderrTail(runId: string): readonly string[] | null {
			return latestExitedTails.get(runId) ?? null;
		},
	});
}
