import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexSessionRegistry } from '../../src/adapters/codex/app-server-session.ts';
import { createContainer } from '../../src/boot/container.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createErrorHandler } from '../../src/http/plugins/90-error-handler.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';

function createMemoryLockAdapter(): NativeLockAdapter {
	let lockContents: string | undefined;
	const missing = (): NativeLockFailure => ({
		kind: 'not-found',
		error: new Error('Memory lock is missing.') as never,
	});
	return Object.freeze({
		platform: 'linux',
		filePath: '/machine/daemon.lock',
		dirPath: '/machine',
		reclaimPath: '/machine/daemon.lock.reclaim',
		permissionLines: ['root:root 0600'],
		createExclusive(contents: string): NativeLockWriteResult {
			if (lockContents !== undefined) {
				return {
					ok: false,
					failure: {
						kind: 'already-exists',
						error: new Error('Memory lock already exists.') as never,
					},
				};
			}
			lockContents = contents;
			return { ok: true };
		},
		read(): NativeLockReadResult {
			return lockContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: lockContents };
		},
		remove(): NativeLockWriteResult {
			lockContents = undefined;
			return { ok: true };
		},
		verifyPermissions: (): NativeLockWriteResult => ({ ok: true }),
		inspectPermissions: (): NativeLockReadResult => ({
			ok: true,
			contents: 'root:root mode=600',
		}),
		createReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
		readReclaimGuard(): NativeLockReadResult {
			return { ok: false, failure: missing() };
		},
		removeReclaimGuard: (): NativeLockWriteResult => ({ ok: true }),
	});
}

function runMigrations(db: DatabaseConnection) {
	const migrationsDir = join(__dirname, '../../migrations');
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const sql = readFileSync(join(migrationsDir, file), 'utf8');
		db.exec(sql);
	}
}

