import { EVENT_DEFINITIONS, type EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { UnitOfWork } from '../db/unit-of-work.ts';
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

export interface RunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: RunState;
	readonly pid: number | null;
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
		readonly endedAt?: string | null;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly actorDeviceId?: string | null;
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
}

export interface IngestLineResult {
	readonly rawAppended: boolean;
	readonly rawLocation?: AppendResult;
	readonly eventsAppended: number;
	readonly unmappedDiscarded: boolean;
}

export interface AttachProcessOptions {
	readonly onEvent?: (envelope: EventEnvelope) => void;
	readonly onExit?: (result: ProcessExitResult) => void;
	readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
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
	readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
	readonly logFailure?: (error: unknown) => void;
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
	}): Promise<{ readonly previousState: RunState; readonly currentState: RunState }>;
	closeRunStream(runId: string): Promise<void>;
	findInFlightRuns(): Promise<readonly ReconcileRunRecord[]>;
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
		if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string');
		}

		// 1. 落盘：全量原文写入 events.ndjson；里程碑写入 events 索引表，*_chunk 不进索引表 (AC 1, AC 2)
		const appendResult = await deps.logstore.appendEvent(runId, envelope);

		// 2. 更新运行元数据中的 last_event_at (若提供了仓储)
		if (deps.runsRepo) {
			if (deps.unitOfWork) {
				deps.unitOfWork.run(() => {
					deps.runsRepo?.updateLastEventAt(runId, envelope.ts);
				});
			} else {
				deps.runsRepo.updateLastEventAt(runId, envelope.ts);
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
			deps.bus.publish(envelope, locationRef);
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
		},
	): Promise<IngestLineResult> {
		// 1. 每条原始输出行写一行 raw.log (AC 1)
		const rawLocation = await ingestRaw(runId, line);

		const rawText = typeof line === 'string' ? line : Buffer.from(line).toString('utf8');
		const trimmed = rawText.trim();

		// 非 JSON 格式直接归入 raw.log 并继续，绝不中断流 (E-140)
		if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
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
		const cleanups: Array<() => void> = [];

		cleanups.push(
			process.onRaw((line) => {
				if (detached) return;
				void ingestRaw(runId, line.text).catch((err) => logFailure(err));
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
							void ingestEvent(runId, env)
								.then(() => {
									options?.onEvent?.(env);
								})
								.catch((err) => logFailure(err));
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
					void ingestEvent(runId, env)
						.then(() => {
							options?.onEvent?.(env);
						})
						.catch((err) => logFailure(err));
				}
			}),
		);

		let completionResolve: (result: ProcessExitResult | undefined) => void;
		const completionPromise = new Promise<ProcessExitResult | undefined>((resolve) => {
			completionResolve = resolve;
		});

		cleanups.push(
			process.onExit((result) => {
				if (detached) {
					completionResolve(result);
					return;
				}
				options?.onExit?.(result);

				void (async () => {
					try {
						const run = deps.runsRepo?.findById(runId);
						if (run && !isTerminalRunState(run.state) && run.state !== 'exited') {
							await transitionState({
								runId,
								targetState: 'exited',
								reason: RUN_TRANSITION_REASONS.PROCESS_EXITED,
								exitCode: result.exitCode,
								exitSignal: result.signal ? String(result.signal) : null,
							});
						}
					} catch (err) {
						logFailure(err);
					} finally {
						await closeRunStream(runId).catch((err) => logFailure(err));
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

		const now = getNow();
		const endedAt =
			isTerminalRunState(targetState) || targetState === 'exited' ? (input.endedAt ?? now) : null;

		const stateChangedEnvelope = deps.envelopeFactory.createEnvelope({
			kind: 'run.state_changed',
			runId,
			taskId: run.taskId,
			actorDeviceId: actorDeviceId ?? null,
			payload: {
				from: previousState,
				to: targetState,
				reason,
			},
		});

		// 事务回调内部严格禁止 await 与异步副作用；事件发布在事务返回后进行 (AC 3)
		const pendingEvents: EventEnvelope[] = [];
		if (deps.runsRepo) {
			const repo = deps.runsRepo;
			if (deps.unitOfWork) {
				deps.unitOfWork.run(() => {
					repo.updateState({
						id: runId,
						fromState: previousState,
						toState: targetState,
						endedAt,
						exitCode: exitCode ?? null,
						exitSignal: exitSignal ?? null,
						actorDeviceId: actorDeviceId ?? null,
					});
					pendingEvents.push(stateChangedEnvelope);
				});
			} else {
				repo.updateState({
					id: runId,
					fromState: previousState,
					toState: targetState,
					endedAt,
					exitCode: exitCode ?? null,
					exitSignal: exitSignal ?? null,
					actorDeviceId: actorDeviceId ?? null,
				});
				pendingEvents.push(stateChangedEnvelope);
			}
		} else {
			pendingEvents.push(stateChangedEnvelope);
		}

		// 事务已成功返回，执行落盘与事件总线发布 (AC 3)
		for (const event of pendingEvents) {
			const appendResult = await deps.logstore.appendEvent(runId, event);
			if (deps.bus) {
				const locationRef = {
					fileSeq: appendResult.location.fileSeq,
					byteOffset: appendResult.location.byteOffset,
					byteLen: appendResult.location.byteLen,
				};
				deps.bus.publish(event, locationRef);
			}
		}

		return {
			previousState,
			currentState: targetState,
		};
	}

	async function closeRunStream(runId: string): Promise<void> {
		if (!runId || typeof runId !== 'string') return;
		await deps.logstore.closeWriter(runId);
	}

	async function findInFlightRuns(): Promise<readonly ReconcileRunRecord[]> {
		if (deps.runsRepo) {
			const runs = deps.runsRepo.findInFlight();
			return runs.map((r) => ({
				id: r.id,
				taskId: r.taskId,
				pid: r.pid,
				state: r.state,
			}));
		}
		return [];
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

	return Object.freeze({
		ingestRaw,
		ingestEvent,
		ingestLine,
		attachProcess,
		transitionState,
		closeRunStream,
		findInFlightRuns,
		markInterrupted,
		markOrphaned,
	});
}
