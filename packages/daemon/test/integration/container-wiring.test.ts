import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { ProcessLiveness } from '../../src/jobs/reconcile-runs.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
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
		deviceName: 'test-device-wiring',
	});
	return `Bearer ${claim.token}`;
}

function setupWiringEnvironment(
	overrides: {
		readonly processProbe?: { check: (pid: number) => ProcessLiveness };
	} = {},
) {
	const tempDir = mkdtempSync(join(tmpdir(), 'agsched-wiring-'));
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
		const proc = createFakeProcess(spec);
		spawnedProcesses.push(proc);
		return proc.managed;
	}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged;

	const fakeWorktreeManager = {
		prepareWorktree: async (input: PrepareWorktreeInput): Promise<PrepareWorktreeResult> => {
			const worktreePath = join(tempDir, 'worktrees', input.taskId);
			mkdirSync(worktreePath, { recursive: true });
			return {
				worktreePath,
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

	const fakeAgentService = {
		start: async () => {},
		stop: async () => {},
		listAgents: async () => [{ id: 'codex', canDispatch: true, maxConcurrency: 2 }],
		getAvailability: (agentId: string) => {
			if (agentId === 'codex') {
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

	const fakeGitRunner = {
		run: async (args: readonly string[]): Promise<GitCommandResult> => {
			const command = args.join(' ');
			if (command.includes('--is-inside-work-tree')) {
				return { exitCode: 0, stdout: 'true\n', stderr: '' };
			}
			if (command.includes('status')) {
				return { exitCode: 0, stdout: ' M src/index.ts\0', stderr: '' };
			}
			if (command.includes('--numstat')) {
				return { exitCode: 0, stdout: '1\t0\tsrc/index.ts\0', stderr: '' };
			}
			if (command.includes('diff')) {
				return {
					exitCode: 0,
					stdout:
						'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n+export const done = true;\n',
					stderr: '',
				};
			}
			if (command.includes('rev-parse')) {
				return { exitCode: 0, stdout: 'e8a71c8901234567890123456789012345678901\n', stderr: '' };
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
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock,
		spawnManaged: fakeSpawnManaged,
		worktreeManager: fakeWorktreeManager,
		agentService: fakeAgentService as never,
		processProbe: overrides.processProbe,
		gitRunner: fakeGitRunner,
		logViolation: (msg: unknown) => {
			const cause = msg instanceof Error ? (msg as { cause?: unknown }).cause : undefined;
			console.log(
				'[TEST CONTAINER LOG]',
				msg instanceof Error ? msg.message : String(msg),
				cause ? `CAUSE: ${String(cause)}` : '',
			);
		},
	});

	// Seed document, batch, task, snapshot
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
		task_key: 'M7-T9',
		title: 'Wiring container review and gates',
		module_key: 'M7',
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

	container.repos.dispatchSnapshots?.insert({
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

	return {
		container,
		db,
		clock,
		tempDir,
		spawnedProcesses,
	};
}

describe(
	'M7-T9 Integration: Container Wiring (AC 2, AC 3, AC 4, E-53, E-57, E-104, E-120, E-123)',
	{ timeout: 25000 },
	() => {
		it('AC 2 & E-53 & E-57: Real container + fake process: exit 0 -> evaluateMechanicalCheck called -> kind=review inserted -> review verdict pass -> waiting gate -> POST decide -> landed by:human', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();

			const token = await getAuthToken(container);

			// Configure gates: review=auto, landing=manual (E-53 default manual landing gate)
			container.services.settings.updateGates(
				{
					dispatch: 'auto',
					review: 'auto',
					landing: 'manual',
				},
				null,
			);

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			// 1. Dispatch initial implementation run
			const createRes = await container.services.dispatch.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'wiring-impl-run-1',
			});
			const implRunId = createRes.run.id;

			// Trigger tick to launch process
			await container.services.dispatch.tick();

			let waitAttempts = 0;
			while (spawnedProcesses.length === 0 && waitAttempts < 50) {
				await new Promise((r) => setTimeout(r, 20));
				waitAttempts++;
			}

			expect(spawnedProcesses.length).toBeGreaterThanOrEqual(1);
			const implProc = spawnedProcesses[0];
			expect(implProc).toBeDefined();
			if (!implProc) return;
			expect(implProc.launchSpec.runId).toBe(implRunId);

			// Implementation process emits output and exits cleanly with exitCode 0
			implProc.emitLine(
				'{"method":"item/agentMessage/delta","params":{"delta":"Implementation done."}}',
			);
			await new Promise((r) => setTimeout(r, 30));

			implProc.emitExit(0);
			// Wait for async exit handlers to settle
			let reviewAttempts = 0;
			while (spawnedProcesses.length < 2 && reviewAttempts < 50) {
				await new Promise((r) => setTimeout(r, 20));
				reviewAttempts++;
			}

			// Verify implementation run state is 'reviewing'
			const implRunAfterExit = container.repos.runs.findById(implRunId);
			expect(implRunAfterExit?.state).toBe('reviewing');

			// Verify kind=review run was INSERTed into runs table
			const allRuns = container.repos.runs.listByTaskId('task-1');
			const reviewRun = allRuns.find((r) => r.kind === 'review');
			expect(reviewRun).toBeDefined();
			expect(reviewRun?.parent_run_id).toBe(implRunId);

			// Verify review process was spawned
			expect(spawnedProcesses.length).toBeGreaterThanOrEqual(2);
			const reviewProc = spawnedProcesses.find((p) => p.launchSpec.runId === reviewRun?.id);
			expect(reviewProc).toBeDefined();

			// Review process emits VERDICT: pass and exits 0
			reviewProc?.emitLine('VERDICT: pass\nAll acceptance criteria met.');
			await new Promise((r) => setTimeout(r, 30));

			reviewProc?.emitExit(0);
			await new Promise((r) => setTimeout(r, 200));

			// Verify task.review_verdict was emitted
			const reviewVerdictEvent = publishedEvents.find((e) => e.kind === 'task.review_verdict');
			expect(reviewVerdictEvent).toBeDefined();
			expect((reviewVerdictEvent?.payload as { verdict: string })?.verdict).toBe('pass');

			// Verify a waiting landing gate was created
			const listGatesRes = await server.instance.inject({
				method: 'GET',
				url: '/api/v1/gates?pending',
				headers: { authorization: token },
			});
			expect(listGatesRes.statusCode).toBe(200);
			const listBody = listGatesRes.json() as {
				gates: Array<{ id: string; kind: string; state: string; taskId: string }>;
			};
			const landingGate = listBody.gates.find((g) => g.kind === 'landing' && g.state === 'waiting');
			expect(landingGate).toBeDefined();
			expect(landingGate?.taskId).toBe('task-1');

			// 2. Decide gate via POST /api/v1/gates/:gateId/decide with decision: 'pass'
			const decideRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${landingGate?.id}/decide`,
				headers: { authorization: token },
				payload: {
					decision: 'pass',
					comment: 'Approved by tester',
				},
			});
			expect(decideRes.statusCode).toBe(200);
			expect(decideRes.json()).toEqual({ applied: true });

			// Verify implementation run transitioned to 'landed'
			const implRunLanded = container.repos.runs.findById(implRunId);
			expect(implRunLanded?.state).toBe('landed');

			// Verify task manual state transitioned to 'landed'
			const taskLanded = container.repos.tasks.findById('task-1');
			expect(taskLanded?.manual_state).toBe('landed');

			// Verify task.landed event was emitted with by: 'human'
			const landedEvent = publishedEvents.find((e) => e.kind === 'task.landed');
			expect(landedEvent).toBeDefined();
			const landedPayload = landedEvent?.payload as { by: string; gateId: string };
			expect(landedPayload.by).toBe('human');
			expect(landedPayload.gateId).toBe(landingGate?.id);

			// E-57: Second decision attempt on same gate returns 409 E_GATE_ALREADY_DECIDED
			const secondDecideRes = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/gates/${landingGate?.id}/decide`,
				headers: { authorization: token },
				payload: {
					decision: 'pass',
				},
			});
			expect(secondDecideRes.statusCode).toBe(409);
			const secondBody = secondDecideRes.json() as { error: { code: string } };
			expect(secondBody.error.code).toBe('E_GATE_ALREADY_DECIDED');
		});

		it('AC 3 & E-123: reconcile-runs marks dead/missing PID as interrupted and alive PID as orphaned (失联), never presumes success', async () => {
			const env = setupWiringEnvironment({
				processProbe: {
					check: (pid: number) => {
						if (pid === 11111) return 'dead';
						if (pid === 22222) return 'alive';
						return 'dead';
					},
				},
			});
			const { container } = env;

			// Pre-populate database with two running runs
			const now = env.clock.now();
			container.repos.runs.insert({
				id: 'run-dead-pid',
				task_id: 'task-1',
				attempt_no: 10,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				pid: 11111, // dead process
				started_at: now,
			});

			container.repos.runs.insert({
				id: 'run-alive-pid',
				task_id: 'task-1',
				attempt_no: 11,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				pid: 22222, // alive process
				started_at: now,
			});

			// Find the reconcile-runs job from container.jobs
			const reconcileJob = container.jobs.find((j) => j.name === 'reconcile-runs') as unknown as {
				runOnce: () => Promise<unknown>;
			};
			expect(reconcileJob).toBeDefined();

			// Run reconciliation
			await reconcileJob.runOnce();

			// Assert run-dead-pid is 'interrupted' with reason daemon-restart-process-missing (E-123)
			const deadRow = container.repos.runs.findById('run-dead-pid');
			expect(deadRow?.state).toBe('interrupted');
			expect(deadRow?.queued_reason).toBe('daemon-restart-process-missing');

			// Assert run-alive-pid is 'orphaned' with reason daemon-restart-attach-failed (E-02)
			const aliveRow = container.repos.runs.findById('run-alive-pid');
			expect(aliveRow?.state).toBe('orphaned');
			expect(aliveRow?.queued_reason).toBe('daemon-restart-attach-failed');

			// Neither is landed or passed (never presumes success)
			expect(deadRow?.state).not.toBe('landed');
			expect(aliveRow?.state).not.toBe('landed');
		});

		it('AC 3 & E-120: stall-detector emits run.stalled_suspected on threshold exceeded, does not change state or kill process', async () => {
			const env = setupWiringEnvironment();
			const { container } = env;

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			// Insert running run whose last_event_at is 20 minutes in the past
			const nowMs = 1725800000000 + 50000;
			const twentyMinutesAgo = new Date(nowMs - 20 * 60 * 1000).toISOString();
			container.repos.runs.insert({
				id: 'run-stalled-candidate',
				task_id: 'task-1',
				attempt_no: 20,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				started_at: twentyMinutesAgo,
				last_event_at: twentyMinutesAgo,
			});

			const stallJob = container.jobs.find((j) => j.name === 'stall-detector') as unknown as {
				runOnce: () => Promise<unknown>;
			};
			expect(stallJob).toBeDefined();

			// Run stall detection
			await stallJob.runOnce();

			// Assert run.stalled_suspected event was emitted
			const stallEvent = publishedEvents.find((e) => e.kind === 'run.stalled_suspected');
			expect(stallEvent).toBeDefined();

			// Assert run state is still 'running' (not changed, process not killed)
			const candidateRow = container.repos.runs.findById('run-stalled-candidate');
			expect(candidateRow?.state).toBe('running');
		});

		it('AC 4 & E-104: disk-watch over threshold halts new dispatches; POST /runs returns error envelope; existing runs continue', async () => {
			const env = setupWiringEnvironment();
			const { container } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();

			const token = await getAuthToken(container);

			// Create an existing running run
			const now = env.clock.now();
			container.repos.runs.insert({
				id: 'run-existing-1',
				task_id: 'task-1',
				attempt_no: 30,
				kind: 'implement',
				state: 'running',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				started_at: now,
			});

			// Trigger disk watch halt via SystemService
			container.services.system.notifyDiskFull('/logs/error.log');
			expect(container.services.system.isDispatchHalted()).toBe(true);

			// POST /api/v1/runs to attempt dispatching a new run
			const postRunsRes = await server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs',
				headers: { authorization: token },
				payload: {
					taskId: 'task-1',
					agentId: 'codex',
					idempotencyKey: 'idemp-disk-full-test',
				},
			});

			// Assert returns error envelope
			expect(postRunsRes.statusCode).toBe(507);
			const errorBody = postRunsRes.json() as { error: { code: string; message: string } };
			expect(errorBody.error).toBeDefined();
			expect(errorBody.error.code).toBe('E_DISK_FULL');

			// Assert existing running run continues in 'running' state
			const existingRow = container.repos.runs.findById('run-existing-1');
			expect(existingRow?.state).toBe('running');
		});

		it('AC 4 & E-104: log-index-repair runs once on startup and stops cleanly', async () => {
			const env = setupWiringEnvironment();
			const { container } = env;

			const logRepairJob = container.jobs.find((j) => j.name === 'log-index-repair');
			expect(logRepairJob).toBeDefined();

			// Start the job
			logRepairJob?.start();

			// Stop awaits the single pass and resolves
			await logRepairJob?.stop();

			// Subsequent stop call is also safe and idempotent
			await logRepairJob?.stop();
		});
	},
);
