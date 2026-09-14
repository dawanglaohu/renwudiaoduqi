import type { ChildProcess } from 'node:child_process';
import type {
	EventEnvelope,
	RunMessageDeliveredPayload,
	RunMessageUndeliveredPayload,
	RunStateChangedPayload,
} from '@agent-scheduler/shared/api/events';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import {
	type MessageRunRecord,
	type RunMessageRecord,
	type RunMessagesRepo,
	createSqliteRunMessagesRepo,
} from '../../src/repo/run-messages-repo.ts';
import {
	type MessageServiceDeps,
	createMessageService,
	resolveAgentMessageCapabilities,
} from '../../src/service/message.ts';

function createMockProcess(options: {
	runId: string;
	isExited?: boolean;
	killed?: boolean;
	exitCode?: number | null;
	stdinWritable?: boolean;
	stdinDestroyed?: boolean;
	writeResult?: boolean;
	onWrite?: (chunk: string | Buffer) => void;
}): ManagedProcess {
	const writes: string[] = [];
	let drainCallback: (() => void) | undefined;

	const stdin =
		options.stdinWritable === false
			? null
			: {
					writable: options.stdinWritable ?? true,
					destroyed: options.stdinDestroyed ?? false,
					writableNeedDrain: false,
					write(chunk: string | Buffer) {
						writes.push(String(chunk));
						options.onWrite?.(chunk);
						return options.writeResult ?? true;
					},
					once(event: string, cb: () => void) {
						if (event === 'drain') {
							drainCallback = cb;
						}
					},
				};

	const child = {
		killed: options.killed ?? false,
		exitCode: options.exitCode ?? null,
		stdin,
	} as unknown as ChildProcess;

	return {
		runId: options.runId,
		pid: 12345,
		file: 'agent',
		args: [],
		cwd: '/tmp',
		child,
		stdoutReader: {
			onLine: () => () => {},
			onRaw: () => () => {},
			close: () => {},
		} as unknown as ManagedProcess['stdoutReader'],
		stderrReader: {
			onLine: () => () => {},
			onRaw: () => () => {},
			close: () => {},
		} as unknown as ManagedProcess['stderrReader'],
		timers: {
			clearAll: () => {},
		} as unknown as ManagedProcess['timers'],
		isExited: options.isExited ?? false,
		stderrTail: '',
		attachAppendQueue: () => () => {},
		waitForStdinDrain: vi.fn(async () => {
			drainCallback?.();
		}),
		onStdinDrain: () => () => {},
		writeStdin(data: string | Buffer): boolean {
			if (child.stdin === null || child.stdin.destroyed) {
				return false;
			}
			return child.stdin.write(data);
		},
		onLine: () => () => {},
		onRaw: () => () => {},
		onStderr: () => () => {},
		onJson: () => () => {},
		onExit: () => () => {},
		onError: () => () => {},
		kill: vi.fn(async () => ({
			outcome: 'terminated' as const,
			attempts: [],
		})),
		finalize: vi.fn(async () => {}),
	};
}

function createMockRunsRepo(initialRuns: readonly MessageRunRecord[] = []) {
	const runs = new Map<string, MessageRunRecord>();
	const messages: RunMessageRecord[] = [];
	const stateUpdates: Array<{
		id: string;
		fromState: string;
		toState: string;
		lastEventAt: string;
	}> = [];

	for (const r of initialRuns) {
		runs.set(r.id, { ...r });
	}

	const repo: RunMessagesRepo = {
		findRunById(id: string) {
			return runs.get(id) ?? null;
		},
		insertMessage(input) {
			messages.push({
				id: input.id,
				runId: input.runId,
				kind: input.kind,
				text: input.text,
				deliveryState: input.deliveryState,
				undeliveredReason: input.undeliveredReason ?? null,
				actorDeviceId: input.actorDeviceId ?? null,
				createdAt: input.createdAt,
				deliveredAt: input.deliveredAt ?? null,
			});
		},
		findMessageById(id: string) {
			return messages.find((m) => m.id === id) ?? null;
		},
		findMessagesByRunId(runId: string) {
			return messages.filter((m) => m.runId === runId);
		},
		findUndeliveredByRunId(runId: string) {
			return messages.filter((m) => m.runId === runId && m.deliveryState === 'undelivered');
		},
		updateRunState(input) {
			stateUpdates.push(input);
			const current = runs.get(input.id);
			if (current) {
				runs.set(input.id, { ...current, state: input.toState });
			}
		},
	};

	return { repo, runs, messages, stateUpdates };
}

