import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createEventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { createLogstoreService, type LogstoreService } from '../../src/service/logstore.ts';
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
		readonly spawnManaged?: (spec: LaunchSpec) => ManagedProcess;
		readonly appendDelayMs?: number;
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
		if (overrides.spawnManaged) {
			return overrides.spawnManaged(spec);
		}
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
		logstoreService: overrides.appendDelayMs
			? (() => {
					const nodeFs = createNodeLogFileSystem();
					const base = createLogstoreService({
						fs: nodeFs,
						paths: createLogstorePaths(join(tempDir, 'runs')),
						queue: createAppendQueue({
							appendFile: (path, data) => nodeFs.appendFile(path, data),
						}),
						ids: { newId: () => `log_${Math.random().toString(36).slice(2, 10)}` },
						unitOfWork: createUnitOfWork(db),
						eventsIndexRepo: createEventsIndexRepo(db),
						segmentsRepo: createLogSegmentsRepo(db),
					});
					return {
						...base,
						async appendRaw(runId: string, line: Uint8Array) {
							await new Promise((r) => setTimeout(r, overrides.appendDelayMs));
							return await base.appendRaw(runId, line);
						},
						async appendEvent(runId: string, env: Parameters<LogstoreService['appendEvent']>[1]) {
							await new Promise((r) => setTimeout(r, overrides.appendDelayMs));
							return await base.appendEvent(runId, env);
						},
					};
				})()
			: undefined,
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

		it('R1: missing snapshot or missing diff transfers to awaiting_human with typed gate comment, no fake fallback', async () => {
			const env = setupWiringEnvironment();
			const { container } = env;

			// Insert a snapshot that belongs to a different task
			const now = env.clock.now();
			container.repos.tasks.insert({
				id: 'task-other',
				doc_id: 'doc-1',
				task_key: 'M7-T9-OTHER',
				title: 'Other task',
				module_key: 'M7',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'pending',
				contract_hash: 'hash-other',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			container.repos.dispatchSnapshots?.insert({
				id: 'snap-other',
				task_id: 'task-other',
				contract_hash: 'hash-other',
				task_paths_json: '[]',
				launch_spec_json: '{}',
				created_at: now,
			});

			const worktreePath = join(env.tempDir, 'worktrees', 'task-1');
			mkdirSync(worktreePath, { recursive: true });

			// Insert a run for task-1 referencing snap-other (valid FK, but snapshot does not match task-1)
			container.repos.runs.insert({
				id: 'run-missing-snap',
				task_id: 'task-1',
				attempt_no: 50,
				kind: 'implement',
				state: 'exited',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-other',
				worktree_path: worktreePath,
				started_at: now,
			});

			const evalResult = await container.services.review.evaluateMechanicalCheck({
				runId: 'run-missing-snap',
				exitCode: 0,
			});

			// Assert mechanical check itself passed, but review material missing transferred to awaiting_human
			expect(evalResult.result.passed).toBe(true);
			expect(evalResult.currentState).toBe('awaiting_human');
			expect(evalResult.gateCreated).toBe(true);
			expect(evalResult.reviewRunId).toBeUndefined();

			// Verify run row in DB
			const runRow = container.repos.runs.findById('run-missing-snap');
			expect(runRow?.state).toBe('awaiting_human');
			expect(runRow?.queued_reason).toBe('missing_dispatch_snapshot');

			// Verify review waiting gate was created with typed comment 'snapshot_missing'
			const gates = container.repos.gates.list({ pendingOnly: true });
			const gate = gates.find((g) => g.run_id === 'run-missing-snap');
			expect(gate).toBeDefined();
			expect(gate?.kind).toBe('review');
			expect(gate?.state).toBe('waiting');
			expect(gate?.comment).toBe('snapshot_missing');
		});

		it('R2: waits for delayed review output write to land on disk before closing writer, reading back, and evaluating verdict', async () => {
			// Set up environment with 60ms append delay
			const env = setupWiringEnvironment({ appendDelayMs: 60 });
			const { container, spawnedProcesses } = env;

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			// Create and launch an implementation run
			const createRes = await container.services.dispatch.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'r2-wiring-impl',
			});
			const implRunId = createRes.run.id;
			await container.services.dispatch.tick();

			let waitAttempts = 0;
			while (spawnedProcesses.length === 0 && waitAttempts < 50) {
				await new Promise((r) => setTimeout(r, 20));
				waitAttempts++;
			}
			const implProc = spawnedProcesses[0];
			implProc.emitLine('{"method":"item/agentMessage/delta","params":{"delta":"Done."}}');
			implProc.emitExit(0);

			// Wait for review run to be dispatched
			let reviewAttempts = 0;
			while (spawnedProcesses.length < 2 && reviewAttempts < 50) {
				await new Promise((r) => setTimeout(r, 20));
				reviewAttempts++;
			}
			const reviewProc = spawnedProcesses.find((p) => p.launchSpec.runId !== implRunId);
			expect(reviewProc).toBeDefined();
			if (!reviewProc) return;

			// Review process emits output with verdict pass, then IMMEDIATELY emits exit(0)
			reviewProc.emitLine('VERDICT: pass\nImplementation verified cleanly.');
			reviewProc.emitExit(0);

			// Wait for exit handler to settle
			await new Promise((r) => setTimeout(r, 400));

			// Verify task.review_verdict was emitted with pass (not failed or unparsed)
			const verdictEvent = publishedEvents.find(
				(e) => e.kind === 'task.review_verdict' && (e.payload as { verdict: string }).verdict === 'pass',
			);
			expect(verdictEvent).toBeDefined();
		});

		it('R3: review dispatch failure is not swallowed; both runs and gate reach recoverable state with error evidence', async () => {
			let shouldFailSpawn = false;
			const env = setupWiringEnvironment({
				spawnManaged: (spec: LaunchSpec) => {
					if (shouldFailSpawn) {
						throw new Error('Adapter failed to allocate resources');
					}
					const proc = createFakeProcess(spec);
					env.spawnedProcesses.push(proc);
					return proc.managed;
				},
			});
			const { container, spawnedProcesses } = env;

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			const createRes = await container.services.dispatch.createRun({
				taskId: 'task-1',
				agentId: 'codex',
				idempotencyKey: 'r3-wiring-impl',
			});
			const implRunId = createRes.run.id;
			await container.services.dispatch.tick();

			let waitAttempts = 0;
			while (spawnedProcesses.length === 0 && waitAttempts < 50) {
				await new Promise((r) => setTimeout(r, 20));
				waitAttempts++;
			}
			const implProc = spawnedProcesses[0];
			implProc.emitLine('{"method":"item/agentMessage/delta","params":{"delta":"Done."}}');
			await new Promise((r) => setTimeout(r, 30));

			// Now enable spawn failure before implementation process exits
			shouldFailSpawn = true;
			implProc.emitExit(0);

			// Wait for exit evaluation to settle
			await new Promise((r) => setTimeout(r, 300));

			// 1. Implementation run must NOT be stuck in reviewing; must be in awaiting_human
			const implRun = container.repos.runs.findById(implRunId);
			expect(implRun?.state).toBe('awaiting_human');
			expect(implRun?.queued_reason).toContain('review_dispatch_failed: Adapter failed to allocate resources');

			// 2. Waiting gate must be created with error evidence
			const gates = container.repos.gates.list({ pendingOnly: true });
			const reviewGate = gates.find((g) => g.run_id === implRunId && g.kind === 'review');
			expect(reviewGate).toBeDefined();
			expect(reviewGate?.state).toBe('waiting');
			expect(reviewGate?.comment).toContain('review_dispatch_failed: Adapter failed to allocate resources');

			// 3. Events must have been published
			const gateWaitingEvent = publishedEvents.find((e) => e.kind === 'task.gate_waiting');
			expect(gateWaitingEvent).toBeDefined();
			const stateChangedEvent = publishedEvents.find(
				(e) =>
					e.kind === 'run.state_changed' &&
					(e.payload as { to: string }).to === 'awaiting_human' &&
					(e.payload as { reason: string }).reason === 'review_dispatch_failed',
			);
			expect(stateChangedEvent).toBeDefined();
		});

		it('R4: automatic and human landed both complete session archival, slot release, and terminal events with idempotency', async () => {
			const env = setupWiringEnvironment();
			const { container, db } = env;

			const publishedEvents: Array<{ kind: string; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({ kind: envelope.kind, payload: envelope.payload });
			});

			const now = env.clock.now();

			// --- Part 1: Automatic landed ---
			container.services.settings.updateGates(
				{ dispatch: 'auto', review: 'auto', landing: 'auto' },
				null,
			);

			container.repos.tasks.insert({
				id: 'task-auto',
				doc_id: 'doc-1',
				task_key: 'M7-T9-AUTO',
				title: 'Auto landing test',
				module_key: 'M7',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'pending',
				contract_hash: 'hash-auto',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			db.prepare("UPDATE tasks SET lane_no = 2 WHERE id = 'task-auto'").run();

			container.repos.runs.insert({
				id: 'run-auto-1',
				task_id: 'task-auto',
				attempt_no: 1,
				kind: 'implement',
				state: 'reviewing',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				lane_no: 2,
				started_at: now,
			});

			const autoRes = await container.services.gates.resolveAfterReviewAndApply({
				taskId: 'task-auto',
				runId: 'run-auto-1',
				reviewVerdict: 'pass',
			});
			expect(autoRes.outcome).toBe('landed');

			// Assert session archived
			const autoRun = container.repos.runs.findById('run-auto-1');
			expect(autoRun?.state).toBe('landed');
			expect(autoRun?.session_archived_at).not.toBeNull();

			// Assert lane slot released
			const autoTask = container.repos.tasks.findById('task-auto');
			expect(autoTask?.manual_state).toBe('landed');
			expect(autoTask?.lane_no).toBeNull();

			// Assert terminal events: lane.released, task.landed (by: auto), task.sessions_archived
			const autoLaneReleased = publishedEvents.find(
				(e) => e.kind === 'lane.released' && (e.payload as { taskId: string }).taskId === 'task-auto',
			);
			expect(autoLaneReleased).toBeDefined();

			const autoLandedEvent = publishedEvents.find(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'auto',
			);
			expect(autoLandedEvent).toBeDefined();

			const autoSessionsArchived = publishedEvents.find(
				(e) => e.kind === 'task.sessions_archived' && (e.payload as { taskId: string }).taskId === 'task-auto',
			);
			expect(autoSessionsArchived).toBeDefined();

			// Idempotency: re-calling resolveAfterReviewAndApply returns landed without duplicating
			const repeatEventsCount = publishedEvents.filter(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'auto',
			).length;
			const repeatAutoRes = await container.services.gates.resolveAfterReviewAndApply({
				taskId: 'task-auto',
				runId: 'run-auto-1',
				reviewVerdict: 'pass',
			});
			expect(repeatAutoRes.outcome).toBe('landed');
			const newEventsCount = publishedEvents.filter(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'auto',
			).length;
			expect(newEventsCount).toBe(repeatEventsCount);

			// --- Part 2: Human landed ---
			container.repos.tasks.insert({
				id: 'task-manual',
				doc_id: 'doc-1',
				task_key: 'M7-T9-MANUAL',
				title: 'Manual landing test',
				module_key: 'M7',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'pending',
				contract_hash: 'hash-manual',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			db.prepare("UPDATE tasks SET lane_no = 3 WHERE id = 'task-manual'").run();

			container.repos.runs.insert({
				id: 'run-manual-1',
				task_id: 'task-manual',
				attempt_no: 1,
				kind: 'implement',
				state: 'reviewing',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snap-1',
				lane_no: 3,
				started_at: now,
			});

			container.repos.gates.create({
				id: 'gate-manual-landing',
				task_id: 'task-manual',
				run_id: 'run-manual-1',
				kind: 'landing',
				state: 'waiting',
				comment: 'waiting_for_user',
				created_at: now,
			});

			const manualDecideRes = await container.services.gates.decideGate({
				gateId: 'gate-manual-landing',
				decision: 'pass',
				comment: 'Manually approved',
				actorDeviceId: null,
			});
			expect(manualDecideRes.applied).toBe(true);

			// Assert session archived
			const manualRun = container.repos.runs.findById('run-manual-1');
			expect(manualRun?.state).toBe('landed');
			expect(manualRun?.session_archived_at).not.toBeNull();

			// Assert lane slot released
			const manualTask = container.repos.tasks.findById('task-manual');
			expect(manualTask?.manual_state).toBe('landed');
			expect(manualTask?.lane_no).toBeNull();

			// Assert terminal events: lane.released, task.landed (by: human), task.sessions_archived
			const manualLaneReleased = publishedEvents.find(
				(e) => e.kind === 'lane.released' && (e.payload as { taskId: string }).taskId === 'task-manual',
			);
			expect(manualLaneReleased).toBeDefined();

			const manualLandedEvent = publishedEvents.find(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'human',
			);
			expect(manualLandedEvent).toBeDefined();

			const manualSessionsArchived = publishedEvents.find(
				(e) => e.kind === 'task.sessions_archived' && (e.payload as { taskId: string }).taskId === 'task-manual',
			);
			expect(manualSessionsArchived).toBeDefined();

			// Idempotency: deciding again throws E_GATE_ALREADY_DECIDED
			await expect(
				container.services.gates.decideGate({
					gateId: 'gate-manual-landing',
					decision: 'pass',
					actorDeviceId: null,
				}),
			).rejects.toThrow('Gate already decided');
		});
	},
);
