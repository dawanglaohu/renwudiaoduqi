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
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { ProcessLiveness } from '../../src/jobs/reconcile-runs.ts';
import { createAppendQueue } from '../../src/logstore/append-queue.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { LaunchSpec, ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import { createEventsIndexRepo } from '../../src/repo/events-index-repo.ts';
import { createLogSegmentsRepo } from '../../src/repo/log-segments-repo.ts';
import { type LogstoreService, createLogstoreService } from '../../src/service/logstore.ts';
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
		/**
		 * 假 spawn 的剧本（每次启动运行前调用一次）：
		 * `ok` 正常起进程；`throw` 让 spawn 直接抛错；`exit-immediately` 让进程「起来就退出」（E-348 抢先退出）。
		 */
		readonly spawnBehavior?: (spec: LaunchSpec) => 'ok' | 'throw' | 'exit-immediately';
		/** 注册表里的每 agent 并发上限；容器与 tick 都读它（E-47）。默认 2。 */
		readonly agentMaxConcurrency?: number;
		readonly codexExecPath?: string;
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
		const behavior = overrides.spawnBehavior?.(spec) ?? 'ok';
		if (behavior === 'throw') {
			throw new Error(`fake spawn failure for ${spec.runId}`);
		}
		const proc = createFakeProcess(spec);
		spawnedProcesses.push(proc);
		if (behavior === 'exit-immediately') {
			proc.emitExit(1);
		}
		return proc.managed;
	}) as unknown as typeof import('../../src/proc/spawn.ts').spawnManaged;

	// 真实注册表 + 只改 codex 的 maxConcurrency：容器与 tick 的并发上限都取自它（E-47），
	// 这样「默认 1」与「更宽的 2」两种部署形态都能在同一个真容器上验。
	const codexMaxConcurrency = overrides.agentMaxConcurrency ?? 2;
	const agentRegistry = createAgentRegistry({
		dataDir: tempDir,
		platform: 'posix',
		publishWarning: () => {},
		builtInDefaults: {
			...BUILT_IN_AGENT_DEFAULTS,
			codex: Object.freeze({
				...BUILT_IN_AGENT_DEFAULTS.codex,
				maxConcurrency: codexMaxConcurrency,
				execPath: overrides.codexExecPath ?? BUILT_IN_AGENT_DEFAULTS.codex.execPath,
			}),
		},
	});

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
		agentRegistry,
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
		agentRegistry,
		db,
		clock,
		tempDir,
		spawnedProcesses,
	};
}

const REWORK_COMMENT = 'Please repair the parser boundary.';

interface ReworkDecisionSeed {
	readonly snapshotId?: string;
	readonly agentId?: string;
	readonly vendorSessionRef?: string | null;
	readonly runState?: string;
}

/**
 * 造出 E-327 的前置：一条已结束的实施运行 + 停在 awaiting_human 的任务 + 一张 waiting 的人工审查闸门。
 * 这些都是"人在界面上点了打回"之前生产库里就有的行。
 */
function seedHumanReworkDecision(
	env: ReturnType<typeof setupWiringEnvironment>,
	seed: ReworkDecisionSeed = {},
): void {
	const { container, clock, tempDir } = env;
	const worktreePath = join(tempDir, 'worktrees', 'task-1');
	mkdirSync(worktreePath, { recursive: true });

	container.repos.runs.insert({
		id: 'ended-impl-run',
		task_id: 'task-1',
		attempt_no: 1,
		kind: 'implement',
		state: seed.runState ?? 'awaiting_human',
		agent_id: seed.agentId ?? 'codex',
		model_name: 'o3-mini',
		effort_tier: 'high',
		permission_tier: 'workspaceWrite',
		snapshot_id: seed.snapshotId ?? 'snap-1',
		worktree_path: worktreePath,
		branch_name: 'task/M7-T9',
		vendor_session_ref:
			seed.vendorSessionRef === undefined ? 'vendor-session-1' : seed.vendorSessionRef,
		started_at: clock.now(),
	});
	container.repos.tasks.updateManualState('task-1', 'awaiting_human');
	const gatesRepo = container.repos.gates;
	if (!gatesRepo) throw new Error('Gates repo missing from container');
	gatesRepo.create({
		id: 'human-review-gate',
		task_id: 'task-1',
		run_id: 'ended-impl-run',
		kind: 'review',
		state: 'waiting',
		created_at: clock.now(),
	});
}

