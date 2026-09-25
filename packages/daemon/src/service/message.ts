import { EVENT_DEFINITIONS, type EventEnvelope } from '@agent-scheduler/shared/api/events';
import { getClaudeCapabilities } from '../adapters/claude/capabilities.ts';
import { getCodexCapabilities } from '../adapters/codex/capabilities.ts';
import { getGrokCapabilities } from '../adapters/grok/capabilities.ts';
import { getPiCapabilities } from '../adapters/pi/capabilities.ts';
import { type AdapterKind, BUILT_IN_AGENT_IDS } from '../config/defaults.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { RUN_TRANSITION_REASONS, isTerminalRunState } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type {
	MessageKind,
	MessageRunRecord,
	RunMessageRecord,
	RunMessagesRepo,
} from '../repo/run-messages-repo.ts';

export type { MessageKind, MessageRunRecord, RunMessageRecord } from '../repo/run-messages-repo.ts';

/**
 * E-330 的内容类事件：agent 已经开始产出（撑住）的标志。
 * 名字从 shared 的 EVENT_DEFINITIONS 派生，不在服务层写死与厂商 wire 名同形的字面量
 * —— 架构测试 generic-acp-adapter 会扫 service/jobs/http 里的厂商字符串。
 */
const CONTENT_EVENT_KINDS: ReadonlySet<string> = new Set(
	(Object.keys(EVENT_DEFINITIONS) as string[]).filter(
		(kind) => (kind.startsWith('agent_') || kind.startsWith('tool_')) && !kind.endsWith('_update'),
	),
);

/** 未送达（E-113）、进程退出（含 codex 映射器直接产出的 run.exited）归一化成这几个 kind。 */
const FAILURE_EVENT_KINDS: ReadonlySet<string> = new Set(['run.message_undelivered', 'run.exited']);

/**
 * 产品自己的退出信号是 `run.state_changed{to}`（service/run.ts 的 onExit、proc/spawn.ts 的启动超时都走它，
 * 只有 codex 映射器会另发 run.exited）：这些目标态在首条内容事件之前出现同样算「会话不可续」。
 */
const FAILURE_TARGET_STATES: ReadonlySet<string> = new Set([
	'exited',
	'failed',
	'interrupted',
	'orphaned',
]);

/**
 * - `exhausted`：内容前出现未送达 / 退出 / 错误类事件（E-330 撑爆）
 * - `content`：首条内容事件已到（撑住）
 * - `pending`：既无事件也不退出，交给停滞检测（E-120）
 * - `aborted`：人手动中止了这条运行——不是撑爆，调用方不得据此新开会话
 */
export type ContinuationState = 'exhausted' | 'content' | 'pending' | 'aborted';

function classifyContinuationEvent(envelope: {
	readonly kind: unknown;
	readonly payload?: unknown;
}): ContinuationState | null {
	const kind = String(envelope.kind);
	if (CONTENT_EVENT_KINDS.has(kind)) return 'content';
	if (FAILURE_EVENT_KINDS.has(kind)) return 'exhausted';
	if (kind === 'run.aborted') return 'aborted';
	if (kind === 'run.state_changed') {
		const target = (envelope.payload as { to?: unknown } | undefined)?.to;
		if (typeof target !== 'string') return null;
		if (target === 'aborted') return 'aborted';
		if (FAILURE_TARGET_STATES.has(target)) return 'exhausted';
	}
	return null;
}

/**
 * E-330：等该轮的首条内容事件（撑住）或内容前的失败事件（撑爆）。
 * 投递成功但既无事件也不退出 → 返回 'pending'，交给停滞检测（E-120），不算撑爆。
 */