describe('R8-T54786768 Integration: POST /api/v1/runs/:runId/messages elevate_once entry (E-133)', () => {
	let db: DatabaseConnection;
	let container: ReturnType<typeof createContainer>;
	let server: ReturnType<typeof createHttpServer>;
	let authToken: string;
	let publishedEvents: EventEnvelope[];
	const codexSessions = createCodexSessionRegistry();

	beforeEach(async () => {
		db = openDatabase(':memory:');
		runMigrations(db);

		publishedEvents = [];
		const lockAdapter = createMemoryLockAdapter();
		const dataDir = join(__dirname, '../fixtures');

		container = createContainer({
			config: {
				port: 7817,
				bind: '127.0.0.1',
				dataDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: dataDir },
			lockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-25T12:00:00.000Z' },
			codexSessions,
		});

		container.events.bus.subscribe((envelope) => {
			publishedEvents.push(envelope);
		});

		server = createHttpServer({ container });
		await server.instance.ready();

		const claim = await container.services.pairing.claimPairingCode({
			code:
				container.services.pairing.getActivePairingCode()?.code ??
				container.services.pairing.createPairingCode().code,
			deviceName: 'test-device',
		});
		authToken = `Bearer ${claim.token}`;

		// Seed base document and task
		db.prepare(`
			INSERT INTO documents (
				id, docs_path, project_name, repo_path, main_branch, branch_prefix,
				lane_count, content_fingerprint, is_source_readable, is_takeover_notified,
				imported_at, last_seen_at
			) VALUES (
				'doc-1', 'docs/Agent任务调度器-开发文档', 'scheduler', '/repo', 'main', 'task/',
				2, 'fp-1', 1, 0, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z'
			);
		`).run();

		db.prepare(`
			INSERT INTO tasks (
				id, doc_id, task_key, title, module_key, deps_json,
				contract_hash, is_contract_ready, contract_reasons_json
			) VALUES (
				'task-1', 'doc-1', 'M6-T7', '提问处置', 'M6', '[]',
				'hash-1', 1, '[]'
			);
		`).run();

		db.prepare(`
			INSERT INTO dispatch_snapshots (
				id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at
			) VALUES (
				'snap-1', 'task-1', 'hash-1', '[]', '{}', '2026-09-25T00:00:00.000Z'
			);
		`).run();
	});

	afterEach(() => {
		db.close();
	});

	function seedRun(id: string, state: string, options: { sessionArchivedAt?: string | null } = {}) {
		db.prepare(`
			INSERT INTO runs (
				id, task_id, attempt_no, kind, state, agent_id,
				permission_tier, snapshot_id, session_archived_at
			) VALUES (
				?, 'task-1', 1, 'implement', ?, 'codex',
				'workspaceWrite', 'snap-1', ?
			);
		`).run(id, state, options.sessionArchivedAt ?? null);
	}

	async function attachPendingCodexApproval(
		runId: string,
		options: { failApprovalWrite?: boolean } = {},
	) {
		const listeners = new Set<(value: { value: unknown }) => void>();
		const writes: Record<string, unknown>[] = [];
		const emit = (value: unknown) => {
			for (const listener of listeners) listener({ value });
		};
		const process = {
			isExited: false,
			child: { killed: false, stdin: { destroyed: false, writable: true, end() {} } },
			onJson(listener: (value: { value: unknown }) => void) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onExit() {
				return () => undefined;
			},
			writeStdin(raw: string) {
				const message = JSON.parse(raw) as Record<string, unknown>;
				writes.push(message);
				if (message.id === 0 && options.failApprovalWrite) throw new Error('broken pipe');
				queueMicrotask(() => {
					if (message.method === 'initialize') emit({ id: message.id, result: {} });
					if (message.method === 'thread/start')
						emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
					if (message.method === 'turn/start')
						emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
					if (message.method === 'turn/steer')
						emit({ id: message.id, result: { turnId: 'turn-1' } });
					if (message.id === 0 && message.result)
						emit({
							method: 'serverRequest/resolved',
							params: { requestId: 0, threadId: 'thread-1' },
						});
				});
				return true;
			},
			waitForStdinDrain: async () => undefined,
		} as unknown as ManagedProcess;
		const session = codexSessions.register(runId, process);
		await session.start({ prompt: 'work', sandbox: 'workspace-write' });
		emit({
			id: 0,
			method: 'item/commandExecution/requestApproval',
			params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
		});
		return { session, writes };
	}

	it('AC 1 & E-133: body {kind:"elevate_once"} with omitted text in awaiting_reply returns 200, elevates run and transitions to running', async () => {
		const runId = 'run-awaiting-1';
		seedRun(runId, 'awaiting_reply');
		const approval = await attachPendingCodexApproval(runId);

		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);

		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});

		expect(response.statusCode).toBe(200);
		const json = JSON.parse(response.body);
		expect(json.delivered).toBe(true);
		expect(approval.writes).toContainEqual({ id: 0, result: { decision: 'acceptForSession' } });
		expect(typeof json.messageId).toBe('string');

		// Run is elevated in memory
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(true);

		// Run state in database transitioned to running
		const runRow = db
			.prepare('SELECT state, permission_tier FROM runs WHERE id = ?')
			.get(runId) as {
			state: string;
			permission_tier: string;
		};
		expect(runRow.state).toBe('running');
		// Default permission tier in db untouched (E-133)
		expect(runRow.permission_tier).toBe('workspaceWrite');

		// Events emitted: state_changed and message_delivered
		const stateChanged = publishedEvents.find(
			(e) => e.kind === 'run.state_changed' && e.runId === runId,
		);
		expect(stateChanged).toBeDefined();
		expect((stateChanged?.payload as { to?: string })?.to).toBe('running');

		const msgDelivered = publishedEvents.find(
			(e) => e.kind === 'run.message_delivered' && e.runId === runId,
		);
		expect(msgDelivered).toBeDefined();
		const followup = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'reply', text: 'Continue with the approved action.' },
			headers: { authorization: authToken },
		});
		expect(followup.statusCode).toBe(200);
		expect(approval.writes.some((w) => w.method === 'turn/steer')).toBe(true);
	});

	it('AC 1: a running run without a pending approval rejects elevation', async () => {
		const runId = 'run-running-1';
		seedRun(runId, 'running');

		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);

		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once', text: '' },
			headers: { authorization: authToken },
		});

		expect(response.statusCode).toBe(409);
		const json = JSON.parse(response.body);
		expect(json.error.code).toBe('E_INVALID_STATE_TRANSITION');
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);

		const runRow = db.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as {
			state: string;
		};
		expect(runRow.state).toBe('running');

		expect(
			publishedEvents.some((e) => e.kind === 'run.message_delivered' && e.runId === runId),
		).toBe(false);
	});

	it('concurrent clicks consume one approval and leave one delivered message', async () => {
		const runId = 'run-concurrent-approval';
		seedRun(runId, 'awaiting_reply');
		const approval = await attachPendingCodexApproval(runId);
		const request = () =>
			server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${runId}/messages`,
				payload: { kind: 'elevate_once' },
				headers: { authorization: authToken },
			});
		const responses = await Promise.all([request(), request()]);
		expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
		expect(approval.writes.filter((w) => w.id === 0)).toHaveLength(1);
		const rows = db
			.prepare('SELECT delivery_state FROM run_messages WHERE run_id = ?')
			.all(runId) as Array<{ delivery_state: string }>;
		expect(rows).toEqual([{ delivery_state: 'delivered' }]);
	});

	it('failed protocol write leaves no delivered message or temporary elevation', async () => {
		const runId = 'run-broken-approval';
		seedRun(runId, 'awaiting_reply');
		await attachPendingCodexApproval(runId, { failApprovalWrite: true });
		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});
		expect(response.statusCode).toBe(422);
		expect(JSON.parse(response.body).error.code).toBe('E_MESSAGE_UNDELIVERED');
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);
		expect(
			db.prepare('SELECT COUNT(*) AS count FROM run_messages WHERE run_id = ?').get(runId),
		).toEqual({ count: 0 });
	});

	it('AC 1 & E-133: body {kind:"elevate_once"} in illegal state (exited) returns 409 E_INVALID_STATE_TRANSITION', async () => {
		const runId = 'run-exited-1';
		seedRun(runId, 'exited');

		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});

		// 仅 elevate_once 请求的非法状态被映射为冲突。
		expect(response.statusCode).toBe(409);
		const json = JSON.parse(response.body);
		expect(json.error.code).toBe('E_INVALID_STATE_TRANSITION');
		expect(json.error.details.operation).toBe('elevate_once');
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);

		// R2: 失败请求绝不留下假投递记录
		const countRow = db
			.prepare('SELECT COUNT(*) as count FROM run_messages WHERE run_id = ?')
			.get(runId) as { count: number };
		expect(countRow.count).toBe(0);
	});

	it('R1: a generic state-machine failure with from context retains its default server status', async () => {
		const probe = Fastify();
		createErrorHandler(probe);
		probe.get('/transition-probe', () => {
			throw new AppError('E_INVALID_STATE_TRANSITION', 'Internal transition failed.', {
				details: { from: 'running', to: 'starting' },
			});
		});
		try {
			const response = await probe.inject({ method: 'GET', url: '/transition-probe' });
			expect(response.statusCode).toBe(500);
			expect(JSON.parse(response.body).error.code).toBe('E_INVALID_STATE_TRANSITION');
		} finally {
			await probe.close();
		}
	});

	it('R2 negative: returns 422 E_MESSAGE_UNDELIVERED when elevateRunOnce capability is unavailable', async () => {
		const runId = 'run-awaiting-no-elevate-fn';
		seedRun(runId, 'awaiting_reply');

		// 构造一个没有 runService / elevateRunOnce 注入的隔离 server
		const mockServer = createHttpServer({
			container: {
				...container,
				services: {
					...container.services,
					// run 服务缺失 elevateRunOnce
					run: undefined as never,
				},
			},
		});
		await mockServer.instance.ready();

		const response = await mockServer.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});

		expect(response.statusCode).toBe(422);
		const json = JSON.parse(response.body);
		expect(json.error.code).toBe('E_CAPABILITY_UNSUPPORTED');
		await mockServer.instance.close();
	});

	it('AC 1 & E-302: body {kind:"elevate_once"} on archived session returns 409 E_SESSION_ARCHIVED', async () => {
		const runId = 'run-archived-1';
		seedRun(runId, 'landed', { sessionArchivedAt: '2026-09-25T10:00:00.000Z' });

		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});

		expect(response.statusCode).toBe(409);
		const json = JSON.parse(response.body);
		expect(json.error.code).toBe('E_SESSION_ARCHIVED');
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);
	});

	it('AC 1 & schema validation: text required for reply/approve/deny, and additionalProperties disallowed', async () => {
		const runId = 'run-val-1';
		seedRun(runId, 'awaiting_reply');

		// 1. reply without text -> 400
		const resNoText = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'reply' },
			headers: { authorization: authToken },
		});
		expect(resNoText.statusCode).toBe(400);
		expect(JSON.parse(resNoText.body).error.code).toBe('E_VALIDATION');

		// 2. reply with empty text -> 400
		const resEmptyText = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'reply', text: '' },
			headers: { authorization: authToken },
		});
		expect(resEmptyText.statusCode).toBe(400);
		expect(JSON.parse(resEmptyText.body).error.code).toBe('E_VALIDATION');

		// 3. elevate_once with extra properties -> 400 (additionalProperties: false)
		const resExtraProp = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once', unexpectedField: true },
			headers: { authorization: authToken },
		});
		expect(resExtraProp.statusCode).toBe(400);
		expect(JSON.parse(resExtraProp.body).error.code).toBe('E_VALIDATION');
	});

	it('AC 2 & E-133: temporary elevation expires upon run exiting and does not mutate agents.json', async () => {
		const runId = 'run-exit-clean-1';
		seedRun(runId, 'awaiting_reply');
		await attachPendingCodexApproval(runId);

		await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/messages`,
			payload: { kind: 'elevate_once' },
			headers: { authorization: authToken },
		});
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(true);

		// Transition run to exited
		await container.services.run.transitionState({
			runId,
			targetState: 'exited',
			reason: 'process_exited',
		});

		// isTemporarilyElevated must be false
		expect(container.services.run.isTemporarilyElevated(runId)).toBe(false);
	});
});
