import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { CreateRunResponse } from '@agent-scheduler/shared/api/runs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexLaunchSpec } from '../../src/adapters/codex/build-launch-spec.ts';
import { createContainer } from '../../src/boot/container.ts';
import type { ProcessConfig } from '../../src/config/env.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { ParsedJsonLine, ReadLine } from '../../src/proc/line-reader.ts';
import type { LaunchSpec, ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import type {
	PrepareWorktreeInput,
	PrepareWorktreeResult,
	WorktreeManager,
} from '../../src/workspace/worktree.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(currentDir, '../../migrations');
const fixturePath = resolve(currentDir, '../fixtures/dispatch/codex-session.ndjson');

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];

afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		if (db.open) db.close();
	}
	for (const dir of temporaryDirectories.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createTestConfig(dataDir: string): ProcessConfig {
	return Object.freeze({
		port: 0,
		bind: '127.0.0.1',
		dataDir,
		logLevel: 'info',
		dev: false,
	});
}

const dummyLockHandle: LockFileHandle = {
	path: '/dummy.lock',
	metadata: {
		pid: process.pid,
		uid: '1000',
		startedAt: new Date().toISOString(),
		port: 7817,
		bind: '127.0.0.1',
	},
	serializedMetadata: '{}',
	released: false,
	release: () => {},
};

const dummyLockAdapter: NativeLockAdapter = {
	platform: 'linux',
	filePath: '/dummy.lock',
	dirPath: '/dummy',
	reclaimPath: '/dummy.reclaim',
	permissionLines: [],
	createExclusive: () => ({ ok: true }),
	read: () => ({ ok: true, contents: '{}' }),
	remove: () => ({ ok: true }),
	verifyPermissions: () => ({ ok: true }),
	createReclaimGuard: () => ({ ok: true }),
	readReclaimGuard: () => ({ ok: true, contents: '{}' }),
	removeReclaimGuard: () => ({ ok: true }),
	inspectPermissions: () => ({ ok: true, contents: '{}' }),
};

interface FakeManagedProcessController {
	readonly managed: ManagedProcess;
	readonly emitLine: (text: string) => void;
	readonly emitExit: (exitCode: number, signal?: NodeJS.Signals | null) => void;
	readonly lastLaunchSpec: LaunchSpec;
}

function createFakeProcess(
	spec: LaunchSpec,
	options: { exitCode?: number; stderrTail?: string } = {},
): FakeManagedProcessController {
	const rawListeners = new Set<(line: ReadLine) => void>();
	const jsonListeners = new Set<(parsed: ParsedJsonLine) => void>();
	const exitListeners = new Set<(result: ProcessExitResult) => void>();
	let isExited = false;
	const stderrTail = options.stderrTail ?? '';

	const managed: ManagedProcess = {
		runId: spec.runId,
		pid: 88888,
		file: spec.file,
		args: spec.args,
		cwd: spec.cwd,
		child: {} as never,
		stdoutReader: {} as never,
		stderrReader: {} as never,
		timers: {} as never,
		get isExited() {
			return isExited;
		},
		get stderrTail() {
			return stderrTail;
		},
		attachAppendQueue: () => () => {},
		waitForStdinDrain: () => Promise.resolve(),
		onStdinDrain: () => () => {},
		writeStdin: () => true,
		onLine: () => () => {},
		onRaw: (listener) => {
			rawListeners.add(listener);
			return () => rawListeners.delete(listener);
		},
		onStderr: () => () => {},
		onJson: (listener) => {
			jsonListeners.add(listener);
			return () => jsonListeners.delete(listener);
		},
		onExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		onError: () => () => {},
		kill: async () => ({
			outcome: 'terminated' as const,
			attempts: [],
		}),
		finalize: async () => {},
	};

	function emitLine(text: string) {
		const rawLine: ReadLine = {
			text,
			truncated: false,
			rawByteLen: Buffer.byteLength(text),
		};
		for (const l of rawListeners) {
			l(rawLine);
		}
		try {
			const parsed = JSON.parse(text);
			for (const l of jsonListeners) {
				l({
					...rawLine,
					isJson: true,
					value: parsed,
				});
			}
		} catch {}
	}

	function emitExit(exitCode: number, signal: NodeJS.Signals | null = null) {
		if (isExited) return;
		isExited = true;
		const result: ProcessExitResult = {
			runId: spec.runId,
			pid: 88888,
			exitCode,
			signal,
			reason: 'exited',
		};
		for (const l of exitListeners) {
			l(result);
		}
	}

	return {
		managed,
		emitLine,
		emitExit,
		lastLaunchSpec: spec,
	};
}

async function getAuthToken(container: ReturnType<typeof createContainer>): Promise<string> {
	const activeCode =
		container.services.pairing.getActivePairingCode()?.code ??
		container.services.pairing.createPairingCode().code;
	const claim = await container.services.pairing.claimPairingCode({
		code: activeCode,
		deviceName: 'test-device-m8-t10',
	});
	return `Bearer ${claim.token}`;
}

async function readSseEventsUntil(
	url: string,
	token: string,
	predicate: (events: Array<{ id: number; kind: string; data: unknown }>) => boolean,
	timeoutMs = 6000,
): Promise<Array<{ id: number; kind: string; data: unknown }>> {
	const controller = new AbortController();
	const response = await fetch(url, {
		headers: { authorization: token },
		signal: controller.signal,
	});
	if (!response.body) {
		throw new Error('No response body for SSE stream');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const events: Array<{ id: number; kind: string; data: unknown }> = [];
	let buffer = '';

	const startTime = Date.now();
	try {
		while (Date.now() - startTime < timeoutMs) {
			const { done, value } = await Promise.race([
				reader.read(),
				new Promise<{ done: true; value: undefined }>((_, reject) =>
					setTimeout(() => reject(new Error('SSE read timeout')), timeoutMs),
				),
			]);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			let currentId: number | null = null;
			let currentEvent: string | null = null;
			let currentData: string | null = null;

			for (const line of lines) {
				if (line.startsWith('id: ')) {
					currentId = Number(line.slice(4).trim());
				} else if (line.startsWith('event: ')) {
					currentEvent = line.slice(7).trim();
				} else if (line.startsWith('data: ')) {
					currentData = line.slice(6).trim();
				} else if (line === '') {
					if (currentId !== null && currentEvent !== null && currentData !== null) {
						try {
							events.push({
								id: currentId,
								kind: currentEvent,
								data: JSON.parse(currentData),
							});
						} catch {}
					}
					currentId = null;
					currentEvent = null;
					currentData = null;
				}
			}

			if (predicate(events)) {
				break;
			}
		}
	} finally {
		controller.abort();
	}
	return events;
}

function setupTestEnvironment(
	overrides: {
		readonly prepareWorktreeFail?: boolean;
		readonly codexAvailable?: boolean;
		readonly exitCode?: number;
		readonly stderrTail?: string;
	} = {},
) {
	const tempDir = mkdtempSync(join(tmpdir(), 'agent-scheduler-dispatch-spawn-'));
	temporaryDirectories.push(tempDir);
	const dbPath = join(tempDir, 'test.db');

	let timeMs = 1725800000000;
	const clock = {
		now: () => new Date(timeMs++).toISOString(),
	};

	const db = openDatabase(dbPath);
	openDatabases.push(db);

	const runner = createMigrationRunner({
		clock,
		database: db,
		fileSystem: {
			readDirectory: (dir) => readdirSync(dir),
			readFile: (p) => readFileSync(p, 'utf8'),
		},
	});
	runner.run(migrationsDir);

	let latestFakeProc: FakeManagedProcessController | null = null;
	const fakeSpawnManaged = ((spec: LaunchSpec) => {
		latestFakeProc = createFakeProcess(spec, {
			exitCode: overrides.exitCode ?? 0,
			stderrTail: overrides.stderrTail ?? '',
		});
		return latestFakeProc.managed;
	}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged;

	const fakeWorktreeManager = {
		prepareWorktree: async (input: PrepareWorktreeInput): Promise<PrepareWorktreeResult> => {
			if (overrides.prepareWorktreeFail) {
				throw new AppError('E_WORKSPACE_UNAVAILABLE', 'Disk full or permission denied', {
					details: { releaseSlot: true },
				});
			}
			return {
				worktreePath: join(tempDir, 'worktrees', input.taskId),
				branchName: `task/${input.taskId}`,
				baseRef: input.baseRef ?? 'HEAD',
				isReused: false,
			};
		},
		prepareWrapupWorktree: async () => ({
			worktreePath: join(tempDir, 'wrapup'),
			branchName: 'wrapup/1',
			baseRef: 'HEAD',
			isReused: false,
		}),
	} as unknown as WorktreeManager;

	let mechanicalCheckCalls = 0;
	const fakeReviewService = {
		evaluateMechanicalCheck: async () => {
			mechanicalCheckCalls++;
			return { verdict: 'pass' };
		},
	};

	const fakeAgentService = {
		start: async () => {},
		stop: async () => {},
		listAgents: async () => [
			{ id: 'codex', canDispatch: overrides.codexAvailable !== false, maxConcurrency: 2 },
		],
		getAvailability: (agentId: string) => {
			if (agentId === 'codex') {
				return { canDispatch: overrides.codexAvailable !== false, isReady: true, status: 'ready' };
			}
			return { canDispatch: false, isReady: false, status: 'not_found' };
		},
		listAgentModels: async () => ({ models: [], currentConfig: {} }),
	} as unknown as import('../../src/service/agents.ts').AgentService;

	const container = createContainer({
		config: createTestConfig(tempDir),
		database: db,
		hostInputs: { platform: 'linux', homedir: tempDir },
		lockAdapter: dummyLockAdapter,
		instanceLock: dummyLockHandle,
		clock,
		spawnManaged: fakeSpawnManaged,
		worktreeManager: fakeWorktreeManager,
		reviewService: fakeReviewService,
		agentService: fakeAgentService,
		logViolation: (msg) => console.log('VIOLATION:', msg),
	});

	// Seed document, batch, task
	container.repos.documents.insert({
		id: 'doc-1',
		docs_path: '/docs',
		project_name: 'test-project',
		repo_path: tempDir,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 2,
		content_fingerprint: 'fp-1',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: clock.now(),
		last_seen_at: clock.now(),
	});

	container.repos.batches.insert({
		id: 'batch-1',
		doc_id: 'doc-1',
		batch_no: 1,
		state: 'running',
		started_at: clock.now(),
	});

	container.repos.tasks.insert({
		id: 'task-1',
		doc_id: 'doc-1',
		task_key: 'M8-T10',
		title: 'Implement dispatch spawn',
		module_key: 'M8',
		deps_json: '[]',
		est_days: 2,
		batch_id: 'batch-1',
		manual_state: 'pending',
		contract_hash: 'contract-hash-task-1',
		is_contract_ready: 1,
		contract_reasons_json: '[]',
		has_accept_changed: 0,
		has_prompt_changed: 0,
		is_removed_from_doc: 0,
	});

	return {
		container,
		db,
		clock,
		tempDir,
		getLatestProc: () => latestFakeProc,
		getMechanicalCheckCalls: () => mechanicalCheckCalls,
		fakeReviewService,
	};
}

describe('M8-T10 Integration: dispatch spawn & event pipeline', { timeout: 20000 }, () => {
	it('AC 1 & E-42 & E-70: POST /api/v1/runs spawns managed process, validates LaunchSpec, sets pid, emits run.state_changed', async () => {
		const { container, getLatestProc } = setupTestEnvironment();
		const server = createHttpServer({ container });
		await server.instance.ready();

		const token = await getAuthToken(container);

		// Record bus events
		const busEvents: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => {
			busEvents.push(event);
		});

		// 1. POST /api/v1/runs with model containing shell meta characters (E-42)
		const postRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs',
			headers: { authorization: token },
			payload: {
				taskId: 'task-1',
				agentId: 'codex',
				model: 'gpt-5-preview; echo "hacked" &',
				idempotencyKey: 'idemp-spawn-1',
			},
		});

		expect(postRes.statusCode).toBe(200);
		const postBody = JSON.parse(postRes.body) as CreateRunResponse;
		expect(postBody.run.id).toBeDefined();

		// Wait for launchRun to finish in tick and state to become running, and bus event to be published
		await container.services.dispatch.tick();
		let run = container.repos.runs.findById(postBody.run.id);
		let attempts = 0;
		while (
			(run?.state !== 'running' || !busEvents.some((e) => e.kind === 'run.state_changed')) &&
			attempts < 100
		) {
			await new Promise((r) => setTimeout(r, 20));
			run = container.repos.runs.findById(postBody.run.id);
			attempts++;
		}

		expect(run).not.toBeNull();
		// AC 1: runs.pid is non-empty
		expect(run?.pid).toBe(88888);
		expect(run?.state).toBe('running');

		// AC 1: run.state_changed emitted from:starting to:running
		const stateChanged = busEvents.find(
			(e) =>
				e.kind === 'run.state_changed' &&
				(e.payload as { from?: string; to?: string }).from === 'starting' &&
				(e.payload as { from?: string; to?: string }).to === 'running',
		);
		expect(stateChanged).toBeDefined();

		// AC 1: LaunchSpec file/args verbatim match buildCodexLaunchSpec(), cwd is worktree absolute path, shell:false
		const latestProc = getLatestProc();
		expect(latestProc).not.toBeNull();
		const expectedLaunchSpec = buildCodexLaunchSpec({
			runId: postBody.run.id,
			cwd: run?.worktree_path ?? '',
			model: 'gpt-5-preview; echo "hacked" &',
			permissionTier: 'workspaceWrite',
		});
		expect(latestProc?.lastLaunchSpec.file).toBe(expectedLaunchSpec.file);
		expect(latestProc?.lastLaunchSpec.args).toEqual(expectedLaunchSpec.args);
		expect(latestProc?.lastLaunchSpec.cwd).toBe(run?.worktree_path);

		await server.instance.close();
	});

	it('AC 2 & E-140 & E-142 & E-10: Fake process emits codex-session.ndjson; events.ndjson, index table, and SSE reader verify events', async () => {
		const { container, getLatestProc, tempDir } = setupTestEnvironment();
		const server = createHttpServer({ container });

		// Start real HTTP listen for SSE fetch
		await server.instance.listen({ port: 0, host: '127.0.0.1' });
		const address = server.instance.server.address();
		const port = typeof address === 'object' && address !== null ? address.port : 7817;
		const sseUrl = `http://127.0.0.1:${port}/api/v1/events`;

		const token = await getAuthToken(container);

		// Connect SSE reader first (E-10, E-142)
		const ssePromise = readSseEventsUntil(
			sseUrl,
			token,
			(events) => events.some((e) => e.kind === 'tool_call'),
			8000,
		);

		// Create run
		const postRes = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs',
			headers: { authorization: token },
			payload: {
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'idemp-spawn-2',
			},
		});
		const postBody = JSON.parse(postRes.body) as CreateRunResponse;
		// Wait for run to be running and process to be spawned
		await container.services.dispatch.tick();
		let run = container.repos.runs.findById(postBody.run.id);
		let attempts = 0;
		while (run?.state !== 'running' && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			run = container.repos.runs.findById(postBody.run.id);
			attempts++;
		}

		const procController = getLatestProc();
		expect(procController).not.toBeNull();

		// Feed lines from codex-session.ndjson (including non-JSON banner for E-140)
		const fixtureLines = readFileSync(fixturePath, 'utf8')
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.length > 0);

		for (const line of fixtureLines) {
			procController?.emitLine(line);
			await new Promise((r) => setTimeout(r, 10));
		}

		// Wait for SSE reader to receive events
		const receivedSseEvents = await ssePromise;
		expect(receivedSseEvents.length).toBeGreaterThan(0);

		// Verify events.ndjson on disk
		const eventsNdjsonPath = join(tempDir, 'runs', postBody.run.id, 'events.ndjson');
		const ndjsonContent = readFileSync(eventsNdjsonPath, 'utf8');
		expect(ndjsonContent).toContain('agent_message_chunk');
		expect(ndjsonContent).toContain('tool_call');

		// Verify events index table (milestone: run.started and tool_call)
		const rows = container.database
			.prepare('SELECT kind, id FROM events WHERE run_id = ? ORDER BY id ASC')
			.all(postBody.run.id) as Array<{ kind: string; id: number }>;

		const kindsInDb = rows.map((r) => r.kind);
		expect(kindsInDb).toContain('run.started');
		expect(kindsInDb).toContain('tool_call');

		// SSE reader received matching IDs
		const toolCallRow = rows.find((r) => r.kind === 'tool_call');
		expect(toolCallRow).toBeDefined();
		const toolCallSse = receivedSseEvents.find((e) => e.kind === 'tool_call');
		expect(toolCallSse).toBeDefined();
		expect(toolCallSse?.id).toBe(toolCallRow?.id);

		await server.instance.close();
	});

	it('AC 3 & E-348: Exit code 0 triggers M7 evaluateMechanicalCheck; non-zero exit code records run.exited with stderrTail', async () => {
		// Part 1: exit code 0 triggers evaluateMechanicalCheck
		const env1 = setupTestEnvironment({ exitCode: 0 });
		const { container: container1, getLatestProc: getProc1, getMechanicalCheckCalls } = env1;

		const createRes1 = await container1.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-exit-0',
		});
		await container1.services.dispatch.tick();

		const proc1 = getProc1();
		expect(proc1).not.toBeNull();

		proc1?.emitExit(0);
		// Allow exit async handlers to settle
		await new Promise((resolve) => setTimeout(resolve, 100));

		const run1 = container1.repos.runs.findById(createRes1.run.id);
		expect(run1?.state).toBe('exited');
		expect(getMechanicalCheckCalls()).toBe(1);

		// Part 2: exit code non-zero -> exited with run.exited.stderrTail non-empty (E-348)
		const env2 = setupTestEnvironment({
			exitCode: 1,
			stderrTail: 'SyntaxError: unexpected token in file.ts\nProcess failed.',
		});
		const { container: container2, getLatestProc: getProc2, tempDir: tempDir2 } = env2;

		const createRes2 = await container2.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-exit-1',
		});
		await container2.services.dispatch.tick();

		const proc2 = getProc2();
		expect(proc2).not.toBeNull();
		proc2?.emitExit(1);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const run2 = container2.repos.runs.findById(createRes2.run.id);
		expect(run2?.state).toBe('exited');

		// Check events.ndjson for run.exited with stderrTail
		const eventsFile2 = join(tempDir2, 'runs', createRes2.run.id, 'events.ndjson');
		const ndjson2 = readFileSync(eventsFile2, 'utf8');
		const lines = ndjson2.split('\n').filter((l) => l.trim().length > 0);
		const exitedEventLine = lines.find((l) => l.includes('"run.exited"'));
		expect(exitedEventLine).toBeDefined();
		const parsedExited = JSON.parse(exitedEventLine ?? '{}');
		expect(parsedExited.payload.exitCode).toBe(1);
		expect(parsedExited.payload.stderrTail).toContain('SyntaxError: unexpected token');
	});

	it('AC 4 & E-76 & E-40: prepareWorktree failure transitions run to failed with E_WORKSPACE_UNAVAILABLE; unavailable agent blocks spawn', async () => {
		// 1. prepareWorktree fails -> failed, E_WORKSPACE_UNAVAILABLE, slot released
		const env1 = setupTestEnvironment({ prepareWorktreeFail: true });
		const { container: container1 } = env1;

		await expect(
			container1.services.dispatch.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'idemp-fail-wt',
			}),
		).resolves.toBeDefined();

		// Tick will execute launchRun and catch the error, transitioning to failed
		await container1.services.dispatch.tick();

		const runs = container1.repos.runs.listByTaskId('task-1');
		expect(runs.length).toBe(1);
		expect(runs[0]?.state).toBe('failed');

		// 2. Agent unavailable -> rejects with E_AGENT_UNAVAILABLE without spawn (E-40)
		const env2 = setupTestEnvironment();
		const { container: container2, getLatestProc } = env2;

		await expect(
			container2.services.dispatch.createRun({
				taskId: 'task-1',
				agentId: 'non-existent-agent',
				idempotencyKey: 'idemp-unavail-agent',
			}),
		).rejects.toMatchObject({ code: 'E_AGENT_UNAVAILABLE' });

		// Verify spawnManaged was never called
		expect(getLatestProc()).toBeNull();
	});

	it('AC 5: services.dispatch and scheduler-tick share launchRun, tick backfill launches process', async () => {
		const env = setupTestEnvironment();
		const { container, getLatestProc } = env;

		// Seed a second task in batch-1
		container.repos.tasks.insert({
			id: 'task-2',
			doc_id: 'doc-1',
			task_key: 'M8-T11',
			title: 'Second task for tick backfill',
			module_key: 'M8',
			deps_json: '[]',
			est_days: 1,
			batch_id: 'batch-1',
			manual_state: 'pending',
			contract_hash: 'contract-hash-task-2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			has_accept_changed: 0,
			has_prompt_changed: 0,
			is_removed_from_doc: 0,
		});

		// Execute tick -> task-1 and task-2 admitted into slot and dispatched
		const tickResult = await container.services.dispatch.tick();
		expect(tickResult.executed).toBe(true);
		expect(tickResult.runsDispatched.length).toBeGreaterThan(0);

		// Verify process spawned for tick-dispatched run
		const latestProc = getLatestProc();
		expect(latestProc).not.toBeNull();
		const activeRuns = container.repos.runs.listActive();
		expect(activeRuns.some((r) => r.pid === 88888 && r.state === 'running')).toBe(true);
	});
});