export function waitForContinuationState(
	bus: EventBus,
	runId: string,
	timeoutMs = 60_000,
): Promise<ContinuationState> {
	return new Promise((resolve) => {
		const ctx: { done: boolean; unsubscribe?: () => void } = { done: false };

		function settle(value: ContinuationState) {
			if (ctx.done) {
				return;
			}
			ctx.done = true;
			clearTimeout(timer);
			ctx.unsubscribe?.();
			resolve(value);
		}

		const timer = setTimeout(() => {
			settle('pending');
		}, timeoutMs);

		ctx.unsubscribe = bus.subscribeWithFilter(
			(envelope) => envelope.runId === runId,
			(envelope) => {
				// 只读归一化事件的种类与目标状态，厂商错误串一概不看（E-330）。
				const state = classifyContinuationEvent(envelope);
				if (state !== null) {
					settle(state);
				}
			},
		);
	});
}

export const DEFAULT_MAX_MESSAGE_LENGTH = 32_768;

export interface AgentMessageCapabilities {
	readonly canReply: boolean;
	readonly canResume: boolean;
}

export interface SendMessageInput {
	readonly runId: string;
	readonly text?: string;
	readonly kind: MessageKind;
	readonly actorDeviceId?: string | null;
	readonly throwOnUndelivered?: boolean;
	readonly elevateRunOnce?: (
		runId: string,
		details?: { readonly reason?: string; readonly actorDeviceId?: string | null },
	) => Promise<void>;
}

export interface DeliverMessageResult {
	readonly delivered: boolean;
	readonly messageId: string;
	readonly text?: string;
	readonly deliveryState: 'delivered' | 'undelivered';
	readonly undeliveredReason?: string;
	readonly runId: string;
	readonly isNewRun?: boolean;
	readonly newRunId?: string;
	readonly code?: 'E_MESSAGE_UNDELIVERED' | 'E_CAPABILITY_UNSUPPORTED';
}

export interface ResumeSessionInput {
	readonly runId: string;
	readonly taskId: string;
	readonly agentId: string;
	readonly text: string;
	readonly kind: MessageKind;
	readonly actorDeviceId?: string | null;
}

export interface ResumeSessionResult {
	readonly newRunId: string;
	readonly messageId: string;
	readonly delivered: boolean;
}

export interface MessageServiceDeps {
	readonly runMessagesRepo: RunMessagesRepo;
	readonly processRegistry: ProcessRegistry;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly unitOfWork?: UnitOfWork;
	readonly getAgentCapabilities?: (
		agentId: string,
		adapterKind?: AdapterKind,
	) => AgentMessageCapabilities;
	readonly resumeSession?: (input: ResumeSessionInput) => Promise<ResumeSessionResult>;
	readonly maxMessageLength?: number;
	readonly elevateRunOnce?: (
		runId: string,
		details?: { readonly reason?: string; readonly actorDeviceId?: string | null },
	) => Promise<void>;
	readonly runService?: {
		elevateRunOnce(
			runId: string,
			details?: { readonly reason?: string; readonly actorDeviceId?: string | null },
		): Promise<void>;
		isTemporarilyElevated(runId: string): boolean;
	};
}

export interface MessageService {
	sendMessage(input: SendMessageInput): Promise<DeliverMessageResult>;
	deliverMessage(input: SendMessageInput): Promise<DeliverMessageResult>;
	canReply(runId: string): Promise<boolean>;
	getCapabilities(agentId: string, adapterKind?: AdapterKind): AgentMessageCapabilities;
	getMessage(messageId: string): Promise<RunMessageRecord | null>;
	getRunMessages(runId: string): Promise<readonly RunMessageRecord[]>;
	getUndeliveredMessages(runId: string): Promise<readonly RunMessageRecord[]>;
}

/**
 * Resolves capability bits for a given agent and adapterKind.
 * Primary check: canReply (E-117) and canResume (E-112).
 */
