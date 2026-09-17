import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { getClaudeCapabilities } from '../adapters/claude/capabilities.ts';
import { getCodexCapabilities } from '../adapters/codex/capabilities.ts';
import { getGrokCapabilities } from '../adapters/grok/capabilities.ts';
import { getPiCapabilities } from '../adapters/pi/capabilities.ts';
import { type AdapterKind, BUILT_IN_AGENT_IDS } from '../config/defaults.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { RUN_TRANSITION_REASONS, isTerminalRunState } from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EventEnvelope } from '../events/envelope.ts';
import type { EventKind } from '@agent-scheduler/shared/api/events';

/**
 * Events considered as "content" emitted by the agent (E-330).
 * If any of these are seen, the session is considered to have started responding.
 */
const CONTENT_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
	('agent' + '_message_chunk') as EventKind,
	('agent' + '_thought_chunk') as EventKind,
	('tool' + '_call') as EventKind,
]);

/**
 * Events considered as "failure" indicating the session blew up before content (E-113, E-190).
 */
const FAILURE_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
	('agent' + '_error') as EventKind,
	('message' + '_undelivered') as EventKind,
	'run.timed_out' as EventKind,
	('process' + '_exit') as EventKind,
]);

export type ContinuationState = 'exhausted' | 'content' | 'pending';

/**
 * Awaits until either a content event or a failure event is observed for the given run,
 * or the process has not yielded anything yet within the timeout.
 */
export function waitForContinuationState(
	bus: EventBus,
	runId: string,
	timeoutMs = 60_000,
): Promise<ContinuationState> {
	return new Promise((resolve) => {
		let timer: NodeJS.Timeout | undefined;

		const unsubscribe = bus.subscribeWithFilter(
			(envelope) => envelope.runId === runId,
			(envelope) => {
				if (CONTENT_EVENT_KINDS.has(envelope.kind)) {
					cleanup();
					resolve('content');
				} else if (FAILURE_EVENT_KINDS.has(envelope.kind)) {
					cleanup();
					resolve('exhausted');
				}
			},
		);

		function cleanup() {
			unsubscribe();
			if (timer) clearTimeout(timer);
		}

		timer = setTimeout(() => {
			cleanup();
			resolve('pending'); // if we timeout before content or failure, we consider it pending
		}, timeoutMs);
	});
}
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

export const DEFAULT_MAX_MESSAGE_LENGTH = 32_768;

export interface AgentMessageCapabilities {
	readonly canReply: boolean;
	readonly canResume: boolean;
}

export interface SendMessageInput {
	readonly runId: string;
	readonly text: string;
	readonly kind: MessageKind;
	readonly actorDeviceId?: string | null;
	readonly throwOnUndelivered?: boolean;
}

export interface DeliverMessageResult {
	readonly delivered: boolean;
	readonly messageId: string;
	readonly text: string;
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

		if (typeof input.text !== 'string' || input.text.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'Message text cannot be empty or whitespace only.', {
				details: {
					field: 'text',
					code: 'EMPTY_MESSAGE',
				},
			});
		}

		if (input.text.length > maxMessageLength) {
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
					text: input.text,
					kind: input.kind,
					actorDeviceId: input.actorDeviceId ?? null,
				});

				return {
					delivered: resumeResult.delivered,
					messageId: resumeResult.messageId,
					text: input.text,
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
		const payload = input.text.endsWith('\n') ? input.text : `${input.text}\n`;
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
				text: input.text,
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
			text: input.text,
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
				text: input.text, // original text preserved verbatim for copying (E-113)
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
						text: input.text,
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
			text: input.text,
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
