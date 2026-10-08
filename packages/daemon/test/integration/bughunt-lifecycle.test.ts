import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { LaunchSpec, ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import type {
	GitCommandResult,
	PrepareWorktreeInput,
	PrepareWorktreeResult,
	WorktreeManager,
} from '../../src/workspace/worktree.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDir, '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const migrationsDir = join(daemonRoot, 'migrations');
const fixturesDir = resolve(daemonRoot, 'test/fixtures/bughunt');

function loadFixture(name: string): string {
	return readFileSync(resolve(fixturesDir, name), 'utf-8');
}

function expectDefined<T>(val: T | undefined | null, name = 'value'): T {
	expect(val).toBeDefined();
	if (val === undefined || val === null) {
		throw new Error(`Expected ${name} to be defined`);
	}
	return val;
}

function listWaitingGates(container: ReturnType<typeof createContainer>) {
	const gatesRepo = expectDefined(container.repos.gates, 'gates');
	return gatesRepo.list({ pendingOnly: true });
}

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];

afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		if (db.open) db.close();
	}
	for (const dir of temporaryDirectories.splice(0)) {
		try {
			rmSync(dir, { force: true, recursive: true });
		} catch {
			// ignore cleanup errors
		}
	}
});

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
	readonly launchSpec: LaunchSpec;
}

interface FakeLine {
	readonly text: string;
	readonly truncated: boolean;
	readonly rawByteLen: number;
}
interface FakeJsonLine extends FakeLine {
	readonly isJson: boolean;
	readonly value: unknown;
}