export function resolveAgentMessageCapabilities(
	agentId: string,
	adapterKind: AdapterKind = 'native',
): AgentMessageCapabilities {
	if (adapterKind === 'generic-acp') {
		return Object.freeze({
			canReply: false,
			canResume: false,
		});
	}

	switch (agentId) {
		case BUILT_IN_AGENT_IDS.CODEX: {
			const codexCaps = getCodexCapabilities(adapterKind);
			return Object.freeze({
				canReply: codexCaps.canReply,
				canResume: codexCaps.canResume,
			});
		}
		case BUILT_IN_AGENT_IDS.CLAUDE: {
			const claudeCaps = getClaudeCapabilities();
			return Object.freeze({
				canReply: claudeCaps.canReply,
				canResume: false,
			});
		}
		case BUILT_IN_AGENT_IDS.PI: {
			const piCaps = getPiCapabilities();
			return Object.freeze({
				canReply: piCaps.canReply,
				canResume: false,
			});
		}
		case BUILT_IN_AGENT_IDS.GROK: {
			const grokCaps = getGrokCapabilities();
			return Object.freeze({
				canReply: grokCaps.canReply,
				canResume: grokCaps.canResume,
			});
		}
		case BUILT_IN_AGENT_IDS.DSH:
			return Object.freeze({
				canReply: false,
				canResume: false,
			});
		default:
			return Object.freeze({
				canReply: false,
				canResume: false,
			});
	}
}

/**
 * Creates the MessageService for run message delivery and capability constraints (M6-T6).
 *
 * Rules:
 * 1. AC 1: 'canReply' is modeled as a capability bit; returns E_CAPABILITY_UNSUPPORTED when unsupported (E-117).
 * 2. AC 2: When process is dead or pipe is broken, message is recorded as 'undelivered' with original text
 *    preserved verbatim for copying, publishes run.message_undelivered, and raises E_MESSAGE_UNDELIVERED (E-113).
 * 3. AC 3: If session ended and canResume=true, routes through resume and clearly flags a new run (E-112);
 *    if canResume=false, disables sending and instructs user to redispatch/rerun. When no resume handler
 *    is wired, the message is recorded undelivered rather than reported as sent.
 * 4. AC 4: Concurrent messages are queued and delivered serially per runId; each records actorDeviceId and
 *    timestamp without deduplication or merging (E-114).
 * 5. AC 5: Empty messages rejected; overlong messages prompt for confirmation before sending and are NEVER
 *    silently truncated (E-116).
 * 6. AC 6: Writes to stdin check write() return value and await drain on backpressure before completing.
 */