function createMockBus() {
	const published: EventEnvelope[] = [];
	const bus = {
		publish(envelope: EventEnvelope) {
			published.push(envelope);
			return envelope.id;
		},
		subscribe() {
			return () => {};
		},
		getHistory() {
			return [];
		},
		hasSubscriber: () => true,
		get subscriberCount() {
			return 1;
		},
	} as unknown as EventBus;

	let idSeq = 100;
	const envelopeFactory = {
		createEnvelope(input: Parameters<EnvelopeFactory['createEnvelope']>[0]) {
			idSeq++;
			return {
				id: idSeq,
				ts: '2026-09-14T10:00:00.000Z',
				seq: 1,
				runId: input.runId ?? 'run-1',
				taskId: input.taskId ?? 'task-1',
				scope: 'run',
				kind: input.kind,
				actorDeviceId: input.actorDeviceId ?? null,
				payload: input.payload ?? {},
			} as unknown as EventEnvelope;
		},
	} as unknown as EnvelopeFactory;

	return { bus, published, envelopeFactory };
}

describe('M6-T6 MessageService: delivery and capability constraints', () => {
	const clock = { now: () => '2026-09-14T10:00:00.000Z' };
	let nextId = 1;
	const ids = { newId: () => `msg-id-${nextId++}` };

	describe('AC 1 & E-117: Reply capability bit check', () => {
		it('resolves built-in agent capabilities correctly', () => {
			expect(resolveAgentMessageCapabilities('codex', 'native').canReply).toBe(true);
			expect(resolveAgentMessageCapabilities('codex', 'generic-acp').canReply).toBe(false);
			expect(resolveAgentMessageCapabilities('claude').canReply).toBe(true);
			expect(resolveAgentMessageCapabilities('pi').canReply).toBe(true);
			expect(resolveAgentMessageCapabilities('grok').canReply).toBe(false);
			expect(resolveAgentMessageCapabilities('dsh').canReply).toBe(false);
		});

		it('throws E_CAPABILITY_UNSUPPORTED when agent does not support reply (E-117)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-grok-1',
					taskId: 'T-1',
					state: 'awaiting_reply',
					agentId: 'grok',
					pid: 1001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-grok-1' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			await expect(
				service.sendMessage({
					runId: 'run-grok-1',
					text: 'hello grok',
					kind: 'reply',
				}),
			).rejects.toMatchObject({
				code: 'E_CAPABILITY_UNSUPPORTED',
			});
		});

		it('canReply returns false when agent does not support reply bit', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-grok-1',
					taskId: 'T-1',
					state: 'awaiting_reply',
					agentId: 'grok',
					pid: 1001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-grok-1' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			expect(await service.canReply('run-grok-1')).toBe(false);
		});

		it('canReply returns true when agent supports reply and process is alive', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-codex-1',
					taskId: 'T-1',
					state: 'awaiting_reply',
					agentId: 'codex',
					pid: 1001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-codex-1' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			expect(await service.canReply('run-codex-1')).toBe(true);
		});
	});

	describe('AC 2 & E-113: Dead process or broken pipe records undelivered with original text', () => {
		it('records undelivered and preserves original text when process has exited', async () => {
			const { repo, messages } = createMockRunsRepo([
				{
					id: 'run-dead-1',
					taskId: 'T-1',
					state: 'running',
					agentId: 'codex',
					pid: 1001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-dead-1', isExited: true }));

			const { bus, published, envelopeFactory } = createMockBus();

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
				bus,
				envelopeFactory,
			});

			const originalText = 'my important message that must not be lost';

			await expect(
				service.sendMessage({
					runId: 'run-dead-1',
					text: originalText,
					kind: 'reply',
					actorDeviceId: 'dev-desktop',
				}),
			).rejects.toMatchObject({
				code: 'E_MESSAGE_UNDELIVERED',
				details: {
					text: originalText,
					deliveryState: 'undelivered',
					reason: 'process_exited',
				},
			});

			expect(messages).toHaveLength(1);
			expect(messages[0]?.deliveryState).toBe('undelivered');
			expect(messages[0]?.text).toBe(originalText);
			expect(messages[0]?.undeliveredReason).toBe('process_exited');
			expect(messages[0]?.actorDeviceId).toBe('dev-desktop');

			const undeliveredEvent = published.find((e) => e.kind === 'run.message_undelivered');
			expect(undeliveredEvent).toBeDefined();
			expect((undeliveredEvent?.payload as RunMessageUndeliveredPayload).reason).toBe(
				'process_exited',
			);
		});

		it('records undelivered when stdin pipe is broken or destroyed', async () => {
			const { repo, messages } = createMockRunsRepo([
				{
					id: 'run-broken-pipe',
					taskId: 'T-1',
					state: 'running',
					agentId: 'claude',
					pid: 1002,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-broken-pipe', stdinDestroyed: true }));

			const { bus, published, envelopeFactory } = createMockBus();

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
				bus,
				envelopeFactory,
			});

			const originalText = 'approve execution';

			await expect(
				service.sendMessage({
					runId: 'run-broken-pipe',
					text: originalText,
					kind: 'approve',
				}),
			).rejects.toMatchObject({
				code: 'E_MESSAGE_UNDELIVERED',
				details: {
					text: originalText,
					deliveryState: 'undelivered',
					reason: 'pipe_broken',
				},
			});

			expect(messages[0]?.deliveryState).toBe('undelivered');
			expect(messages[0]?.text).toBe(originalText);
			expect(messages[0]?.undeliveredReason).toBe('pipe_broken');

			const event = published.find((e) => e.kind === 'run.message_undelivered');
			expect(event).toBeDefined();
			expect((event?.payload as RunMessageUndeliveredPayload).reason).toBe('pipe_broken');
		});

		it('deliverMessage returns typed result instead of throwing when throwOnUndelivered is false', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-dead-2',
					taskId: 'T-1',
					state: 'running',
					agentId: 'codex',
					pid: 1001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-dead-2', isExited: true }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			const result = await service.deliverMessage({
				runId: 'run-dead-2',
				text: 'some rework instruction',
				kind: 'reply',
			});

			expect(result.delivered).toBe(false);
			expect(result.deliveryState).toBe('undelivered');
			expect(result.undeliveredReason).toBe('process_exited');
			expect(result.text).toBe('some rework instruction');
			expect(result.code).toBe('E_MESSAGE_UNDELIVERED');
		});
	});

	describe('AC 3 & E-112: Ended session resume vs redispatch prompt', () => {
		it('prompts redispatch when ended session agent does not support resume', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-ended-claude',
					taskId: 'T-10',
					state: 'landed',
					agentId: 'claude',
					pid: 2001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: createProcessRegistry(),
				clock,
				ids,
			});

			await expect(
				service.sendMessage({
					runId: 'run-ended-claude',
					text: 'try again',
					kind: 'reply',
				}),
			).rejects.toMatchObject({
				code: 'E_CAPABILITY_UNSUPPORTED',
				details: {
					canResume: false,
					suggestion: 'redispatch',
				},
			});
		});

		it('resumes session and marks as new run when agent supports resume (E-112)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-ended-codex',
					taskId: 'T-11',
					state: 'exited',
					agentId: 'codex',
					pid: 2002,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const resumeSessionMock = vi.fn(
				async (_input: Parameters<NonNullable<MessageServiceDeps['resumeSession']>>[0]) => ({
					newRunId: 'run-resumed-new',
					messageId: 'msg-resumed-1',
					delivered: true,
				}),
			);

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: createProcessRegistry(),
				clock,
				ids,
				resumeSession: resumeSessionMock,
			});

			const result = await service.sendMessage({
				runId: 'run-ended-codex',
				text: 'resume and continue testing',
				kind: 'reply',
				actorDeviceId: 'mobile-dev',
			});

			expect(result.delivered).toBe(true);
			expect(result.isNewRun).toBe(true);
			expect(result.newRunId).toBe('run-resumed-new');
			expect(resumeSessionMock).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: 'run-ended-codex',
					agentId: 'codex',
					text: 'resume and continue testing',
				}),
			);
		});
	});

	describe('AC 4 & E-114: Concurrent delivery serialization and device logging', () => {
		it('serializes concurrent deliveries strictly by arrival order without deduplication or merging', async () => {
			const { repo, messages } = createMockRunsRepo([
				{
					id: 'run-concurrent',
					taskId: 'T-20',
					state: 'awaiting_reply',
					agentId: 'codex',
					pid: 3001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const deliveryOrder: string[] = [];
			const mockProc = createMockProcess({
				runId: 'run-concurrent',
				onWrite(chunk) {
					deliveryOrder.push(chunk.toString().trim());
				},
			});

			const registry = createProcessRegistry();
			registry.register(mockProc);

			let timeCounter = 100;
			const variableClock = {
				now: () => `2026-09-14T10:00:${timeCounter++}.000Z`,
			};

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock: variableClock,
				ids,
			});

			const sameText = 'identical approval message';

			// Simulate two concurrent requests arriving at daemon from desktop and mobile
			const [resDesktop, resMobile] = await Promise.all([
				service.sendMessage({
					runId: 'run-concurrent',
					text: sameText,
					kind: 'approve',
					actorDeviceId: 'desktop-device-id',
				}),
				service.sendMessage({
					runId: 'run-concurrent',
					text: sameText,
					kind: 'approve',
					actorDeviceId: 'mobile-device-id',
				}),
			]);

			expect(resDesktop.delivered).toBe(true);
			expect(resMobile.delivered).toBe(true);
			expect(resDesktop.messageId).not.toBe(resMobile.messageId);

			// Both must be recorded without deduplication or merging (E-114)
			expect(messages).toHaveLength(2);
			expect(messages[0]?.actorDeviceId).toBe('desktop-device-id');
			expect(messages[1]?.actorDeviceId).toBe('mobile-device-id');
			expect(messages[0]?.text).toBe(sameText);
			expect(messages[1]?.text).toBe(sameText);

			// Stdin received both chunks in FIFO sequence
			expect(deliveryOrder).toEqual([sameText, sameText]);
		});
	});

	describe('AC 5 & E-116: Empty and overlong message validation', () => {
		it('rejects empty or whitespace-only messages with E_VALIDATION', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-val-1',
					taskId: 'T-30',
					state: 'running',
					agentId: 'codex',
					pid: 4001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: createProcessRegistry(),
				clock,
				ids,
			});

			await expect(
				service.sendMessage({
					runId: 'run-val-1',
					text: '',
					kind: 'reply',
				}),
			).rejects.toMatchObject({
				code: 'E_VALIDATION',
			});

			await expect(
				service.sendMessage({
					runId: 'run-val-1',
					text: '   \t\n  ',
					kind: 'reply',
				}),
			).rejects.toMatchObject({
				code: 'E_VALIDATION',
			});
		});

		it('rejects overlong message and prompts for truncation confirmation without silent truncation (E-116)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-val-2',
					taskId: 'T-31',
					state: 'running',
					agentId: 'codex',
					pid: 4002,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: createProcessRegistry(),
				clock,
				ids,
				maxMessageLength: 100,
			});

			const longText = 'A'.repeat(150);

			await expect(
				service.sendMessage({
					runId: 'run-val-2',
					text: longText,
					kind: 'reply',
				}),
			).rejects.toMatchObject({
				code: 'E_VALIDATION',
				details: {
					requiresTruncationConfirmation: true,
					length: 150,
					maxLength: 100,
				},
			});
		});
	});

	describe('AC 6: Writing to stdin checks write() return value and awaits drain', () => {
		it('awaits drain when writeStdin returns false (backpressure)', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-drain-1',
					taskId: 'T-40',
					state: 'running',
					agentId: 'codex',
					pid: 5001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			let drainWaited = false;
			const mockProc = createMockProcess({
				runId: 'run-drain-1',
				writeResult: false, // Triggers backpressure
			});

			mockProc.waitForStdinDrain = vi.fn(async () => {
				drainWaited = true;
			});

			const registry = createProcessRegistry();
			registry.register(mockProc);

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			const result = await service.sendMessage({
				runId: 'run-drain-1',
				text: 'backpressured message',
				kind: 'reply',
			});

			expect(result.delivered).toBe(true);
			expect(mockProc.waitForStdinDrain).toHaveBeenCalledTimes(1);
			expect(drainWaited).toBe(true);
		});

		it('transitions run state from awaiting_reply to running upon successful delivery', async () => {
			const { repo, stateUpdates } = createMockRunsRepo([
				{
					id: 'run-state-trans',
					taskId: 'T-41',
					state: 'awaiting_reply',
					agentId: 'codex',
					pid: 5002,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-state-trans' }));

			const { bus, published, envelopeFactory } = createMockBus();

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
				bus,
				envelopeFactory,
			});

			const result = await service.sendMessage({
				runId: 'run-state-trans',
				text: 'resume work',
				kind: 'reply',
			});

			expect(result.delivered).toBe(true);
			expect(stateUpdates).toHaveLength(1);
			expect(stateUpdates[0]?.fromState).toBe('awaiting_reply');
			expect(stateUpdates[0]?.toState).toBe('running');

			const stateChangedEvent = published.find((e) => e.kind === 'run.state_changed');
			expect(stateChangedEvent).toBeDefined();
			expect((stateChangedEvent?.payload as RunStateChangedPayload).to).toBe('running');
			expect((stateChangedEvent?.payload as RunStateChangedPayload).reason).toBe('human_replied');

			const deliveredEvent = published.find((e) => e.kind === 'run.message_delivered');
			expect(deliveredEvent).toBeDefined();
			expect((deliveredEvent?.payload as RunMessageDeliveredPayload).messageId).toBe(
				result.messageId,
			);
		});
	});

	describe('Fastify HTTP route: POST /api/v1/runs/:runId/messages', () => {
		it('returns 200 with { delivered: true, messageId } on successful delivery', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-http-1',
					taskId: 'T-50',
					state: 'awaiting_reply',
					agentId: 'codex',
					pid: 6001,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-http-1' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			const app = Fastify({ logger: false });
			registerRunsRoutes(app, { messageService: service });

			const response = await app.inject({
				method: 'POST',
				url: '/api/v1/runs/run-http-1/messages',
				payload: {
					text: 'hello from api',
					kind: 'reply',
				},
			});

			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.delivered).toBe(true);
			expect(typeof body.messageId).toBe('string');
			await app.close();
		});

		it('rejects additionalProperties in request body with 400', async () => {
			const { repo } = createMockRunsRepo([
				{
					id: 'run-http-2',
					taskId: 'T-51',
					state: 'running',
					agentId: 'codex',
					pid: 6002,
					parentRunId: null,
					attemptNo: 1,
				},
			]);

			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-http-2' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			const app = Fastify({
				logger: false,
				ajv: { customOptions: { removeAdditional: false } },
			});
			registerRunsRoutes(app, { messageService: service });

			const response = await app.inject({
				method: 'POST',
				url: '/api/v1/runs/run-http-2/messages',
				payload: {
					text: 'hello',
					kind: 'reply',
					extraUnallowedField: 'bad',
				},
			});

			expect(response.statusCode).toBe(400);
			await app.close();
		});
	});

	describe('Real SQLite Database Integration', () => {
		it('persists message and state transition in real SQLite database', async () => {
			const db: DatabaseConnection = openDatabase(':memory:');
			db.exec(`
				CREATE TABLE documents (
					id TEXT PRIMARY KEY, docs_path TEXT NOT NULL, project_name TEXT NOT NULL,
					content_fingerprint TEXT NOT NULL, imported_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
				);
				CREATE TABLE tasks (
					id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(id),
					task_key TEXT NOT NULL, title TEXT NOT NULL, module_key TEXT NOT NULL,
					deps_json TEXT NOT NULL, contract_hash TEXT NOT NULL, contract_reasons_json TEXT NOT NULL
				);
				CREATE TABLE dispatch_snapshots (
					id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
					contract_hash TEXT NOT NULL, task_paths_json TEXT NOT NULL, launch_spec_json TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
				CREATE TABLE devices (
					id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
					token_salt TEXT NOT NULL, paired_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
				);
				CREATE TABLE runs (
					id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
					attempt_no INTEGER NOT NULL, kind TEXT NOT NULL, parent_run_id TEXT REFERENCES runs(id),
					state TEXT NOT NULL, agent_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
					permission_tier TEXT NOT NULL, pid INTEGER, last_event_at TEXT
				);
				CREATE TABLE run_messages (
					id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
					kind TEXT NOT NULL, text TEXT, delivery_state TEXT NOT NULL,
					undelivered_reason TEXT, actor_device_id TEXT REFERENCES devices(id),
					created_at TEXT NOT NULL, delivered_at TEXT
				);

				INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
				VALUES ('doc-1', '/docs', 'Test Project', 'fp', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');

				INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json)
				VALUES ('task-1', 'doc-1', 'M6-T6', 'Message Delivery', 'M6', '[]', 'hash-1', '[]');

				INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at)
				VALUES ('snap-1', 'task-1', 'hash-1', '[]', '{}', '2026-09-14T00:00:00Z');

				INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at)
				VALUES ('dev-1', 'Dev Device', 'hash', 'salt', '2026-09-14T00:00:00Z', '2026-09-14T00:00:00Z');

				INSERT INTO runs (id, task_id, attempt_no, kind, state, agent_id, snapshot_id, permission_tier, pid)
				VALUES ('run-sqlite-1', 'task-1', 1, 'implement', 'awaiting_reply', 'codex', 'snap-1', 'workspaceWrite', 9999);
			`);

			const repo = createSqliteRunMessagesRepo(db);
			const registry = createProcessRegistry();
			registry.register(createMockProcess({ runId: 'run-sqlite-1' }));

			const service = createMessageService({
				runMessagesRepo: repo,
				processRegistry: registry,
				clock,
				ids,
			});

			const result = await service.sendMessage({
				runId: 'run-sqlite-1',
				text: 'approved by user',
				kind: 'approve',
				actorDeviceId: 'dev-1',
			});

			expect(result.delivered).toBe(true);

			// Verify in database
			const msgRow = repo.findMessageById(result.messageId);
			expect(msgRow).not.toBeNull();
			expect(msgRow?.deliveryState).toBe('delivered');
			expect(msgRow?.text).toBe('approved by user');
			expect(msgRow?.kind).toBe('approve');
			expect(msgRow?.actorDeviceId).toBe('dev-1');

			const runRow = repo.findRunById('run-sqlite-1');
			expect(runRow?.state).toBe('running');

			db.close();
		});
	});
});