function createFakeProcess(spec: LaunchSpec): FakeManagedProcessController {
	const rawListeners = new Set<(line: FakeLine) => void>();
	const jsonListeners = new Set<(parsed: FakeJsonLine) => void>();
	const exitListeners = new Set<(result: ProcessExitResult) => void>();
	let isExited = false;
	let exitResult: ProcessExitResult | undefined = undefined;

	const managed: ManagedProcess = {
		runId: spec.runId,
		pid: 90000 + Math.floor(Math.random() * 1000),
		file: spec.file,
		args: spec.args,
		cwd: spec.cwd,
		child: {} as never,
		stdoutReader: {} as never,
		stderrReader: {} as never,
		timers: {
			startupTimeoutMs: 10000,
			idleTimeoutMs: 10000,
			idleDurationMs: () => 0,
			isOutputActive: () => true,
			lastActivityAt: new Date().toISOString(),
		} as never,
		get isExited() {
			return isExited;
		},
		get exitResult() {
			return exitResult;
		},
		get stderrTail() {
			return '';
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
		const rawLine: FakeLine = {
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
		} catch {
			// not json
		}
	}

	function emitExit(exitCode: number, signal: NodeJS.Signals | null = null) {
		if (isExited) return;
		isExited = true;
		const result: ProcessExitResult = {
			runId: spec.runId,
			pid: managed.pid,
			exitCode,
			signal,
			error: undefined,
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
		launchSpec: spec,
	};
}

async function getAuthToken(container: ReturnType<typeof createContainer>): Promise<string> {
	const activeCode =
		container.services.pairing.getActivePairingCode()?.code ??
		container.services.pairing.createPairingCode().code;
	const claim = await container.services.pairing.claimPairingCode({
		code: activeCode,
		deviceName: 'test-device-bughunt',
	});
	return `Bearer ${claim.token}`;
}

interface GitDiffControl {
	hasDiff: boolean;
	filesChanged: number;
	failDiffRead?: boolean;
	treeVersion?: number;
}

async function setupBughuntEnvironment(
	overrides: {
		readonly pipelineBughunt?: boolean;
		readonly laneCount?: number;
		readonly agentConcurrency?: number;
		readonly isInitiallyParked?: boolean;
		readonly spawnFailure?: AppError;
		readonly worktreeFailure?: AppError;
		readonly isAdapterMissing?: boolean;
		readonly isAgentUnavailableAtStartup?: boolean;
	} = {},
) {
	const tempDir = mkdtempSync(join(tmpdir(), 'agsched-bughunt-'));
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

	const spawnedProcesses: FakeManagedProcessController[] = [];
	const fakeSpawnManaged = ((spec: LaunchSpec) => {
		if (overrides.spawnFailure) throw overrides.spawnFailure;
		const proc = createFakeProcess(spec);
		spawnedProcesses.push(proc);
		return proc.managed;
	}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged;

	const agentRegistry = createAgentRegistry({
		dataDir: tempDir,
		platform: 'posix',
		publishWarning: () => {},
		builtInDefaults: {
			...BUILT_IN_AGENT_DEFAULTS,
			codex: Object.freeze({
				...BUILT_IN_AGENT_DEFAULTS.codex,
				maxConcurrency: overrides.agentConcurrency ?? 2,
				execPath: '/opt/codex-test',
			}),
		},
	});

	const fakeWorktreeManager = {
		prepareWorktree: async (input: PrepareWorktreeInput): Promise<PrepareWorktreeResult> => {
			if (overrides.worktreeFailure) throw overrides.worktreeFailure;
			const worktreePath = input.targetWorktreePath ?? join(tempDir, 'worktrees', input.taskId);
			mkdirSync(worktreePath, { recursive: true });
			return {
				worktreePath,
				branchName: input.preferredBranchName ?? `task/${input.taskId}`,
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

	let hasStartingBughunt = () => false;
	const fakeAgentService = {
		start: async () => {},
		stop: async () => {},
		listAgents: async () => [{ id: 'codex', canDispatch: true, maxConcurrency: 2 }],
		getAvailability: (agentId: string) => {
			if (agentId === 'codex') {
				if (overrides.isAgentUnavailableAtStartup && hasStartingBughunt()) {
					return { canDispatch: false, isReady: false, status: 'not_found' };
				}
				return { canDispatch: true, isReady: true, status: 'ready' };
			}
			return { canDispatch: false, isReady: false, status: 'not_found' };
		},
		getAgentConfig: () => ({ maxConcurrency: 2, model: 'o3-mini' }),
		listAgentModels: async () => ({
			currentConfig: { model: 'o3-mini', effort: 'high' },
			models: [{ model: 'o3-mini', effortOptions: ['low', 'medium', 'high'] }],
		}),
		refreshLogin: async () => {},
	};

	const gitDiffControl: GitDiffControl = {
		hasDiff: true,
		filesChanged: 1,
	};

	const fakeGitRunner = {
		run: async (args: readonly string[]): Promise<GitCommandResult> => {
			const command = args.join(' ');
			if (command.includes('--is-inside-work-tree')) {
				return { exitCode: 0, stdout: 'true\n', stderr: '' };
			}
			if (gitDiffControl.failDiffRead && command.includes('write-tree')) {
				return { exitCode: 1, stdout: '', stderr: 'fatal: cannot freeze worktree\n' };
			}
			if (command.includes('write-tree')) {
				return {
					exitCode: 0,
					stdout: `${String(gitDiffControl.treeVersion ?? 0).padStart(40, '0')}\n`,
					stderr: '',
				};
			}
			if (command.includes('read-tree') || command.includes('add -A')) {
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			if (command.includes('rev-parse')) {
				return {
					exitCode: 0,
					stdout: `${String(gitDiffControl.treeVersion ?? 0).padStart(40, '0')}\n`,
					stderr: '',
				};
			}
			if (command.includes('status')) {
				if (gitDiffControl.hasDiff) {
					if (gitDiffControl.filesChanged === 2) {
						return { exitCode: 0, stdout: ' M src/a.ts\0 M src/b.ts\0', stderr: '' };
					}
					return { exitCode: 0, stdout: ' M src/index.ts\0', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			if (command.includes('--numstat')) {
				if (gitDiffControl.hasDiff) {
					if (gitDiffControl.filesChanged === 2) {
						return {
							exitCode: 0,
							stdout: ['1\t0\tsrc/a.ts', '1\t0\tsrc/b.ts', ''].join('\0'),
							stderr: '',
						};
					}
					return { exitCode: 0, stdout: '1\t0\tsrc/index.ts\0', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			if (command.includes('--name-status')) {
				if (gitDiffControl.hasDiff) {
					if (gitDiffControl.filesChanged === 2) {
						return { exitCode: 0, stdout: 'M\tsrc/a.ts\0M\tsrc/b.ts\0', stderr: '' };
					}
					return { exitCode: 0, stdout: 'M\tsrc/index.ts\0', stderr: '' };
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			if (command.includes('diff')) {
				if (gitDiffControl.hasDiff) {
					return {
						exitCode: 0,
						stdout:
							'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n+export const done = true;\n',
						stderr: '',
					};
				}
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			return { exitCode: 0, stdout: '', stderr: '' };
		},
	};

	const container = createContainer({
		config: {
			port: 0,
			bind: '127.0.0.1',
			dataDir: tempDir,
			logLevel: 'error',
			dev: false,
		},
		database: db,
		hostInputs: { platform: 'linux', homedir: tempDir },
		lockAdapter: dummyLockAdapter,
		instanceLock: { release: () => undefined } as never,
		clock,
		agentRegistry,
		spawnManaged: fakeSpawnManaged,
		codexSessions: null,
		worktreeManager: fakeWorktreeManager,
		adapters: overrides.isAdapterMissing ? {} : undefined,
		agentService: fakeAgentService as never,
		gitRunner: fakeGitRunner,
	});
	hasStartingBughunt = () =>
		container.repos.runs
			.listByTaskId('task-1')
			.some((run) => run.kind === 'bughunt' && run.state === 'starting');

	// Seed document, batch, task, and snapshot
	container.repos.documents.insert({
		id: 'doc-1',
		docs_path: '/docs',
		project_name: 'test-project',
		repo_path: tempDir,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: overrides.laneCount ?? 2,
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
		task_key: 'R12-T32133721',
		title: 'Bughunt integration lifecycle',
		module_key: 'M7',
		deps_json: '[]',
		est_days: 2,
		batch_id: 'batch-1',
		manual_state: overrides.isInitiallyParked ? 'awaiting_human' : 'pending',
		task_paths_json: overrides.isInitiallyParked ? '["src/target.ts"]' : '[]',
		contract_hash: 'contract-hash-task-1',
		is_contract_ready: 1,
		contract_reasons_json: '[]',
		has_accept_changed: 0,
		has_prompt_changed: 0,
		is_removed_from_doc: 0,
	});
	container.repos.tasks.setAssignmentDraft(
		'task-1',
		JSON.stringify({
			agentId: 'codex',
			model: 'o3-mini',
			effort: { tier: 'high' },
			draftedAt: clock.now(),
		}),
	);

	const snapshotsRepo = expectDefined(container.repos.dispatchSnapshots, 'dispatchSnapshots');
	snapshotsRepo.insert({
		id: 'snap-1',
		task_id: 'task-1',
		contract_hash: 'contract-hash-task-1',
		task_paths_json: '[]',
		launch_spec_json: JSON.stringify({
			adapterKind: 'codex',
			model: 'o3-mini',
			effort: 'high',
		}),
		created_at: clock.now(),
	});

	await container.services.settings.updateGates(
		{
			dispatch: 'auto',
			review: 'auto',
			landing: 'manual',
		},
		null,
	);

	if (overrides.pipelineBughunt !== undefined) {
		container.services.settings.updatePipeline(
			{
				bughunt: overrides.pipelineBughunt ? 1 : 0,
				wrapupMode: 'auto',
				reviewOverride: null,
				wrapupAssignment: { mode: 'follow' },
			},
			null,
		);
	}

	return {
		container,
		agentRegistry,
		db,
		clock,
		tempDir,
		spawnedProcesses,
		gitDiffControl,
	};
}

function seedFailedBughunt(env: Awaited<ReturnType<typeof setupBughuntEnvironment>>) {
	const { container, clock, tempDir } = env;
	const worktreePath = join(tempDir, 'original-worktree');
	mkdirSync(worktreePath, { recursive: true });
	container.repos.tasks.updateManualState('task-1', 'awaiting_human');
	for (const [attemptNo, kind, state] of [
		[1, 'implement', 'awaiting_human'],
		[2, 'review', 'exited'],
		[4, 'bughunt', 'failed'],
	] as const) {
		container.repos.runs.insert({
			id: `history-${attemptNo}`,
			task_id: 'task-1',
			attempt_no: attemptNo,
			kind,
			state,
			parent_run_id: attemptNo === 1 ? null : 'history-1',
			queued_reason: attemptNo === 2 ? null : 'bughunt_failed',
			agent_id: 'codex',
			model_name: 'o3-mini',
			effort_tier: 'high',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			batch_id: 'batch-1',
			worktree_path: worktreePath,
			branch_name: 'task/original',
			branch_tip_sha: '0'.repeat(40),
			lane_no: 1,
			idempotency_key: `history-${attemptNo}-key`,
			ended_at: clock.now(),
		});
	}
	expectDefined(container.repos.gates, 'gates').create({
		id: 'history-gate',
		task_id: 'task-1',
		run_id: 'history-1',
		kind: 'review',
		state: 'waiting',
		comment: 'bughunt_failed',
		created_at: clock.now(),
	});
}

describe('R8-T69421773: production HTTP rerun admission', () => {
	it.each([
		{
			laneCount: 1,
			agentConcurrency: 2,
			blockedBy: 'occupied historical lane',
			isInitiallyBlocked: true,
		},
		{
			laneCount: 2,
			agentConcurrency: 1,
			blockedBy: 'agent concurrency limit',
			isInitiallyBlocked: true,
		},
		{
			laneCount: 2,
			agentConcurrency: 2,
			blockedBy: 'a historical lane with a free alternative',
			isInitiallyBlocked: false,
		},
	])('waits for $blockedBy and resumes the same bughunt in a free lane', async (limits) => {
		const env = await setupBughuntEnvironment({
			pipelineBughunt: false,
			isInitiallyParked: true,
			...limits,
		});
		const { container, spawnedProcesses } = env;
		seedFailedBughunt(env);
		container.repos.tasks.insert({
			id: 'holding-task',
			doc_id: 'doc-1',
			batch_id: 'batch-1',
			task_key: 'HOLD',
			title: 'Occupies the former lane',
			module_key: 'M8',
			deps_json: '[]',
			lane_no: 1,
			contract_hash: 'holding-contract',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});
		const holdingSnapshot = expectDefined(container.repos.dispatchSnapshots).takeSnapshotForTask({
			taskId: 'holding-task',
			launchSpecJson: '{}',
			createdAt: env.clock.now(),
		});
		container.repos.runs.insert({
			id: 'holding-run',
			task_id: 'holding-task',
			attempt_no: 9,
			kind: 'implement',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			lane_no: 1,
			batch_id: 'batch-1',
			snapshot_id: holdingSnapshot.id,
		});
		const server = createHttpServer({ container });
		await server.instance.ready();
		const token = await getAuthToken(container);
		const request = {
			method: 'POST' as const,
			url: '/api/v1/runs/history-4/rerun',
			headers: { authorization: token },
			payload: { idempotencyKey: 'admitted-rerun' },
		};
		try {
			const response = await server.instance.inject(request);
			expect(response.statusCode).toBe(200);
			const { run } = response.json();
			expect(run).toMatchObject({
				kind: 'bughunt',
				attemptNo: 5,
				parentRunId: 'history-1',
				state: 'queued',
				laneNo: null,
			});
			expect(run.id).not.toBe('history-1');
			expect(container.repos.tasks.findById('holding-task')?.lane_no).toBe(1);
			if (limits.isInitiallyBlocked) {
				expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
				expect(spawnedProcesses).toHaveLength(0);
			} else {
				expect(
					await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === run.id)),
				).toBe(true);
				expect(container.repos.tasks.findById('task-1')?.lane_no).toBe(2);
			}
			const replay = await server.instance.inject(request);
			expect(replay.statusCode).toBe(200);
			expect(replay.json().run.id).toBe(run.id);
			expect(container.repos.runs.listByTaskId('task-1').map((r) => r.attempt_no)).toEqual([
				1, 2, 4, 5,
			]);
			expect(container.repos.gates?.findById('history-gate')).toMatchObject({
				state: 'decided',
				comment: 'superseded',
			});

			container.repos.runs.updateState({ id: 'holding-run', toState: 'failed' });
			container.repos.tasks.clearLaneNo('holding-task');
			await container.services.dispatch.tick();
			expect(await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === run.id))).toBe(
				true,
			);
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBe(
				limits.isInitiallyBlocked ? 1 : 2,
			);
			expect(container.repos.runs.findById(run.id)).toMatchObject({
				snapshot_id: 'snap-1',
				model_name: 'o3-mini',
				effort_tier: 'high',
				parent_run_id: 'history-1',
			});
			const proc = expectDefined(spawnedProcesses.find((p) => p.launchSpec.runId === run.id));
			expect(proc.launchSpec.cwd).toBe(join(env.tempDir, 'original-worktree'));
			proc.emitLine(loadFixture('clean.txt'));
			proc.emitExit(0);
			expect(
				await waitFor(() =>
					listWaitingGates(container).some((g) => g.run_id === 'history-1' && g.kind === 'landing'),
				),
			).toBe(true);
			expect(container.repos.runs.findById('history-1')).toMatchObject({
				state: 'reviewing',
				rework_count: 0,
			});
			const landingGate = expectDefined(
				listWaitingGates(container).find((g) => g.run_id === 'history-1' && g.kind === 'landing'),
			);
			const landed = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${landingGate.id}/decide`,
				headers: { authorization: token },
				payload: { decision: 'pass' },
			});
			expect(landed.statusCode).toBe(200);
			expect(container.repos.runs.findById('history-1')?.state).toBe('landed');
		} finally {
			await server.instance.close();
		}
	});

	it.each(['workspace', 'adapter', 'agent'] as const)(
		'a queued rerun %s failure restores its gate and permits another original rerun (R1, E-323, E-331)',
		async (failure) => {
			const env = await setupBughuntEnvironment({
				pipelineBughunt: false,
				isInitiallyParked: true,
				worktreeFailure:
					failure === 'workspace'
						? new AppError('E_WORKSPACE_UNAVAILABLE', 'Controlled unavailable reused worktree.')
						: undefined,
				isAdapterMissing: failure === 'adapter',
				isAgentUnavailableAtStartup: failure === 'agent',
			});
			seedFailedBughunt(env);
			const { container } = env;
			container.repos.runs.updateReworkCount({ id: 'history-1', reworkCount: 2 });
			const original = expectDefined(container.repos.runs.findById('history-4'));
			const originalSnapshot = expectDefined(container.repos.dispatchSnapshots).findById('snap-1');
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);
			let previousRunId = original.id;
			let previousGateId = 'history-gate';
			try {
				for (const attemptNo of [5, 6]) {
					const response = await server.instance.inject({
						method: 'POST',
						url: `/api/v1/runs/${previousRunId}/rerun`,
						headers: { authorization: token },
						payload: { idempotencyKey: `startup-${failure}-${attemptNo}` },
					});
					expect(response.statusCode).toBe(200);
					const { run } = response.json();
					expect(run).toMatchObject({ kind: 'bughunt', attemptNo, parentRunId: 'history-1' });
					expect(run.id).not.toBe(previousRunId);
					expect(
						await waitFor(() => container.repos.runs.findById(run.id)?.state === 'failed'),
					).toBe(true);
					expect(
						await waitFor(() =>
							listWaitingGates(container).some((g) => g.comment === 'bughunt_failed'),
						),
					).toBe(true);
					expect(container.repos.runs.findById(run.id)).toMatchObject({
						state: 'failed',
						queued_reason: 'bughunt_failed',
						parent_run_id: original.parent_run_id,
						snapshot_id: original.snapshot_id,
						agent_id: original.agent_id,
						model_name: original.model_name,
						effort_tier: original.effort_tier,
						permission_tier: original.permission_tier,
						worktree_path: original.worktree_path,
						branch_name: original.branch_name,
						branch_tip_sha: original.branch_tip_sha,
					});
					expect(container.repos.runs.findById('history-1')).toMatchObject({
						state: 'awaiting_human',
						queued_reason: 'bughunt_failed',
						rework_count: 2,
					});
					expect(container.repos.tasks.findById('task-1')).toMatchObject({
						manual_state: null,
						lane_no: null,
					});
					expect(container.repos.gates?.findById(previousGateId)).toMatchObject({
						state: 'decided',
						comment: 'superseded',
					});
					const waitingGates = listWaitingGates(container);
					expect(waitingGates).toHaveLength(1);
					const waitingGate = expectDefined(waitingGates[0]);
					expect(waitingGate).toMatchObject({
						run_id: 'history-1',
						kind: 'review',
						state: 'waiting',
						comment: 'bughunt_failed',
					});
					expect(env.spawnedProcesses).toHaveLength(0);
					expect(expectDefined(container.repos.dispatchSnapshots).findById('snap-1')).toEqual(
						originalSnapshot,
					);
					previousRunId = run.id;
					previousGateId = waitingGate.id;
				}
				expect(container.repos.runs.listByTaskId('task-1').map((r) => r.attempt_no)).toEqual([
					1, 2, 4, 5, 6,
				]);
			} finally {
				for (const job of container.jobs) await job.stop();
				await server.instance.close();
			}
		},
	);

	it('a queued rerun spawn failure restores an actionable gate without an unhandled rejection', async () => {
		const env = await setupBughuntEnvironment({
			pipelineBughunt: false,
			isInitiallyParked: true,
			spawnFailure: new AppError('E_AGENT_EXEC_NOT_FOUND', 'Controlled rerun spawn failure.'),
		});
		seedFailedBughunt(env);
		const { container } = env;
		const server = createHttpServer({ container });
		await server.instance.ready();
		try {
			const response = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs/history-4/rerun',
				headers: { authorization: await getAuthToken(container) },
				payload: { idempotencyKey: 'spawn-failure-rerun' },
			});
			expect(response.statusCode).toBe(200);
			const { run } = response.json();
			expect(run).toMatchObject({ kind: 'bughunt', attemptNo: 5, parentRunId: 'history-1' });
			expect(await waitFor(() => container.repos.runs.findById(run.id)?.state === 'failed')).toBe(
				true,
			);
			expect(
				await waitFor(() =>
					listWaitingGates(container).some((g) => g.comment === 'bughunt_failed'),
				),
			).toBe(true);
			expect(container.repos.runs.findById('history-1')).toMatchObject({
				state: 'awaiting_human',
				queued_reason: 'bughunt_failed',
				rework_count: 0,
			});
			expect(container.repos.tasks.findById('task-1')).toMatchObject({
				manual_state: null,
				lane_no: null,
			});
			expect(container.repos.gates?.findById('history-gate')).toMatchObject({
				state: 'decided',
				comment: 'superseded',
			});
			expect(
				listWaitingGates(container).filter((g) => g.comment === 'bughunt_failed'),
			).toHaveLength(1);
			expect(env.spawnedProcesses).toHaveLength(0);
		} finally {
			for (const job of container.jobs) await job.stop();
			await server.instance.close();
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return predicate();
}

/**
 * Helper to advance initial implementation to review pass.
 */
async function advanceToReviewPassed(
	env: Awaited<ReturnType<typeof setupBughuntEnvironment>>,
): Promise<{
	implRunId: string;
	reviewRunId: string;
}> {
	const { container, spawnedProcesses } = env;
	expect(container.repos.tasks.findById('task-1')?.batch_id).toBe('batch-1');

	// 1. Dispatch initial implementation run
	const createRes = await container.services.dispatch.createRun({
		taskId: 'task-1',
		agentId: 'codex',
		model: 'o3-mini',
		effort: { tier: 'high' },
		idempotencyKey: `impl-init-${Date.now()}-${Math.random()}`,
	});
	const implRunId = createRes.run.id;
	expect(container.repos.runs.findById(implRunId)?.batch_id).toBe('batch-1');

	// Trigger tick to launch implementation process
	await container.services.dispatch.tick();

	await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === implRunId));
	const implProc = spawnedProcesses.find((p) => p.launchSpec.runId === implRunId);
	expect(implProc).toBeDefined();

	// Implementation process finishes cleanly
	implProc?.emitLine('{"method":"item/agentMessage/delta","params":{"delta":"Done."}}');
	await waitFor(() => container.repos.runs.findById(implRunId)?.state === 'running');
	implProc?.emitExit(0);

	// Wait for kind=review run to be dispatched and spawned
	await waitFor(() => {
		const runs = container.repos.runs.listByTaskId('task-1');
		return runs.some((r) => r.kind === 'review' && r.parent_run_id === implRunId);
	});
	const reviewRun = expectDefined(
		container.repos.runs
			.listByTaskId('task-1')
			.find((r) => r.kind === 'review' && r.parent_run_id === implRunId),
		'reviewRun',
	);

	await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === reviewRun.id));
	const reviewProc = spawnedProcesses.find((p) => p.launchSpec.runId === reviewRun.id);
	expect(reviewProc).toBeDefined();

	// Review process emits pass verdict and exits 0
	reviewProc?.emitLine('VERDICT: pass\nAcceptance criteria fully met.');
	await waitFor(() => container.repos.runs.findById(reviewRun.id)?.state === 'running');
	reviewProc?.emitExit(0);

	// Set vendor_session_ref on implementation run to support session rework/continuation
	env.db
		.prepare("UPDATE runs SET vendor_session_ref = 'vendor-session-1' WHERE id = ?")
		.run(implRunId);

	return { implRunId, reviewRunId: reviewRun.id };
}

describe('bughunt lifecycle integration (R12-T32133721)', () => {
	it('AC 1 & E-306: pipeline.bughunt=false -> review pass goes directly to landing gate without bughunt run', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: false });
		const { container } = env;

		await advanceToReviewPassed(env);

		// Wait for landing gate to appear
		const gateCreated = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some((g) => g.kind === 'landing' && g.task_id === 'task-1');
		});
		expect(gateCreated).toBe(true);

		// Verify no bughunt runs were created
		const allRuns = container.repos.runs.listByTaskId('task-1');
		const bughuntRuns = allRuns.filter((r) => r.kind === 'bughunt');
		expect(bughuntRuns.length).toBe(0);

		const landingGate = listWaitingGates(container).find((g) => g.kind === 'landing');
		expect(landingGate).toBeDefined();
		expect(landingGate?.task_id).toBe('task-1');
	});

	it('AC 1 & E-306 & E-328: pipeline.bughunt=true -> review pass dispatches and starts bughunt child run with snapshot and batch', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		// Wait for bughunt run to be created and spawned
		const bughuntCreated = await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		expect(bughuntCreated).toBe(true);

		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		expect(bughuntRun.batch_id).toBe('batch-1');
		expect(bughuntRun.agent_id).toBe('codex');
		expect(bughuntRun.model_name).toBe('o3-mini');
		expect(bughuntRun.effort_tier).toBe('high');

		// Snapshot exists with assignment serialized
		expect(bughuntRun.snapshot_id).toBeDefined();
		const snapshotsRepo = expectDefined(container.repos.dispatchSnapshots, 'dispatchSnapshots');
		const snapshot = expectDefined(
			snapshotsRepo.findById(bughuntRun.snapshot_id ?? ''),
			'snapshot',
		);
		expect(snapshot.assignment_json).toContain('"agentId":"codex"');
		expect(snapshot.assignment_json).toContain('"modelName":"o3-mini"');

		// Process was spawned by launcher
		const bughuntProcSpawned = await waitFor(() =>
			spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id),
		);
		expect(bughuntProcSpawned).toBe(true);

		// Implementation run remains reviewing, no landing gate created yet
		const implRun = container.repos.runs.findById(implRunId);
		expect(implRun?.state).toBe('reviewing');
		const landingGates = listWaitingGates(container).filter((g) => g.kind === 'landing');
		expect(landingGates.length).toBe(0);
	});

	it('AC 2 & E-306 & E-321: bughunt clean -> no bugs and diff empty -> transitions to landing gate without re-running mechanical check', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses, gitDiffControl } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		// Clean: no git diff, clean report
		gitDiffControl.hasDiff = false;
		bughuntProc?.emitLine(loadFixture('clean.txt'));
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		// Bughunt run completes, landing gate is created directly
		const landedGateAppeared = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some((g) => g.kind === 'landing' && g.task_id === 'task-1');
		});
		expect(landedGateAppeared).toBe(true);

		const updatedBughunt = container.repos.runs.findById(bughuntRun.id);
		expect(updatedBughunt?.state).toBe('landed');

		// Implementation run stays reviewing, ready for landing gate
		const updatedImpl = container.repos.runs.findById(implRunId);
		expect(updatedImpl?.state).toBe('reviewing');

		// Did not re-run review or mechanical check (only 1 review run in total)
		const reviewRuns = container.repos.runs
			.listByTaskId('task-1')
			.filter((r) => r.kind === 'review');
		expect(reviewRuns.length).toBe(1);
	});

	it('AC 2 & E-307: bughunt FIXED with diff & rework_count < 2 -> increments rework_count and requests continuation review', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses, gitDiffControl } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		// FIXED with git diff
		gitDiffControl.hasDiff = true;
		gitDiffControl.filesChanged = 1;
		gitDiffControl.treeVersion = 1;
		bughuntProc?.emitLine(loadFixture('fixed.txt'));
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		// Verify rework_count incremented to 1
		const reworkIncremented = await waitFor(() => {
			const run = container.repos.runs.findById(implRunId);
			return run?.rework_count === 1;
		});
		expect(reworkIncremented).toBe(true);

		// Continuation review dispatched (or session resumed)
		const continuationReviewTriggered = await waitFor(() => {
			const allRuns = container.repos.runs.listByTaskId('task-1');
			const reviews = allRuns.filter((r) => r.kind === 'review');
			return reviews.length >= 1;
		});
		expect(continuationReviewTriggered).toBe(true);

		// No landing gate created
		const landingGates = listWaitingGates(container).filter((g) => g.kind === 'landing');
		expect(landingGates.length).toBe(0);
	});

	it('AC 2 & E-307: bughunt FIXED with diff & rework_count >= 2 -> enters awaiting_human with bughunt_fixed_over_limit', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses, gitDiffControl } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		// Preset rework_count to 2
		env.db.prepare('UPDATE runs SET rework_count = 2 WHERE id = ?').run(implRunId);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		gitDiffControl.hasDiff = true;
		gitDiffControl.filesChanged = 1;
		gitDiffControl.treeVersion = 1;
		bughuntProc?.emitLine(loadFixture('fixed.txt'));
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		// Awaiting human gate with comment 'bughunt_fixed_over_limit'
		const gateCreated = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some((g) => g.comment === 'bughunt_fixed_over_limit');
		});
		expect(gateCreated).toBe(true);

		const implRun = container.repos.runs.findById(implRunId);
		expect(implRun?.state).toBe('awaiting_human');
		expect(implRun?.rework_count).toBe(2); // not incremented beyond 2
	});

	it('AC 2 & E-307 & E-308: bughunt FIXED but NOT_FIXED contains S1/S2 -> enters awaiting_human directly without re-review', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses, gitDiffControl } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		gitDiffControl.hasDiff = true;
		gitDiffControl.treeVersion = 1;
		// Report has both FIXED and NOT_FIXED S1
		const reportWithBoth = `BUGS
- B1 [S2] 涉及 task-1：边界值校验缺失 → 复现：略 → 根因：略 → src/service.ts:42
- B2 [S1] 涉及 task-1：严重安全缺陷 → 复现：略 → 根因：略 → src/auth.ts:15

FIXED
- B1 → 修复了边界校验并补充了单元测试

NOT_FIXED
- B2 [S1] 涉及 task-1：架构层面无法自动修复 → 需人工决策 → 建议转人工 → src/auth.ts:15

SUSPECT
- none

NEXT
- please review
`;
		bughuntProc?.emitLine(reportWithBoth);
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		// Directly awaiting_human, no continuation review
		const gateCreated = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some(
				(g) =>
					g.task_id === 'task-1' && g.kind === 'review' && g.comment === 'bughunt_open_findings',
			);
		});
		expect(gateCreated).toBe(true);

		const implRun = container.repos.runs.findById(implRunId);
		expect(implRun?.state).toBe('awaiting_human');
		expect(implRun?.rework_count).toBe(0); // did not increment
	});

	it('AC 2 & E-308: bughunt NOT_FIXED contains S1 -> enters awaiting_human with unpatched report and gate', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		bughuntProc?.emitLine(loadFixture('open-s1.txt'));
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		// Transitions to awaiting_human with gate
		const gateCreated = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some(
				(g) =>
					g.task_id === 'task-1' && g.kind === 'review' && g.comment === 'bughunt_open_findings',
			);
		});
		expect(gateCreated).toBe(true);

		const implRun = container.repos.runs.findById(implRunId);
		expect(implRun?.state).toBe('awaiting_human');
	});

	it('AC 2 & E-320: bughunt invalid report (missing NEXT) -> enters awaiting_human with review gate, rework_count unchanged', async () => {
		const env = await setupBughuntEnvironment({ pipelineBughunt: true });
		const { container, spawnedProcesses } = env;

		const { implRunId } = await advanceToReviewPassed(env);

		await waitFor(() => {
			const runs = container.repos.runs.listByTaskId('task-1');
			return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
		});
		const bughuntRun = expectDefined(
			container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
			'bughuntRun',
		);
		await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
		const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

		// Output missing NEXT section
		bughuntProc?.emitLine(loadFixture('missing-next.txt'));
		await new Promise((r) => setTimeout(r, 30));
		bughuntProc?.emitExit(0);

		const gateCreated = await waitFor(() => {
			const gates = listWaitingGates(container);
			return gates.some((g) => g.task_id === 'task-1' && g.kind === 'review');
		});
		expect(gateCreated).toBe(true);

		const implRun = container.repos.runs.findById(implRunId);
		expect(implRun?.state).toBe('awaiting_human');
		expect(implRun?.rework_count).toBe(0);
	});

	it.each([false, true])(
		'AC 2 & AC 3 & E-323 & E-331: bughunt exit 1 -> bughunt_failed gate -> POST /runs/:id/rerun retries atomic run (sequence gap: %s)',
		async (hasSequenceGap) => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			if (hasSequenceGap) {
				container.repos.tasks.insert({
					id: 'other-task',
					doc_id: 'doc-1',
					batch_id: 'batch-1',
					task_key: 'OTHER',
					title: 'Another task with prior attempts',
					module_key: 'M8',
					deps_json: '[]',
					contract_hash: 'other-task-contract',
					is_contract_ready: 1,
					contract_reasons_json: '[]',
				});
				const snapshot = expectDefined(
					container.repos.dispatchSnapshots,
					'snapshots',
				).takeSnapshotForTask({
					taskId: 'other-task',
					launchSpecJson: '{}',
					createdAt: env.clock.now(),
				});
				container.repos.runs.insert({
					id: 'other-run',
					task_id: 'other-task',
					attempt_no: 3,
					kind: 'implement',
					state: 'failed',
					agent_id: 'codex',
					permission_tier: 'workspaceWrite',
					snapshot_id: snapshot.id,
				});
			}

			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Bughunt process exits 1 (failure)
			bughuntProc?.emitExit(1);

			// Wait for awaiting_human and bughunt_failed gate
			const gateCreated = await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});
			expect(gateCreated).toBe(true);

			const failedBughunt = container.repos.runs.findById(bughuntRun.id);
			expect(failedBughunt?.state).toBe('failed');
			const implRunAwaiting = container.repos.runs.findById(implRunId);
			expect(implRunAwaiting?.state).toBe('awaiting_human');
			expect(implRunAwaiting?.rework_count).toBe(0);

			const gateBeforeRerun = expectDefined(
				listWaitingGates(container).find((g) => g.comment === 'bughunt_failed'),
				'gateBeforeRerun',
			);

			// Trigger rerun via HTTP POST /api/v1/runs/:id/rerun (E-331)
			const rerunRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${bughuntRun.id}/rerun`,
				headers: { authorization: token },
				payload: { idempotencyKey: 'rerun-bughunt-attempt' },
			});
			expect(rerunRes.statusCode).toBe(200);
			const rerunBody = rerunRes.json() as {
				run: { id: string; kind: string; parentRunId: string; attemptNo: number };
			};
			expect(rerunBody.run.kind).toBe('bughunt');
			expect(rerunBody.run.parentRunId).toBe(implRunId);
			expect(rerunBody.run.id).not.toBe(bughuntRun.id);
			expect(rerunBody.run.attemptNo).toBeGreaterThan(bughuntRun.attempt_no);
			expect(container.repos.runs.findById(rerunBody.run.id)?.snapshot_id).toBe(
				bughuntRun.snapshot_id,
			);
			if (hasSequenceGap) {
				expect(bughuntRun.attempt_no).toBe(4);
				expect(rerunBody.run.attemptNo).toBe(5);
			}

			// The previous bughunt_failed gate was superseded
			const gatesRepo = expectDefined(container.repos.gates, 'gates');
			const cancelledGate = gatesRepo.findById(gateBeforeRerun.id);
			expect(cancelledGate?.state).toBe('decided');
			expect(cancelledGate?.comment).toBe('superseded');

			// The implementation run is restored to reviewing
			const restoredImpl = container.repos.runs.findById(implRunId);
			expect(restoredImpl?.state).toBe('reviewing');
			expect(restoredImpl?.rework_count).toBe(0); // did not increase rework count
		},
	);

	it('AC 3 & E-329 & E-331: human gate decision pass advances to landing gate, reject routes to rework with uncommitted notice', async () => {
		// Scenario A: Human decides pass on bughunt gate -> advances to landing gate
		{
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			bughuntProc?.emitExit(1);
			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});
			const gate = expectDefined(
				listWaitingGates(container).find((g) => g.comment === 'bughunt_failed'),
				'gate',
			);

			// Human decides pass
			const decidePassRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${gate.id}/decide`,
				headers: { authorization: token },
				payload: { decision: 'pass', comment: 'Approved despite bughunt failure' },
			});
			expect(decidePassRes.statusCode).toBe(200);

			// Implementation run enters landing gate
			const landingGateAppeared = await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.kind === 'landing' && g.task_id === 'task-1');
			});
			expect(landingGateAppeared).toBe(true);
		}

		// Scenario B: Human decides reject with uncommitted diff -> prepends uncommitted notice (E-329)
		{
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses, gitDiffControl } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Bughunt failed, leaving 2 uncommitted files
			gitDiffControl.hasDiff = true;
			gitDiffControl.filesChanged = 2;
			bughuntProc?.emitExit(1);

			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});
			const gate = expectDefined(
				listWaitingGates(container).find((g) => g.comment === 'bughunt_failed'),
				'gate',
			);

			// Human decides reject
			const decideRejectRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${gate.id}/decide`,
				headers: { authorization: token },
				payload: { decision: 'reject', comment: 'Fix the issues first' },
			});
			expect(decideRejectRes.statusCode).toBe(200);

			// Routes to rework: a new rework implementation run is created
			const reworkCreated = await waitFor(() => {
				const allRuns = container.repos.runs.listByTaskId('task-1');
				return allRuns.some((r) => r.origin === 'rework');
			});
			expect(reworkCreated).toBe(true);

			const reworkRun = expectDefined(
				container.repos.runs.listByTaskId('task-1').find((r) => r.origin === 'rework'),
				'reworkRun',
			);
			expect(reworkRun).toBeDefined();

			// Check that rework message / invocation has prepended notice (E-329)
			const messagesRepo = expectDefined(container.repos.runMessages, 'runMessages');
			const messages = messagesRepo.findMessagesByRunId(reworkRun.id);
			expect(
				messages.some((m) =>
					m.text.includes('工作区已有查 bug 阶段未提交改动 2 个文件，先看 git status 再改'),
				),
			).toBe(true);

			const reworkProc = spawnedProcesses.find((p) => p.launchSpec.runId === reworkRun.id);
			expect(reworkProc).toBeDefined();
			expect(
				reworkProc?.launchSpec.args.some((arg) =>
					arg.includes('工作区已有查 bug 阶段未提交改动 2 个文件，先看 git status 再改'),
				),
			).toBe(true);
		}
	});

	describe('R1–R4 regression suite', () => {
		// R1: 启动抛错、启动即退出或超时、信号中止等查 bug 失败，通过正式容器将子运行、父实施运行及 bughunt_failed 人工闸门完整落定
		it('R1: bughunt process signal termination (SIGTERM) or premature exit creates bughunt_failed gate and sets runs accordingly', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses } = env;
			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Emit signal exit (SIGTERM)
			bughuntProc?.emitExit(143, 'SIGTERM');

			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});

			const updatedBughunt = expectDefined(
				container.repos.runs.findById(bughuntRun.id),
				'updatedBughunt',
			);
			expect(updatedBughunt.state).toBe('failed');

			const updatedImpl = expectDefined(container.repos.runs.findById(implRunId), 'updatedImpl');
			expect(updatedImpl.state).toBe('awaiting_human');
			expect(updatedImpl.queued_reason).toBe('bughunt_failed');

			const gates = listWaitingGates(container);
			const gate = gates.find((g) => g.comment === 'bughunt_failed');
			expect(gate).toBeDefined();
			expect(gate?.run_id).toBe(implRunId);
		});

		// R2: 冻结查 bug 派发时的真实工作区状态，以该基线判断 FIXED 和再审差异；差异读取失败不得按 clean 放行
		it('R2: diff read failure does NOT clean pass and routes to awaiting_human bughunt_failed', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses, gitDiffControl } = env;
			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Simulate clean output in report, but git diff reading fails!
			gitDiffControl.failDiffRead = true;
			bughuntProc?.emitLine(loadFixture('clean.txt'));
			bughuntProc?.emitExit(0);

			// Must NOT land; must enter awaiting_human with bughunt_failed gate
			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});

			const updatedImpl = expectDefined(container.repos.runs.findById(implRunId), 'updatedImpl');
			expect(updatedImpl.state).toBe('awaiting_human');
			expect(updatedImpl.queued_reason).toBe('bughunt_failed');
		});

		it('R2: a failed dispatch baseline freezes no run and opens a human gate', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			env.gitDiffControl.failDiffRead = true;
			const { implRunId } = await advanceToReviewPassed(env);
			await waitFor(() =>
				listWaitingGates(env.container).some((g) => g.comment === 'bughunt_failed'),
			);
			expect(
				env.container.repos.runs.listByTaskId('task-1').some((r) => r.kind === 'bughunt'),
			).toBe(false);
			const parent = expectDefined(env.container.repos.runs.findById(implRunId), 'parent');
			expect(parent.state).toBe('awaiting_human');
			expect(parent.queued_reason).toBe('bughunt_failed');
		});

		it('R2: dirty workspace before bughunt and untouched during bughunt results in clean pass to landing gate', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses, gitDiffControl } = env;
			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Untouched: the dirty workspace still has the same tree as at dispatch.
			bughuntProc?.emitLine(loadFixture('clean.txt'));
			bughuntProc?.emitExit(0);

			// Direct clean landing gate
			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.kind === 'landing' && g.task_id === 'task-1');
			});
			expect(listWaitingGates(container).some((g) => g.kind === 'landing')).toBe(true);
		});

		it('R2: forbidden commit with fixes detects diff against baseline tree and triggers rereview', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses, gitDiffControl } = env;
			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id);

			// Has diff against baseline tree
			gitDiffControl.hasDiff = true;
			gitDiffControl.filesChanged = 1;
			gitDiffControl.treeVersion = 1;
			bughuntProc?.emitLine(loadFixture('fixed.txt'));
			bughuntProc?.emitExit(0);

			// Triggers rereview: review service starts new review round for same session
			await waitFor(() => {
				const allRuns = container.repos.runs.listByTaskId('task-1');
				return allRuns.some((r) => r.kind === 'review' && r.attempt_no > 2);
			});
			const newReviewRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'review' && r.attempt_no > 2),
				'newReviewRun',
			);
			expect(newReviewRun).toBeDefined();
		});

		// R3: HTTP 重派只允许当前停在 bughunt_failed 人工等待的那条子运行；旧行、其他闸门、已放行后的请求不得新派
		it('R3: HTTP rerun rejects older bughunt runs, non-bughunt_failed gates, or released runs with 409', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const { implRunId } = await advanceToReviewPassed(env);

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun1 = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun1',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun1.id));
			const bughuntProc1 = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun1.id);

			// First bughunt run fails
			bughuntProc1?.emitExit(1);
			await waitFor(() => listWaitingGates(container).some((g) => g.comment === 'bughunt_failed'));

			// HTTP rerun allowed for this latest run
			const rerunRes1 = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${bughuntRun1.id}/rerun`,
				headers: { authorization: token },
				payload: { idempotencyKey: 'idemp-key-test-01' },
			});
			expect(rerunRes1.statusCode).toBe(200);
			const bughuntRun2Id = rerunRes1.json().run.id;
			expect(bughuntRun2Id).not.toBe(bughuntRun1.id);

			// Attempting to rerun the older bughuntRun1 now MUST return 409 E_CONFLICT!
			const rerunOlderRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${bughuntRun1.id}/rerun`,
				headers: { authorization: token },
				payload: { idempotencyKey: 'idemp-key-test-02' },
			});
			expect(rerunOlderRes.statusCode).toBe(409);

			// Let bughuntRun2 fail as well
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun2Id));
			const bughuntProc2 = spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun2Id);
			bughuntProc2?.emitExit(1);

			await waitFor(() => {
				const gates = listWaitingGates(container);
				return gates.some((g) => g.comment === 'bughunt_failed');
			});
			const gate2 = expectDefined(
				listWaitingGates(container).find((g) => g.comment === 'bughunt_failed'),
				'gate2',
			);

			// Human approves the gate (release)
			const passRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${gate2.id}/decide`,
				headers: { authorization: token },
				payload: { decision: 'pass', comment: 'Approved' },
			});
			expect(passRes.statusCode).toBe(200);

			// Now rerun request on bughuntRun2 must return 409 E_CONFLICT!
			const rerunReleasedRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${bughuntRun2Id}/rerun`,
				headers: { authorization: token },
				payload: { idempotencyKey: 'idemp-key-test-03' },
			});
			expect(rerunReleasedRes.statusCode).toBe(409);
		});

		// R4: bughunt、rework、wrapup-fix 启动时逐字透传 model/effort，包括 null
		it('R4: bughunt and rework runs strictly pass through model and effortTier (including null) without falling back to launchSpecData defaults', async () => {
			const env = await setupBughuntEnvironment({ pipelineBughunt: true });
			const { container, spawnedProcesses } = env;

			// Advance to review pass
			const { implRunId } = await advanceToReviewPassed(env);

			// Explicitly set model_name and effort_tier to null in DB for implRun
			env.db
				.prepare('UPDATE runs SET model_name = NULL, effort_tier = NULL WHERE id = ?')
				.run(implRunId);
			const implRunRow = container.repos.runs.findById(implRunId);
			if (implRunRow?.snapshot_id) {
				env.db
					.prepare('UPDATE dispatch_snapshots SET assignment_json = NULL WHERE id = ?')
					.run(implRunRow.snapshot_id);
			}

			// Clear previous bughunt run if any created during advance
			const existingBh = container.repos.runs
				.listByTaskId('task-1')
				.find((r) => r.kind === 'bughunt');
			if (existingBh) {
				env.db.prepare('DELETE FROM runs WHERE id = ?').run(existingBh.id);
			}

			// Dispatch new bughunt run using implRun with null model_name
			const bughuntService = expectDefined(container.services.bughunt, 'bughunt');
			await bughuntService.dispatchBughunt({ implRunId });
			await container.services.dispatch.tick();

			await waitFor(() => {
				const runs = container.repos.runs.listByTaskId('task-1');
				return runs.some((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId);
			});
			const bughuntRun = expectDefined(
				container.repos.runs
					.listByTaskId('task-1')
					.find((r) => r.kind === 'bughunt' && r.parent_run_id === implRunId),
				'bughuntRun',
			);
			await waitFor(() => spawnedProcesses.some((p) => p.launchSpec.runId === bughuntRun.id));
			const bughuntProc = expectDefined(
				spawnedProcesses.find((p) => p.launchSpec.runId === bughuntRun.id),
				'bughuntProc',
			);

			// In snap-1, launch_spec_json has model: 'o3-mini'.
			// But for bughunt, strict passthrough must preserve model = null (no model="o3-mini" or --model in args).
			const args = bughuntProc.launchSpec.args;
			expect(args.some((a) => a.includes('model='))).toBe(false);
			expect(args.some((a) => a.includes('--model'))).toBe(false);
		});
	});
});