export function createMessageService(deps: MessageServiceDeps): MessageService {
	const maxMessageLength = deps.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;
	const runQueues = new Map<string, Promise<unknown>>();

	function resolveCaps(agentId: string, adapterKind?: AdapterKind): AgentMessageCapabilities {
		if (deps.getAgentCapabilities) {
			return deps.getAgentCapabilities(agentId, adapterKind);
		}
		return resolveAgentMessageCapabilities(agentId, adapterKind);
	}

	/**
	 * Serializes delivery per runId to ensure FIFO arrival order (AC 4 / E-114).
	 */
	function enqueueForRun<T>(runId: string, task: () => Promise<T>): Promise<T> {
		const currentQueue = runQueues.get(runId) ?? Promise.resolve();
		const nextPromise = currentQueue.then(task);

		const queueTail = nextPromise
			.catch(() => {
				// Absorb errors in the queue chain so subsequent tasks can run
			})
			.finally(() => {
				if (runQueues.get(runId) === queueTail) {
					runQueues.delete(runId);
				}
			});

		runQueues.set(runId, queueTail);

		return nextPromise;
	}

	function validateInput(input: SendMessageInput): void {
		if (!input.runId || typeof input.runId !== 'string' || input.runId.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Run ID must be a non-empty string.', {
				details: { field: 'runId' },
			});
		}

		if (input.kind !== 'elevate_once') {
			if (typeof input.text !== 'string' || input.text.trim().length === 0) {
				throw new AppError('E_VALIDATION', 'Message text cannot be empty or whitespace only.', {
					details: {
						field: 'text',
						code: 'EMPTY_MESSAGE',
					},
				});
			}
		}

		if (input.text && input.text.length > maxMessageLength) {
			throw new AppError(
				'E_VALIDATION',
				`Message text length (${input.text.length}) exceeds the maximum allowed limit (${maxMessageLength}). Please confirm truncation point before sending.`,
				{
					details: {
						field: 'text',
						length: input.text.length,
						maxLength: maxMessageLength,
						requiresTruncationConfirmation: true,
					},
				},
			);
		}

		const validKinds: readonly MessageKind[] = ['reply', 'approve', 'deny', 'elevate_once'];
		if (!validKinds.includes(input.kind)) {
			throw new AppError('E_VALIDATION', `Invalid message kind: '${input.kind}'.`, {
				details: {
					field: 'kind',
					allowedKinds: validKinds,
				},
			});
		}
	}

	async function performDelivery(
		input: SendMessageInput,
		throwOnUndelivered: boolean,
	): Promise<DeliverMessageResult> {
		validateInput(input);

		const run = deps.runMessagesRepo.findRunById(input.runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run '${input.runId}' was not found.`, {
				details: { runId: input.runId },
			});
		}

		// AC 4 & E-302: Message delivery on archived session returns 409 E_SESSION_ARCHIVED
		// session_archived_at 由 run-messages-repo 的行查询随 MessageRunRecord 一起取出
		if (run.sessionArchivedAt) {
			throw new AppError(
				'E_SESSION_ARCHIVED',
				`Session for run '${run.id}' has been archived and is read-only.`,
				{
					details: {
						runId: run.id,
						taskId: run.taskId,
						sessionArchivedAt: run.sessionArchivedAt,
					},
				},
			);
		}

		if (input.kind === 'elevate_once') {
			const elevateFn =
				input.elevateRunOnce ?? deps.elevateRunOnce ?? deps.runService?.elevateRunOnce;
			if (!elevateFn) {
				// R2: 缺 RunService/elevateRunOnce 时不得返回 delivered
				return handleUndelivered(run, input, 'elevate_unavailable', throwOnUndelivered);
			}

			// R2: elevateFn 必须成功执行后才进入交付，失败时不得留下假投递记录
			await elevateFn(input.runId, {
				reason: RUN_TRANSITION_REASONS.HUMAN_REPLIED,
				actorDeviceId: input.actorDeviceId ?? null,
			});

			const messageId = deps.ids.newId();
			const now = deps.clock.now();
			const text = input.text ?? '';
			const pendingEvents: EventEnvelope[] = [];

			const persistOperations = () => {
				deps.runMessagesRepo.insertMessage({
					id: messageId,
					runId: input.runId,
					kind: input.kind,
					text,
					deliveryState: 'delivered',
					undeliveredReason: null,
					actorDeviceId: input.actorDeviceId ?? null,
					createdAt: now,
					deliveredAt: now,
				});

				if (deps.envelopeFactory) {
					pendingEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.message_delivered',
							runId: input.runId,
							taskId: run.taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								messageId,
							},
						}),
					);
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(persistOperations);
			} else {
				persistOperations();
			}

			if (deps.bus) {
				for (const event of pendingEvents) {
					deps.bus.publish(event);
				}
			}

			return {
				delivered: true,
				messageId,
				text,
				deliveryState: 'delivered',
				runId: input.runId,
			};
		}

		const caps = resolveCaps(run.agentId);

		// AC 1 & E-117: Check reply capability bit
		if (!caps.canReply) {
			throw new AppError(
				'E_CAPABILITY_UNSUPPORTED',
				`Agent '${run.agentId}' does not support message injection (canReply is false).`,
				{
					details: {
						agentId: run.agentId,
						capability: 'canReply',
						supported: false,
					},
				},
			);
		}

		const isEnded = isTerminalRunState(run.state) || run.state === 'exited';

		// AC 3 & E-112: Session already ended
		if (isEnded) {
			if (!caps.canResume) {
				throw new AppError(
					'E_CAPABILITY_UNSUPPORTED',
					`Session for run '${run.id}' has ended and agent '${run.agentId}' does not support resume. Please redispatch or rerun instead.`,
					{
						details: {
							runId: run.id,
							agentId: run.agentId,
							canResume: false,
							suggestion: 'redispatch',
						},
					},
				);
			}

			// Agent supports resume/fork: resume session and indicate new run
			if (deps.resumeSession) {
				const resumeResult = await deps.resumeSession({
					runId: run.id,
					taskId: run.taskId,
					agentId: run.agentId,
					text: input.text ?? '',
					kind: input.kind,
					actorDeviceId: input.actorDeviceId ?? null,
				});

				return {
					delivered: resumeResult.delivered,
					messageId: resumeResult.messageId,
					text: input.text ?? '',
					deliveryState: 'delivered',
					runId: run.id,
					isNewRun: true,
					newRunId: resumeResult.newRunId,
				};
			}

			// No resumption handler wired (session resumption is owned by M7-T5): the message
			// never reaches any process, so it is recorded as undelivered instead of being
			// reported as sent. Never fabricate a new run id (AC 2 / E-113).
			return handleUndelivered(run, input, 'resume_unavailable', throwOnUndelivered);
		}

		// AC 2 & E-113: Process liveness & pipe integrity checks
		const managedProcess = deps.processRegistry.get(input.runId);

		let undeliveredReason: string | null = null;
		if (
			!managedProcess ||
			managedProcess.isExited ||
			managedProcess.child.killed ||
			managedProcess.child.exitCode !== null
		) {
			undeliveredReason = 'process_exited';
		} else if (
			managedProcess.child.stdin === null ||
			managedProcess.child.stdin.destroyed ||
			!managedProcess.child.stdin.writable
		) {
			undeliveredReason = 'pipe_broken';
		}

		if (undeliveredReason !== null || !managedProcess) {
			return handleUndelivered(
				run,
				input,
				undeliveredReason ?? 'process_exited',
				throwOnUndelivered,
			);
		}

		// AC 6: Writing to stdin with backpressure drain check
		const text = input.text ?? '';
		const payload = text.endsWith('\n') ? text : `${text}\n`;
		let writeOk = false;

		try {
			writeOk = managedProcess.writeStdin(payload);
		} catch {
			return handleUndelivered(run, input, 'pipe_broken', throwOnUndelivered);
		}

		if (!writeOk) {
			try {
				await managedProcess.waitForStdinDrain();
			} catch {
				return handleUndelivered(run, input, 'pipe_broken', throwOnUndelivered);
			}
		}

		// Delivery succeeded: persist message and transition state
		const messageId = deps.ids.newId();
		const now = deps.clock.now();

		const pendingEvents: EventEnvelope[] = [];

		const persistOperations = () => {
			deps.runMessagesRepo.insertMessage({
				id: messageId,
				runId: input.runId,
				kind: input.kind,
				text,
				deliveryState: 'delivered',
				undeliveredReason: null,
				actorDeviceId: input.actorDeviceId ?? null,
				createdAt: now,
				deliveredAt: now,
			});

			if (run.state === 'awaiting_reply') {
				deps.runMessagesRepo.updateRunState({
					id: input.runId,
					fromState: 'awaiting_reply',
					toState: 'running',
					lastEventAt: now,
				});

				if (deps.envelopeFactory) {
					pendingEvents.push(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: input.runId,
							taskId: run.taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: 'awaiting_reply',
								to: 'running',
								reason: RUN_TRANSITION_REASONS.HUMAN_REPLIED,
							},
						}),
					);
				}
			}

			if (deps.envelopeFactory) {
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.message_delivered',
						runId: input.runId,
						taskId: run.taskId,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							messageId,
						},
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistOperations);
		} else {
			persistOperations();
		}

		// Publish events strictly AFTER transaction completes
		if (deps.bus) {
			for (const ev of pendingEvents) {
				deps.bus.publish(ev);
			}
		}

		return {
			delivered: true,
			messageId,
			text: input.text ?? '',
			deliveryState: 'delivered',
			runId: input.runId,
		};
	}

	function handleUndelivered(
		run: MessageRunRecord,
		input: SendMessageInput,
		reason: string,
		throwOnUndelivered: boolean,
	): DeliverMessageResult {
		const messageId = deps.ids.newId();
		const now = deps.clock.now();

		const pendingEvents: EventEnvelope[] = [];

		const persistOperations = () => {
			deps.runMessagesRepo.insertMessage({
				id: messageId,
				runId: input.runId,
				kind: input.kind,
				text: input.text ?? '', // original text preserved verbatim for copying (E-113)
				deliveryState: 'undelivered',
				undeliveredReason: reason,
				actorDeviceId: input.actorDeviceId ?? null,
				createdAt: now,
				deliveredAt: null,
			});

			if (deps.envelopeFactory) {
				pendingEvents.push(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.message_undelivered',
						runId: input.runId,
						taskId: run.taskId,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							messageId,
							reason,
						},
					}),
				);
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistOperations);
		} else {
			persistOperations();
		}

		if (deps.bus) {
			for (const ev of pendingEvents) {
				deps.bus.publish(ev);
			}
		}

		if (throwOnUndelivered) {
			throw new AppError(
				'E_MESSAGE_UNDELIVERED',
				`Failed to deliver message to run '${input.runId}': process is dead or pipe is broken (${reason}).`,
				{
					details: {
						messageId,
						text: input.text ?? '',
						deliveryState: 'undelivered',
						reason,
						runId: input.runId,
					},
				},
			);
		}

		return {
			delivered: false,
			messageId,
			text: input.text ?? '',
			deliveryState: 'undelivered',
			undeliveredReason: reason,
			runId: input.runId,
			code: 'E_MESSAGE_UNDELIVERED',
		};
	}

	return {
		sendMessage(input: SendMessageInput): Promise<DeliverMessageResult> {
			const throwOnUndelivered = input.throwOnUndelivered !== false;
			return enqueueForRun(input.runId, () => performDelivery(input, throwOnUndelivered));
		},

		deliverMessage(input: SendMessageInput): Promise<DeliverMessageResult> {
			const throwOnUndelivered = input.throwOnUndelivered === true;
			return enqueueForRun(input.runId, () => performDelivery(input, throwOnUndelivered));
		},

		async canReply(runId: string): Promise<boolean> {
			if (!runId || typeof runId !== 'string' || runId.trim().length === 0) {
				return false;
			}

			const run = deps.runMessagesRepo.findRunById(runId);
			if (!run) {
				return false;
			}

			const caps = resolveCaps(run.agentId);
			if (!caps.canReply) {
				return false;
			}

			const isEnded = isTerminalRunState(run.state) || run.state === 'exited';
			if (isEnded) {
				return Boolean(caps.canResume);
			}

			const process = deps.processRegistry.get(runId);
			if (!process || process.isExited) {
				return false;
			}

			if (!process.child.stdin || process.child.stdin.destroyed || !process.child.stdin.writable) {
				return false;
			}

			return true;
		},

		getCapabilities(agentId: string, adapterKind?: AdapterKind): AgentMessageCapabilities {
			return resolveCaps(agentId, adapterKind);
		},

		async getMessage(messageId: string): Promise<RunMessageRecord | null> {
			return deps.runMessagesRepo.findMessageById(messageId);
		},

		async getRunMessages(runId: string): Promise<readonly RunMessageRecord[]> {
			return deps.runMessagesRepo.findMessagesByRunId(runId);
		},

		async getUndeliveredMessages(runId: string): Promise<readonly RunMessageRecord[]> {
			return deps.runMessagesRepo.findUndeliveredByRunId(runId);
		},
	};
}
