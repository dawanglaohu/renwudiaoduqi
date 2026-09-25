import type { ChildProcess, SpawnOptions, spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
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
import {
	type LaunchSpec,
	type ManagedProcess,
	type ProcessExitResult,
	spawnManaged,
} from '../../src/proc/spawn.ts';
import { createBaseSelector } from '../../src/workspace/base-select.ts';
import type {
	GitRunner,
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
	let exitResult: ProcessExitResult | undefined = undefined;
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
		get exitResult() {
			return exitResult;
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
		exitResult = result;
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
		readonly availableAgentIds?: readonly string[];
		readonly exitCode?: number;
		readonly stderrTail?: string;
		readonly spawnThrow?: boolean;
		readonly customSpawn?: typeof import('../../src/proc/spawn.ts').spawnManaged;
		readonly baseSelector?: import('../../src/workspace/base-select.ts').BaseSelector;
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
	const fakeSpawnManaged =
		overrides.customSpawn ??
		(((spec: LaunchSpec) => {
			if (overrides.spawnThrow) {
				throw new Error('Command failed to spawn');
			}
			latestFakeProc = createFakeProcess(spec, {
				exitCode: overrides.exitCode ?? 0,
				stderrTail: overrides.stderrTail ?? '',
			});
			return latestFakeProc.managed;
		}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged);

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

	const availableAgentIds = new Set(
		overrides.availableAgentIds ?? (overrides.codexAvailable === false ? [] : ['codex']),
	);
	const fakeAgentService = {
		start: async () => {},
		stop: async () => {},
		listAgents: async () =>
			Array.from(availableAgentIds).map((id) => ({ id, canDispatch: true, maxConcurrency: 2 })),
		getAvailability: (agentId: string) => {
			if (availableAgentIds.has(agentId)) {
				return { canDispatch: true, isReady: true, status: 'ready' };
			}
			return { canDispatch: false, isReady: false, status: 'not_found' };
		},
		listAgentModels: async () => ({ models: [], currentConfig: {} }),
		refreshLogin: async () => null,
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
		baseSelector: overrides.baseSelector,
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
		fakeWorktreeManager,
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
			mode: 'exec',
			model: 'gpt-5-preview; echo "hacked" &',
			permissionTier: 'workspaceWrite',
		});
		expect(latestProc?.lastLaunchSpec.file).toBe(expectedLaunchSpec.file);
		expect(latestProc?.lastLaunchSpec.args).toEqual(expectedLaunchSpec.args);
		expect(latestProc?.lastLaunchSpec.stdinMode).toBe('closed');
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

		let attempts1 = 0;
		while (!getProc1() && attempts1 < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts1++;
		}

		const proc1 = getProc1();
		expect(proc1).not.toBeNull();

		// Emit content event so that exit code 0 enters mechanical check (R3: 内容后退出才走既有机械检查路径)
		proc1?.emitLine(
			'{"method":"item/agentMessage/delta","params":{"delta":"Implementing task M8-T10..."}}',
		);
		await new Promise((r) => setTimeout(r, 20));

		proc1?.emitExit(0);
		let run1 = container1.repos.runs.findById(createRes1.run.id);
		for (let i = 0; i < 100 && (run1?.state !== 'exited' || getMechanicalCheckCalls() === 0); i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			run1 = container1.repos.runs.findById(createRes1.run.id);
		}
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

		let attempts2 = 0;
		while (!getProc2() && attempts2 < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts2++;
		}

		const proc2 = getProc2();
		expect(proc2).not.toBeNull();
		// Emit content before exit so it follows existing failed exit path
		proc2?.emitLine(
			'{"method":"item/agentMessage/delta","params":{"delta":"Implementing task M8-T10..."}}',
		);
		await new Promise((r) => setTimeout(r, 20));
		proc2?.emitExit(1);
		let run2 = container2.repos.runs.findById(createRes2.run.id);
		for (let i = 0; i < 100 && run2?.state !== 'exited'; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			run2 = container2.repos.runs.findById(createRes2.run.id);
		}
		expect(run2?.state).toBe('exited');

		// Check events.ndjson for run.exited with stderrTail
		const eventsFile2 = join(tempDir2, 'runs', createRes2.run.id, 'events.ndjson');
		let exitedEventLine: string | undefined;
		for (let i = 0; i < 100 && !exitedEventLine; i++) {
			const lines = readFileSync(eventsFile2, 'utf8')
				.split('\n')
				.filter((l) => l.trim().length > 0);
			exitedEventLine = lines.find((l) => l.includes('"run.exited"'));
			if (!exitedEventLine) await new Promise((resolve) => setTimeout(resolve, 20));
		}
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
		let latestProc = getLatestProc();
		let attempts = 0;
		while (!latestProc && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			latestProc = getLatestProc();
			attempts++;
		}
		expect(latestProc).not.toBeNull();
		const activeRuns = container.repos.runs.listActive();
		expect(activeRuns.some((r) => r.pid === 88888 && r.state === 'running')).toBe(true);
	});

	it('R1: real proc wiring: missing platform throws; bound container proc passes shell: false to spawn options', async () => {
		const dummySpec: LaunchSpec = {
			runId: 'run-r1-test',
			file: '/usr/bin/node',
			args: ['--version'],
			cwd: '/tmp',
		};

		// 1. Missing platform fails
		expect(() => {
			// @ts-expect-error missing platform
			spawnManaged(dummySpec, {});
		}).toThrow();

		// 2. Bound container proc has host platform and passes shell: false to spawn options
		let capturedSpawnOptions: SpawnOptions | null = null;
		const fakeSpawnFn = ((_file: string, _args: readonly string[], options: SpawnOptions) => {
			capturedSpawnOptions = options;
			return Object.assign(new EventEmitter(), {
				pid: 99999,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				stdin: new PassThrough(),
			}) as unknown as ChildProcess;
		}) as typeof nodeSpawn;

		const { tempDir, db, clock } = setupTestEnvironment();

		const realContainer = createContainer({
			config: createTestConfig(tempDir),
			database: db,
			hostInputs: { platform: 'linux', homedir: tempDir },
			lockAdapter: dummyLockAdapter,
			instanceLock: dummyLockHandle,
			clock,
		});
		realContainer.proc.spawnManaged(dummySpec, { spawnFn: fakeSpawnFn });

		expect(capturedSpawnOptions).toEqual(expect.objectContaining({ shell: false }));
	});

	it('R2: upstream output not in HEAD without explicit upstreamBranch throws E_UPSTREAM_BASE_MISSING, explains "下游 base 缺上游产出", does not create worktree', async () => {
		let worktreeCreated = false;
		const fakeWorktreeManager = {
			prepareWorktree: async (input: PrepareWorktreeInput): Promise<PrepareWorktreeResult> => {
				worktreeCreated = true;
				return {
					worktreePath: `/tmp/worktrees/${input.taskId}`,
					branchName: `task/${input.taskId}`,
					baseRef: input.baseRef ?? 'HEAD',
					isReused: false,
				};
			},
			prepareWrapupWorktree: async () => ({
				worktreePath: '/tmp/wrapup',
				branchName: 'wrapup/1',
				baseRef: 'HEAD',
				isReused: false,
			}),
		} as unknown as WorktreeManager;

		// GitRunner that reports upstream task branch as unmerged in HEAD
		const unmergedGitRunner: GitRunner = {
			run: async (args: readonly string[]) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha-upstream-tip', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		};

		const baseSelector = createBaseSelector({
			platform: 'linux',
			gitRunner: unmergedGitRunner,
			worktreeManager: fakeWorktreeManager,
			ids: { newId: () => 'sess-r2-1' },
		});

		const env = setupTestEnvironment({ baseSelector });
		const { container, clock } = env;

		// Seed upstream task (not landed)
		container.repos.tasks.insert({
			id: 'task-upstream',
			doc_id: 'doc-1',
			task_key: 'M8-T1',
			title: 'Upstream task',
			module_key: 'M8',
			deps_json: '[]',
			est_days: 1,
			batch_id: 'batch-1',
			manual_state: 'reviewing',
			contract_hash: 'hash-upstream',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			has_accept_changed: 0,
			has_prompt_changed: 0,
			is_removed_from_doc: 0,
		});

		// Seed downstream task depending on upstream task
		container.repos.tasks.insert({
			id: 'task-downstream',
			doc_id: 'doc-1',
			task_key: 'M8-T2',
			title: 'Downstream task',
			module_key: 'M8',
			deps_json: JSON.stringify(['M8-T1']),
			est_days: 1,
			batch_id: 'batch-1',
			manual_state: 'pending',
			contract_hash: 'hash-downstream',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			has_accept_changed: 0,
			has_prompt_changed: 0,
			is_removed_from_doc: 0,
		});

		// Create run without specifying upstreamBranch (default HEAD)
		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-downstream',
			agentId: 'codex',
			idempotencyKey: 'idemp-r2-reject',
		});

		// Wait for launchRun to execute and fail
		let run = container.repos.runs.findById(createRes.run.id);
		let attempts = 0;
		while (run?.state === 'starting' && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			run = container.repos.runs.findById(createRes.run.id);
			attempts++;
		}

		// Worktree was NOT created
		expect(worktreeCreated).toBe(false);

		// Run transitioned to failed with upstream_base_missing
		expect(run?.state).toBe('failed');
		expect(run?.queued_reason).toBe('upstream_base_missing');

		// Calling launchRun directly on a starting run rejects with E_UPSTREAM_BASE_MISSING (R2)
		const snapshot = container.repos.dispatchSnapshots?.takeSnapshotForTask({
			taskId: 'task-downstream',
			launchSpecJson: JSON.stringify({ baseRef: { kind: 'head' } }),
			createdAt: clock.now(),
		});
		expect(snapshot).toBeDefined();

		const directRunId = 'direct-run-r2';
		container.repos.runs.insert({
			id: directRunId,
			task_id: 'task-downstream',
			attempt_no: 2,
			kind: 'implement',
			parent_run_id: null,
			state: 'starting',
			review_verdict: null,
			agent_id: 'codex',
			model_name: null,
			reported_model: null,
			effort_tier: null,
			reported_effort: null,
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshot?.id ?? '',
			worktree_path: null,
			branch_name: null,
			pid: null,
			exit_code: null,
			exit_signal: null,
			vendor_session_ref: null,
			changed_file_count: null,
			token_usage_json: null,
			unmapped_event_count: 0,
			is_stall_suspected: 0,
			rework_count: 0,
			queued_reason: null,
			idempotency_key: 'idemp-direct-r2',
			actor_device_id: null,
			started_at: clock.now(),
			last_event_at: null,
			ended_at: null,
		});

		await expect(container.services.dispatch.launchRun(directRunId)).rejects.toMatchObject({
			code: 'E_UPSTREAM_BASE_MISSING',
			details: expect.objectContaining({
				reason: '下游 base 缺上游产出',
				availableUpstreamBases: expect.arrayContaining([
					expect.objectContaining({ kind: 'upstreamBranch', taskKey: 'M8-T1' }),
				]),
			}),
		});
	});

	it('R2: explicit upstreamBranch baseRef creates worktree from upstream branch and transitions to running', async () => {
		let capturedBaseRef: string | null = null;
		const fakeWorktreeManager = {
			prepareWorktree: async (input: PrepareWorktreeInput): Promise<PrepareWorktreeResult> => {
				capturedBaseRef = input.baseRef ?? null;
				return {
					worktreePath: `/tmp/worktrees/${input.taskId}`,
					branchName: `task/${input.taskId}`,
					baseRef: input.baseRef ?? 'HEAD',
					isReused: false,
				};
			},
			prepareWrapupWorktree: async () => ({
				worktreePath: '/tmp/wrapup',
				branchName: 'wrapup/1',
				baseRef: 'HEAD',
				isReused: false,
			}),
		} as unknown as WorktreeManager;

		const unmergedGitRunner: GitRunner = {
			run: async (args: readonly string[]) => {
				if (args[0] === 'rev-parse') {
					return { exitCode: 0, stdout: 'sha-upstream-tip', stderr: '' };
				}
				if (args[0] === 'merge-base') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				if (args[0] === 'diff') {
					return { exitCode: 1, stdout: '', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		};

		const baseSelector = createBaseSelector({
			platform: 'linux',
			gitRunner: unmergedGitRunner,
			worktreeManager: fakeWorktreeManager,
			ids: { newId: () => 'sess-r2-2' },
		});

		const env = setupTestEnvironment({ baseSelector });
		const { container, getLatestProc } = env;

		// Seed upstream task
		container.repos.tasks.insert({
			id: 'task-upstream-2',
			doc_id: 'doc-1',
			task_key: 'M8-T3',
			title: 'Upstream task 2',
			module_key: 'M8',
			deps_json: '[]',
			est_days: 1,
			batch_id: 'batch-1',
			manual_state: 'reviewing',
			contract_hash: 'hash-upstream-2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			has_accept_changed: 0,
			has_prompt_changed: 0,
			is_removed_from_doc: 0,
		});

		// Seed downstream task
		container.repos.tasks.insert({
			id: 'task-downstream-2',
			doc_id: 'doc-1',
			task_key: 'M8-T4',
			title: 'Downstream task 2',
			module_key: 'M8',
			deps_json: JSON.stringify(['M8-T3']),
			est_days: 1,
			batch_id: 'batch-1',
			manual_state: 'pending',
			contract_hash: 'hash-downstream-2',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
			has_accept_changed: 0,
			has_prompt_changed: 0,
			is_removed_from_doc: 0,
		});

		// Create run explicitly selecting upstreamBranch
		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-downstream-2',
			agentId: 'codex',
			baseRef: { kind: 'upstreamBranch', taskKey: 'M8-T3' },
			idempotencyKey: 'idemp-r2-pass',
		});

		await container.services.dispatch.tick();

		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts++;
		}

		// Worktree was created with upstream branch as baseRef
		expect(capturedBaseRef).toBe('task/M8-T3');

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('running');
		expect(run?.branch_name).toBe('task/M8-T4');
	});

	it('R3: E-348 zero output exit code 0 transitions exited -> reviewing -> awaiting_human, no mechanical check, releases lane, creates gate', async () => {
		const env = setupTestEnvironment({ exitCode: 0 });
		const { container, getLatestProc, getMechanicalCheckCalls } = env;

		// Set lane_no on task so clearing it produces a lane.released event
		container.repos.tasks.setLaneNo('task-1', 1);

		const busEvents: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => busEvents.push(event));

		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-r3-zero-0',
		});
		await container.services.dispatch.tick();

		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts++;
		}
		const proc = getLatestProc();
		expect(proc).not.toBeNull();

		// Exit code 0 WITHOUT producing content
		proc?.emitExit(0);
		attempts = 0;
		while (
			(container.repos.runs.findById(createRes.run.id)?.state !== 'awaiting_human' ||
				!busEvents.some((event) => event.kind === 'lane.released') ||
				!container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review')) &&
			attempts < 100
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('awaiting_human');
		expect(getMechanicalCheckCalls()).toBe(0);
		expect(run?.rework_count ?? 0).toBe(0);

		// Lane released
		const laneReleased = busEvents.find((e) => e.kind === 'lane.released');
		expect(laneReleased).toBeDefined();
		expect((laneReleased?.payload as { reason?: unknown } | undefined)?.reason).toBe(
			'awaiting_human',
		);

		// Gate created with context
		const gate = container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review');
		expect(gate).not.toBeNull();
		expect(gate?.state).toBe('waiting');
		expect(gate?.comment).toBe('exited_before_output');
	});

	it('R8-T97041355 AC 3 & E-36: structured model rejection transitions to failed directly, queued_reason is 派发失败·模型无效, releases lane, no gate, exit does NOT transition to awaiting_human', async () => {
		const env = setupTestEnvironment({ exitCode: 1 });
		const { container, getLatestProc, getMechanicalCheckCalls } = env;

		// Set lane_no on task so clearing it produces a lane.released event
		container.repos.tasks.setLaneNo('task-1', 1);

		const busEvents: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => busEvents.push(event));

		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			model: 'non-existent-model',
			idempotencyKey: 'idemp-model-rejected-integration',
		});
		await container.services.dispatch.tick();

		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts++;
		}
		const proc = getLatestProc();
		expect(proc).not.toBeNull();

		// Emit structured error line indicating model rejection
		proc?.emitLine(
			JSON.stringify({
				method: 'turn/failed',
				params: {
					turn: {
						model: 'non-existent-model',
						error: {
							code: 'model_not_found',
							message: 'The model non-existent-model does not exist',
						},
					},
				},
			}),
		);

		// Now the process exits
		proc?.emitExit(1);

		attempts = 0;
		while (container.repos.runs.findById(createRes.run.id)?.state !== 'failed' && attempts < 100) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('failed');
		expect(run?.queued_reason).toBe('派发失败·模型无效');
		expect(run?.rework_count ?? 0).toBe(0);
		expect(getMechanicalCheckCalls()).toBe(0);

		// Task lane_no must be cleared
		expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();

		// lane.released event emitted
		const laneReleased = busEvents.find((e) => e.kind === 'lane.released');
		expect(laneReleased).toBeDefined();

		// No review gate created
		const gate = container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review');
		expect(gate).toBeNull();
	});

	it('B1: POST rerun after exited_before_output creates a new run and launches its process', async () => {
		const env = setupTestEnvironment({ exitCode: 0 });
		const { container, getLatestProc } = env;
		const server = createHttpServer({ container });
		await server.instance.ready();
		const token = await getAuthToken(container);

		const original = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-b1-original',
		});

		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}
		getLatestProc()?.emitExit(0);

		attempts = 0;
		while (
			(container.repos.runs.findById(original.run.id)?.state !== 'awaiting_human' ||
				!container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review')) &&
			attempts < 50
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}
		expect(container.repos.runs.findById(original.run.id)?.queued_reason).toBe(
			'exited_before_output',
		);

		const response = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${original.run.id}/rerun`,
			headers: { authorization: token },
			payload: { idempotencyKey: 'idemp-b1-rerun' },
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body) as CreateRunResponse;
		expect(body.run.id).not.toBe(original.run.id);

		attempts = 0;
		let rerun = container.repos.runs.findById(body.run.id);
		while ((rerun?.state !== 'running' || rerun.pid === null) && attempts < 50) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			rerun = container.repos.runs.findById(body.run.id);
			attempts++;
		}

		expect(rerun?.state).toBe('running');
		expect(rerun?.pid).toBe(88888);
		expect(container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review')?.state).toBe(
			'decided',
		);
		const duplicate = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${original.run.id}/rerun`,
			headers: { authorization: token },
			payload: { idempotencyKey: 'idemp-b1-rerun' },
		});
		expect(duplicate.statusCode).toBe(200);
		expect((JSON.parse(duplicate.body) as CreateRunResponse).run.id).toBe(body.run.id);
		expect(container.repos.runs.listByTaskId('task-1')).toHaveLength(2);
		await server.instance.close();
	});

	it('B1: POST rerun for a failed run launches through the same process path', async () => {
		const env = setupTestEnvironment();
		const { container } = env;
		const server = createHttpServer({ container });
		await server.instance.ready();
		const token = await getAuthToken(container);

		const snapshotsRepo = container.repos.dispatchSnapshots;
		expect(snapshotsRepo).toBeDefined();
		if (!snapshotsRepo) {
			throw new Error('dispatchSnapshots repo is unavailable');
		}
		const snapshot = snapshotsRepo.takeSnapshotForTask({
			taskId: 'task-1',
			launchSpecJson: JSON.stringify({
				agentId: 'codex',
				model: 'gpt-5-rerun',
				permissionTier: 'workspaceWrite',
				baseRef: { kind: 'head' },
				worktreeMode: 'fresh',
			}),
			createdAt: env.clock.now(),
		});
		container.repos.runs.insert({
			id: 'failed-run-for-rerun',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'failed',
			agent_id: 'codex',
			model_name: 'gpt-5-rerun',
			permission_tier: 'workspaceWrite',
			snapshot_id: snapshot.id,
			idempotency_key: 'idemp-b1-failed-original',
			started_at: env.clock.now(),
			ended_at: env.clock.now(),
		});

		const response = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs/failed-run-for-rerun/rerun',
			headers: { authorization: token },
			payload: { idempotencyKey: 'idemp-b1-failed-rerun' },
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body) as CreateRunResponse;
		expect(body.run.id).not.toBe('failed-run-for-rerun');

		let attempts = 0;
		let rerun = container.repos.runs.findById(body.run.id);
		while ((rerun?.state !== 'running' || rerun.pid === null) && attempts < 50) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			rerun = container.repos.runs.findById(body.run.id);
			attempts++;
		}

		expect(rerun?.state).toBe('running');
		expect(rerun?.pid).toBe(88888);
		expect(rerun?.model_name).toBe('gpt-5-rerun');
		expect(rerun?.permission_tier).toBe('workspaceWrite');
		await server.instance.close();
	});

	it('B2: POST /runs reassigns an awaiting_human task to the selected agent and launches it', async () => {
		const env = setupTestEnvironment({ availableAgentIds: ['codex', 'claude'] });
		const { container, getLatestProc } = env;
		const server = createHttpServer({ container });
		await server.instance.ready();
		const token = await getAuthToken(container);

		const original = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-b2-original',
		});
		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}
		getLatestProc()?.emitExit(0);
		attempts = 0;
		while (
			(container.repos.runs.findById(original.run.id)?.state !== 'awaiting_human' ||
				!container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review')) &&
			attempts < 50
		) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			attempts++;
		}

		const response = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs',
			headers: { authorization: token },
			payload: {
				taskId: 'task-1',
				agentId: 'claude',
				model: 'claude-reassign-model',
				worktreeMode: 'fresh',
				idempotencyKey: 'idemp-b2-reassign',
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body) as CreateRunResponse;
		expect(body.run.id).not.toBe(original.run.id);

		attempts = 0;
		let reassigned = container.repos.runs.findById(body.run.id);
		while ((reassigned?.state !== 'running' || reassigned.pid === null) && attempts < 50) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			reassigned = container.repos.runs.findById(body.run.id);
			attempts++;
		}

		expect(reassigned?.agent_id).toBe('claude');
		expect(reassigned?.model_name).toBe('claude-reassign-model');
		expect(reassigned?.state).toBe('running');
		expect(reassigned?.pid).toBe(88888);
		expect(getLatestProc()?.lastLaunchSpec.file).toBe('claude');
		expect(container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review')?.state).toBe(
			'decided',
		);
		const duplicate = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs',
			headers: { authorization: token },
			payload: {
				taskId: 'task-1',
				agentId: 'claude',
				model: 'claude-reassign-model',
				idempotencyKey: 'idemp-b2-reassign',
			},
		});
		expect(duplicate.statusCode).toBe(200);
		expect((JSON.parse(duplicate.body) as CreateRunResponse).run.id).toBe(body.run.id);
		expect(container.repos.runs.listByTaskId('task-1')).toHaveLength(2);
		await server.instance.close();
	});

	it('R3: E-348 zero output exit code non-0 transitions to awaiting_human, no mechanical check, gate has stderrTail', async () => {
		const env = setupTestEnvironment({ exitCode: 1, stderrTail: 'Fatal: login token expired' });
		const { container, getLatestProc, getMechanicalCheckCalls, tempDir } = env;

		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-r3-zero-1',
		});
		await container.services.dispatch.tick();

		let attempts = 0;
		while (!getLatestProc() && attempts < 50) {
			await new Promise((r) => setTimeout(r, 20));
			attempts++;
		}
		const proc = getLatestProc();
		expect(proc).not.toBeNull();

		// Exit code 1 WITHOUT producing content
		proc?.emitExit(1);
		await new Promise((resolve) => setTimeout(resolve, 150));

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('awaiting_human');
		expect(getMechanicalCheckCalls()).toBe(0);

		const gate = container.repos.gates?.findLatestByTaskIdAndKind('task-1', 'review');
		expect(gate).not.toBeNull();
		expect(gate?.comment).toBe('exited_before_output');

		const eventsPath = join(tempDir, 'runs', createRes.run.id, 'events.ndjson');
		const exitedEvents = readFileSync(eventsPath, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { kind?: string; payload?: { stderrTail?: string } })
			.filter((event) => event.kind === 'run.exited');
		const exitedEvent = exitedEvents[exitedEvents.length - 1];
		expect(exitedEvent?.payload?.stderrTail).toContain('Fatal: login token expired');
	});

	it('R3: spawn throws error transitions starting -> failed with spawn_failed', async () => {
		const env = setupTestEnvironment({ spawnThrow: true });
		const { container } = env;

		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-r3-spawn-throw',
		});

		await container.services.dispatch.tick();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('failed');
		expect(run?.queued_reason).toBe('spawn_failed');
	});

	it('R3: premature exit while in starting state transitions starting -> failed', async () => {
		const prematureSpawn = ((spec: LaunchSpec) => {
			const fake = createFakeProcess(spec, { exitCode: 1 });
			// Exit immediately during spawn while state is starting
			fake.emitExit(1);
			return fake.managed;
		}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged;

		const env = setupTestEnvironment({ customSpawn: prematureSpawn });
		const { container } = env;

		const createRes = await container.services.dispatch.createRun({
			taskId: 'task-1',
			agentId: 'codex',
			idempotencyKey: 'idemp-r3-premature',
		});

		await container.services.dispatch.tick();
		await new Promise((resolve) => setTimeout(resolve, 100));

		const run = container.repos.runs.findById(createRes.run.id);
		expect(run?.state).toBe('failed');
		expect(run?.state).not.toBe('exited');
		expect(run?.state).not.toBe('reviewing');
		expect(run?.state).not.toBe('awaiting_human');
	});
});