async function postReworkDecision(
	server: ReturnType<typeof createHttpServer>,
	token: string,
	gateId: string,
	comment: string,
) {
	return await server.instance.inject({
		method: 'POST',
		url: `/api/v1/gates/${gateId}/decide`,
		headers: { authorization: token },
		payload: { decision: 'reject', comment },
	});
}

async function waitFor(predicate: () => boolean, attempts = 80, delayMs = 20): Promise<boolean> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return true;
		await new Promise((r) => setTimeout(r, delayMs));
	}
	return predicate();
}

describe(
	'M7-T9 Integration: Container Wiring (AC 2, AC 3, AC 4, E-53, E-57, E-104, E-120, E-123)',
	{ timeout: 25000 },
	() => {
		it('E-327 / #136: real container delivers a human rework into an ended codex session by resuming it', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const publishedEvents: Array<{ kind: string; payload: Record<string, unknown> }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({
					kind: envelope.kind,
					payload: envelope.payload as Record<string, unknown>,
				});
			});

			seedHumanReworkDecision(env);

			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);

			// 有空槽 → 当场入道并投递成功，公开接口不再是 E_MESSAGE_UNDELIVERED。
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ applied: true });

			const decidedGate = container.repos.gates?.findById('human-review-gate');
			expect(decidedGate?.decision).toBe('reject');
			expect(decidedGate?.comment).toBe(REWORK_COMMENT);

			// 人工决定当场计数一次；实施行迁 reworking 并当场拿到泳道。
			const implRun = container.repos.runs.findById('ended-impl-run');
			expect(implRun?.rework_count).toBe(1);
			expect(implRun?.state).toBe('reworking');
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBe(1);

			// 恢复分支：新运行继承计数与厂商会话引用，进程真的起来了。
			const reworkRun = container.repos.runs
				.listByTaskId('task-1')
				.find((run) => run.origin === 'rework');
			expect(reworkRun).toBeDefined();
			expect(reworkRun?.state).toBe('running');
			expect(reworkRun?.rework_count).toBe(1);
			expect(reworkRun?.vendor_session_ref).toBe('vendor-session-1');
			expect(reworkRun?.worktree_path).toBe(join(env.tempDir, 'worktrees', 'task-1'));

			// 假进程可观察：返工意见与会话引用都进了启动参数。
			const reworkProc = spawnedProcesses.find((p) => p.launchSpec.runId === reworkRun?.id);
			expect(reworkProc).toBeDefined();
			const args = reworkProc?.launchSpec.args ?? [];
			expect(args[0]).toBe('exec');
			expect(args).toContain('resume');
			expect(args).toContain('vendor-session-1');
			expect(args).toContain(REWORK_COMMENT);
			expect(reworkProc?.launchSpec.cwd).toBe(join(env.tempDir, 'worktrees', 'task-1'));

			// AC 4：事务后发 run.rework_dispatched{mode:'resume'}
			const dispatched = publishedEvents.find((e) => e.kind === 'run.rework_dispatched');
			expect(dispatched?.payload.mode).toBe('resume');
			expect(dispatched?.payload.source).toBe('human');
		});

		it('E-327 / E-279 / #136: real container opens a new origin=rework run when the agent can neither reply nor resume', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses, clock } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			// generic-acp 收窄能力位：canReply=false、canResume=false（E-186 / E-279）
			container.repos.dispatchSnapshots?.insert({
				id: 'snap-generic',
				task_id: 'task-1',
				contract_hash: 'contract-hash-task-1',
				task_paths_json: '[]',
				launch_spec_json: JSON.stringify({ adapterKind: 'generic-acp' }),
				created_at: clock.now(),
			});

			seedHumanReworkDecision(env, { snapshotId: 'snap-generic', vendorSessionRef: null });

			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(response.statusCode).toBe(200);

			const reworkRun = container.repos.runs
				.listByTaskId('task-1')
				.find((run) => run.origin === 'rework');
			expect(reworkRun).toBeDefined();
			expect(reworkRun?.state).toBe('running');
			expect(reworkRun?.rework_count).toBe(1);
			expect(reworkRun?.vendor_session_ref).toBeNull();

			const reworkProc = spawnedProcesses.find((p) => p.launchSpec.runId === reworkRun?.id);
			expect(reworkProc).toBeDefined();
			const args = reworkProc?.launchSpec.args ?? [];
			// E-279：无续接能力 → codex 走 exec 模式，自包含提示词必须进启动参数。
			expect(args[0]).toBe('exec');
			expect(args).not.toContain('resume');
			const prompt = args.at(-1) ?? '';
			expect(prompt).toContain(REWORK_COMMENT);
			expect(prompt).toContain('收到返工指令时');
			expect(prompt).toContain('- 工作区目录:');
			expect(prompt).toContain('不 commit/push');
		});

		it('E-327 / #136: a rework parked for a lane is delivered by the scheduler tick once a slot frees, before new tasks', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses, clock } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			// laneCount=1，槽位被另一个停靠任务占着（E-326 / E-327）
			container.repos.documents.updateLaneCount('doc-1', 1);
			container.repos.tasks.insert({
				id: 'task-holder',
				doc_id: 'doc-1',
				task_key: 'M8-T0',
				title: 'Lane holder',
				module_key: 'M8',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'paused',
				contract_hash: 'contract-hash-holder',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			container.repos.tasks.assignLaneNo('task-holder', 1);

			seedHumanReworkDecision(env);

			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			// 无空槽：闸门决定成功但返工排队，不报投递失败，也绝不假装已投递。
			expect(response.statusCode).toBe(200);
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
			expect(container.repos.runs.findById('ended-impl-run')?.state).toBe('reworking');
			expect(container.repos.runs.findById('ended-impl-run')?.queued_reason).toBe('lane_full');
			expect(spawnedProcesses.length).toBe(0);

			// 槽位空出 → 下一次 tick 先于新任务把返工入道
			container.repos.tasks.clearLaneNo('task-holder');
			await container.services.dispatch.tick();

			const delivered = await waitFor(() =>
				spawnedProcesses.some((p) => p.launchSpec.args.includes(REWORK_COMMENT)),
			);
			expect(delivered).toBe(true);
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBe(1);
			expect(container.repos.runs.findById('ended-impl-run')?.rework_count).toBe(1);
		});

		it('E-327 / #136: a paused batch keeps the rework queued and the next tick delivers it after the batch resumes', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			container.repos.batches.updateState({ id: 'batch-1', state: 'paused' });
			seedHumanReworkDecision(env);

			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(response.statusCode).toBe(200);
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
			expect(container.repos.runs.findById('ended-impl-run')?.queued_reason).toBe('batch_paused');
			expect(spawnedProcesses.length).toBe(0);

			container.repos.batches.updateState({ id: 'batch-1', state: 'running' });
			await container.services.dispatch.tick();

			const delivered = await waitFor(() =>
				spawnedProcesses.some((p) => p.launchSpec.args.includes(REWORK_COMMENT)),
			);
			expect(delivered).toBe(true);
			expect(container.repos.runs.findById('ended-impl-run')?.rework_count).toBe(1);
		});

		it('E-327 / #136: a failed rework start is a typed undelivered decision, parks the task at the human gate, and the next decision delivers and continues to review', async () => {
			let behavior: 'throw' | 'ok' = 'throw';
			const env = setupWiringEnvironment({ spawnBehavior: () => behavior });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const publishedEvents: string[] = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push(envelope.kind);
			});

			// 无续接能力的快照 → 走「新开 origin=rework 实施运行」分支（E-279）
			container.repos.dispatchSnapshots?.insert({
				id: 'snap-generic',
				task_id: 'task-1',
				contract_hash: 'contract-hash-task-1',
				task_paths_json: '[]',
				launch_spec_json: JSON.stringify({ adapterKind: 'generic-acp' }),
				created_at: env.clock.now(),
			});
			seedHumanReworkDecision(env, { snapshotId: 'snap-generic', vendorSessionRef: null });

			// 第一次打回：spawn 直接抛错 → 公开闸门回类型化失败，任务交回人手，绝不假装投递成功
			const first = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(first.statusCode).toBe(422);
			const firstError = first.json() as {
				error: { code: string; details?: { reason?: string; reworkRunId?: string } };
			};
			expect(firstError.error.code).toBe('E_MESSAGE_UNDELIVERED');
			expect(firstError.error.details?.reason).toBe('spawn_failed');

			// 闸门决定与计数只记一次；失败的那条返工行落 failed 带类型化原因
			const targetAfterFailure = container.repos.runs.findById('ended-impl-run');
			expect(targetAfterFailure?.rework_count).toBe(1);
			const failedReworkRun = container.repos.runs
				.listByTaskId('task-1')
				.find((run) => run.origin === 'rework');
			expect(failedReworkRun?.state).toBe('failed');
			expect(failedReworkRun?.queued_reason).toBe('rework_delivery_failed:spawn_failed');
			expect(failedReworkRun?.rework_count).toBe(1);

			// 不占槽、不归档仍需恢复的会话、不发成功事件
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
			expect(targetAfterFailure?.session_archived_at ?? null).toBeNull();
			expect(failedReworkRun?.session_archived_at ?? null).toBeNull();
			expect(publishedEvents).not.toContain('run.rework_dispatched');
			expect(publishedEvents).toContain('lane.released');

			// 交回人手：任务停在 awaiting_human 带原因，且有一张 waiting 闸门卡当可操作入口
			expect(targetAfterFailure?.state).toBe('awaiting_human');
			expect(targetAfterFailure?.queued_reason).toBe('rework_delivery_failed:spawn_failed');
			const retryGate = container.repos.gates
				?.list({ pendingOnly: true })
				.find((gate) => gate.task_id === 'task-1' && gate.state === 'waiting');
			expect(retryGate).toBeDefined();
			expect(retryGate?.comment).toBe('rework_delivery_failed:spawn_failed');
			if (!retryGate) return;

			// 第二次打回（同一个公开入口）：这次进程真的起来 → 意见进启动参数 → 退出后进下一轮审查
			behavior = 'ok';
			const second = await postReworkDecision(server, token, retryGate.id, REWORK_COMMENT);
			expect(second.statusCode).toBe(200);

			const deliveredProc = spawnedProcesses.find((p) =>
				p.launchSpec.args.some((arg) => arg.includes(REWORK_COMMENT)),
			);
			expect(deliveredProc).toBeDefined();
			if (!deliveredProc) return;

			expect(targetAfterFailure?.rework_count).toBe(1);
			const landedReworkRun = container.repos.runs.findById(deliveredProc.launchSpec.runId);
			expect(landedReworkRun?.rework_count).toBe(2);
			expect(container.repos.runs.findById('ended-impl-run')?.rework_count).toBe(2);
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBe(1);

			deliveredProc.emitLine(
				'{"method":"item/agentMessage/delta","params":{"delta":"Rework applied after retry."}}',
			);
			await new Promise((r) => setTimeout(r, 30));
			deliveredProc.emitExit(0);

			const continued = await waitFor(() =>
				container.repos.runs
					.listByTaskId('task-1')
					.some(
						(run) => run.kind === 'review' && run.parent_run_id === deliveredProc.launchSpec.runId,
					),
			);
			expect(continued).toBe(true);
		});

		it('E-327 / #136: when the tick-driven delivery fails, the task parks at the human gate and the retry delivers into the next review round', async () => {
			let behavior: 'throw' | 'ok' = 'throw';
			const env = setupWiringEnvironment({ spawnBehavior: () => behavior });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const publishedEvents: string[] = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push(envelope.kind);
			});

			// 一个槽位被占住 → 打回只能排队，交付交给调度 tick（E-327）
			container.repos.documents.updateLaneCount('doc-1', 1);
			container.repos.tasks.insert({
				id: 'task-holder',
				doc_id: 'doc-1',
				task_key: 'M8-T0',
				title: 'Lane holder',
				module_key: 'M8',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'paused',
				contract_hash: 'contract-hash-holder',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			container.repos.tasks.assignLaneNo('task-holder', 1);
			container.repos.dispatchSnapshots?.insert({
				id: 'snap-generic',
				task_id: 'task-1',
				contract_hash: 'contract-hash-task-1',
				task_paths_json: '[]',
				launch_spec_json: JSON.stringify({ adapterKind: 'generic-acp' }),
				created_at: env.clock.now(),
			});
			seedHumanReworkDecision(env, { snapshotId: 'snap-generic', vendorSessionRef: null });

			const decision = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(decision.statusCode).toBe(200);
			expect(container.repos.runs.findById('ended-impl-run')?.queued_reason).toBe('lane_full');

			// 槽位空出 → tick 补位投递 → spawn 抛错：任务交回人手，而不是被那条失败的返工行挡住
			container.repos.tasks.clearLaneNo('task-holder');
			await container.services.dispatch.tick();
			const parked = await waitFor(
				() => container.repos.runs.findById('ended-impl-run')?.state === 'awaiting_human',
			);
			expect(parked).toBe(true);

			expect(publishedEvents).not.toContain('run.rework_dispatched');
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
			const targetAfterTickFailure = container.repos.runs.findById('ended-impl-run');
			expect(targetAfterTickFailure?.queued_reason).toBe('rework_delivery_failed:spawn_failed');
			expect(targetAfterTickFailure?.rework_count).toBe(1);
			expect(targetAfterTickFailure?.session_archived_at ?? null).toBeNull();

			const retryGate = container.repos.gates
				?.list({ pendingOnly: true })
				.find((gate) => gate.task_id === 'task-1' && gate.state === 'waiting');
			expect(retryGate?.comment).toBe('rework_delivery_failed:spawn_failed');
			if (!retryGate) return;

			// 恢复投递：同一个人工入口再打回一次，进程真的起来 → 退出后进下一轮审查
			behavior = 'ok';
			const retry = await postReworkDecision(server, token, retryGate.id, REWORK_COMMENT);
			expect(retry.statusCode).toBe(200);

			const deliveredProc = spawnedProcesses.find((p) =>
				p.launchSpec.args.some((arg) => arg.includes(REWORK_COMMENT)),
			);
			expect(deliveredProc).toBeDefined();
			if (!deliveredProc) return;

			deliveredProc.emitLine(
				'{"method":"item/agentMessage/delta","params":{"delta":"Rework applied after tick failure."}}',
			);
			await new Promise((r) => setTimeout(r, 30));
			deliveredProc.emitExit(0);

			const continued = await waitFor(() =>
				container.repos.runs
					.listByTaskId('task-1')
					.some(
						(run) => run.kind === 'review' && run.parent_run_id === deliveredProc.launchSpec.runId,
					),
			);
			expect(continued).toBe(true);
		});

		it('E-327 / #136: a rework run that spawns and immediately exits is not a successful delivery either', async () => {
			const env = setupWiringEnvironment({
				spawnBehavior: (spec) => (spec.runId === 'ended-impl-run' ? 'ok' : 'exit-immediately'),
			});
			const { container } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			const publishedEvents: string[] = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push(envelope.kind);
			});

			container.repos.dispatchSnapshots?.insert({
				id: 'snap-generic',
				task_id: 'task-1',
				contract_hash: 'contract-hash-task-1',
				task_paths_json: '[]',
				launch_spec_json: JSON.stringify({ adapterKind: 'generic-acp' }),
				created_at: env.clock.now(),
			});
			seedHumanReworkDecision(env, { snapshotId: 'snap-generic', vendorSessionRef: null });

			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(response.statusCode).toBe(422);
			const error = response.json() as { error: { code: string; details?: { reason?: string } } };
			expect(error.error.code).toBe('E_MESSAGE_UNDELIVERED');
			expect(error.error.details?.reason).toBe('premature_exit');

			// 启动即退出：不得发 run.rework_dispatched，任务不占槽、停在人工入口
			expect(publishedEvents).not.toContain('run.rework_dispatched');
			expect(container.repos.tasks.findById('task-1')?.lane_no).toBeNull();
			const target = container.repos.runs.findById('ended-impl-run');
			expect(target?.state).toBe('awaiting_human');
			expect(target?.queued_reason).toBe('rework_delivery_failed:premature_exit');
			expect(target?.rework_count).toBe(1);
			expect(target?.session_archived_at ?? null).toBeNull();
		});

		it('E-327 / #136: at agent maxConcurrency=1 the tick still admits a queued rework once a lane frees', async () => {
			const env = setupWiringEnvironment({ agentMaxConcurrency: 1 });
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			// 默认注册表就是每 agent 1 个名额：被返工的那条旧实施行不该再占住它（E-47 / E-54）
			container.repos.documents.updateLaneCount('doc-1', 1);
			container.repos.tasks.insert({
				id: 'task-holder',
				doc_id: 'doc-1',
				task_key: 'M8-T0',
				title: 'Lane holder',
				module_key: 'M8',
				deps_json: '[]',
				est_days: 1,
				batch_id: 'batch-1',
				manual_state: 'paused',
				contract_hash: 'contract-hash-holder',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
				has_accept_changed: 0,
				has_prompt_changed: 0,
				is_removed_from_doc: 0,
			});
			container.repos.tasks.assignLaneNo('task-holder', 1);

			seedHumanReworkDecision(env);
			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(response.statusCode).toBe(200);
			expect(container.repos.runs.findById('ended-impl-run')?.queued_reason).toBe('lane_full');
			expect(spawnedProcesses.length).toBe(0);

			container.repos.tasks.clearLaneNo('task-holder');
			await container.services.dispatch.tick();

			const delivered = await waitFor(() =>
				spawnedProcesses.some((p) => p.launchSpec.args.includes(REWORK_COMMENT)),
			);
			expect(delivered).toBe(true);
			expect(container.repos.runs.findById('ended-impl-run')?.rework_count).toBe(1);
		});

		it('E-327 / #136: the rework run that exits cleanly continues into the next review round', async () => {
			const env = setupWiringEnvironment();
			const { container, spawnedProcesses } = env;
			const server = createHttpServer({ container });
			await server.instance.ready();
			const token = await getAuthToken(container);

			seedHumanReworkDecision(env);
			const response = await postReworkDecision(server, token, 'human-review-gate', REWORK_COMMENT);
			expect(response.statusCode).toBe(200);

			const reworkRun = container.repos.runs
				.listByTaskId('task-1')
				.find((run) => run.origin === 'rework');
			const reworkProc = spawnedProcesses.find((p) => p.launchSpec.runId === reworkRun?.id);
			expect(reworkProc).toBeDefined();

			reworkProc?.emitLine(
				'{"method":"item/agentMessage/delta","params":{"delta":"Rework applied."}}',
			);
			await new Promise((r) => setTimeout(r, 30));
			reworkProc?.emitExit(0);

			const continued = await waitFor(() =>
				container.repos.runs
					.listByTaskId('task-1')
					.some((run) => run.kind === 'review' && run.parent_run_id === reworkRun?.id),
			);
			expect(continued).toBe(true);
		});

		it('AC 2 & E-53 & E-57: Real container + fake process: exit 0 -> evaluateMechanicalCheck called -> kind=review inserted -> review verdict pass -> waiting gate -> POST decide -> landed by:human', async () => {
			const env = setupWiringEnvironment({ codexExecPath: '/opt/codex-custom' });
			const { container, spawnedProcesses, agentRegistry } = env;
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
			const configChange = await agentRegistry.updateOverrides('codex', {
				execPath: '/opt/codex-changed-after-dispatch',
			});
			expect(configChange.ok).toBe(true);

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
			expect(implProc.launchSpec.file).toBe('/opt/codex-custom');
			expect(implProc.launchSpec.args.slice(0, 2)).toEqual(['exec', '--json']);

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

			// Listen for real completion signal (task.review_verdict)
			const verdictPromise = new Promise<{ verdict: string }>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error('Timeout waiting for task.review_verdict completion signal'));
				}, 10000);
				const unsub = container.events.bus.subscribe((envelope) => {
					if (envelope.kind === 'task.review_verdict') {
						clearTimeout(timer);
						unsub();
						resolve(envelope.payload as { verdict: string });
					}
				});
			});

			// Review process emits VERDICT: pass and exits 0
			reviewProc?.emitLine('VERDICT: pass\nAll acceptance criteria met.');
			await new Promise((r) => setTimeout(r, 30));

			reviewProc?.emitExit(0);
			const verdictPayload = await verdictPromise;
			expect(verdictPayload.verdict).toBe('pass');

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
			const gatesRepo = container.repos.gates;
			expect(gatesRepo).toBeDefined();
			if (!gatesRepo) throw new Error('gatesRepo missing');
			const gates = gatesRepo.list({ pendingOnly: true });
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
			expect(implProc).toBeDefined();
			if (!implProc) throw new Error('implProc missing');
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

			// Listen for real completion signal (task.review_verdict)
			const verdictPromise = new Promise<{ verdict: string }>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error('Timeout waiting for task.review_verdict completion signal'));
				}, 5000);
				const unsub = container.events.bus.subscribe((envelope) => {
					if (envelope.kind === 'task.review_verdict') {
						clearTimeout(timer);
						unsub();
						resolve(envelope.payload as { verdict: string });
					}
				});
			});

			// Review process emits output with verdict pass, then IMMEDIATELY emits exit(0)
			reviewProc.emitLine('VERDICT: pass\nImplementation verified cleanly.');
			reviewProc.emitExit(0);

			// Wait for real completion signal
			const verdictPayload = await verdictPromise;
			expect(verdictPayload.verdict).toBe('pass');

			// Verify task.review_verdict was emitted with pass (not failed or unparsed)
			const verdictEvent = publishedEvents.find(
				(e) =>
					e.kind === 'task.review_verdict' && (e.payload as { verdict: string }).verdict === 'pass',
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

			const publishedEvents: Array<{ kind: string; runId?: string | null; payload: unknown }> = [];
			container.events.bus.subscribe((envelope) => {
				publishedEvents.push({
					kind: envelope.kind,
					runId: envelope.runId,
					payload: envelope.payload,
				});
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
			expect(implProc).toBeDefined();
			if (!implProc) throw new Error('implProc missing');
			implProc.emitLine('{"method":"item/agentMessage/delta","params":{"delta":"Done."}}');
			await new Promise((r) => setTimeout(r, 30));

			const failSettlePromise = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error('Timeout waiting for awaiting_human state change'));
				}, 5000);
				const unsub = container.events.bus.subscribe((envelope) => {
					if (
						envelope.kind === 'run.state_changed' &&
						envelope.runId === implRunId &&
						(envelope.payload as { to?: string })?.to === 'awaiting_human'
					) {
						clearTimeout(timer);
						unsub();
						resolve();
					}
				});
			});

			// Now enable spawn failure before implementation process exits
			shouldFailSpawn = true;
			implProc.emitExit(0);

			// Wait for exit evaluation to settle
			await failSettlePromise;

			// 1. Implementation run must NOT be stuck in reviewing; must be in awaiting_human
			const implRun = container.repos.runs.findById(implRunId);
			expect(implRun?.state).toBe('awaiting_human');
			expect(implRun?.queued_reason).toContain(
				'review_dispatch_failed: Adapter failed to allocate resources',
			);

			// 2. Waiting gate must be created with error evidence
			const gatesRepo = container.repos.gates;
			expect(gatesRepo).toBeDefined();
			if (!gatesRepo) throw new Error('gatesRepo missing');
			const gates = gatesRepo.list({ pendingOnly: true });
			const reviewGate = gates.find((g) => g.run_id === implRunId && g.kind === 'review');
			expect(reviewGate).toBeDefined();
			expect(reviewGate?.state).toBe('waiting');
			expect(reviewGate?.comment).toContain(
				'review_dispatch_failed: Adapter failed to allocate resources',
			);

			// 3. Events must have been published
			const gateWaitingEvent = publishedEvents.find((e) => e.kind === 'task.gate_waiting');
			expect(gateWaitingEvent).toBeDefined();
			const stateChangedEvent = publishedEvents.find(
				(e) =>
					e.kind === 'run.state_changed' &&
					e.runId === implRunId &&
					(e.payload as { to: string }).to === 'awaiting_human' &&
					(e.payload as { reason: string }).reason === 'review_dispatch_failed',
			);
			expect(stateChangedEvent).toBeDefined();

			// 4. Review run must NOT be stuck in starting; must be transitioned to failed with error reason
			const runsForTask = container.repos.runs.listByTaskId('task-1');
			const reviewRuns = runsForTask.filter((r) => r.kind === 'review');
			expect(reviewRuns).toHaveLength(1);
			const failedReviewRun = reviewRuns[0];
			expect(failedReviewRun?.state).toBe('failed');
			expect(failedReviewRun?.queued_reason).toContain(
				'review_dispatch_failed: Adapter failed to allocate resources',
			);
			const reviewFailedEvent = publishedEvents.find(
				(e) =>
					e.kind === 'run.state_changed' &&
					e.runId === failedReviewRun?.id &&
					(e.payload as { to: string }).to === 'failed' &&
					(e.payload as { reason: string }).reason === 'review_dispatch_failed',
			);
			expect(reviewFailedEvent).toBeDefined();

			// 5. Repeat trigger must not produce residual runs or duplicate gates
			await container.services.review.evaluateMechanicalCheck({
				runId: implRunId,
			});

			const runsAfterRepeat = container.repos.runs.listByTaskId('task-1');
			const reviewRunsAfterRepeat = runsAfterRepeat.filter((r) => r.kind === 'review');
			expect(reviewRunsAfterRepeat).toHaveLength(1);
			expect(reviewRunsAfterRepeat[0]?.id).toBe(failedReviewRun?.id);
			expect(reviewRunsAfterRepeat[0]?.state).toBe('failed');

			const gatesAfterRepeat = gatesRepo.list({ pendingOnly: true });
			const reviewGatesAfterRepeat = gatesAfterRepeat.filter(
				(g) => g.run_id === implRunId && g.kind === 'review',
			);
			expect(reviewGatesAfterRepeat).toHaveLength(1);
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
				(e) =>
					e.kind === 'lane.released' && (e.payload as { taskId: string }).taskId === 'task-auto',
			);
			expect(autoLaneReleased).toBeDefined();

			const autoLandedEvent = publishedEvents.find(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'auto',
			);
			expect(autoLandedEvent).toBeDefined();

			const autoSessionsArchived = publishedEvents.find(
				(e) =>
					e.kind === 'task.sessions_archived' &&
					(e.payload as { taskId: string }).taskId === 'task-auto',
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

			const gatesRepo = container.repos.gates;
			expect(gatesRepo).toBeDefined();
			if (!gatesRepo) throw new Error('gatesRepo missing');
			gatesRepo.create({
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
				(e) =>
					e.kind === 'lane.released' && (e.payload as { taskId: string }).taskId === 'task-manual',
			);
			expect(manualLaneReleased).toBeDefined();

			const manualLandedEvent = publishedEvents.find(
				(e) => e.kind === 'task.landed' && (e.payload as { by: string }).by === 'human',
			);
			expect(manualLandedEvent).toBeDefined();

			const manualSessionsArchived = publishedEvents.find(
				(e) =>
					e.kind === 'task.sessions_archived' &&
					(e.payload as { taskId: string }).taskId === 'task-manual',
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
