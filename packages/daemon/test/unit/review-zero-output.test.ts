import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { type UnitOfWork, createUnitOfWork } from '../../src/db/unit-of-work.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import type { ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import { type GatesRepo, createGatesRepo } from '../../src/repo/gates.ts';
import { type RunsRepo, createRunsRepo } from '../../src/repo/runs.ts';
import { type TasksRepo, createTasksRepo } from '../../src/repo/tasks.ts';
import { createRunService } from '../../src/service/run.ts';

type RunServiceDeps = Parameters<typeof createRunService>[0];

interface TestManagedProcess extends ManagedProcess {
	emitExit: (exitCode?: number | null, reason?: string) => void;
	emitJson: (value: unknown) => void;
}

function createMockProcess(options?: {
	exitCode?: number;
	signal?: string | null;
	reason?: string;
	stderrLines?: string[];
}): TestManagedProcess {
	const onExitListeners = new Set<Parameters<ManagedProcess['onExit']>[0]>();
	const onJsonListeners = new Set<Parameters<ManagedProcess['onJson']>[0]>();
	const onStderrListeners = new Set<Parameters<ManagedProcess['onStderr']>[0]>();

	const stderrLines = options?.stderrLines ?? [
		'some error occurred',
		'sk-ant-api03-abcdefghijklmnop1234567890',
	];

	const proc: TestManagedProcess = {
		runId: 'run-1',
		pid: 1234,
		file: 'node',
		args: [],
		cwd: '/tmp',
		child: {} as ManagedProcess['child'],
		stdoutReader: {} as ManagedProcess['stdoutReader'],
		stderrReader: {} as ManagedProcess['stderrReader'],
		timers: {} as ManagedProcess['timers'],
		isExited: false,
		get stderrTail() {
			return stderrLines.join('\n');
		},
		get stderrTailLines() {
			return stderrLines;
		},
		attachAppendQueue: vi.fn(),
		waitForStdinDrain: vi.fn().mockResolvedValue(undefined),
		onStdinDrain: vi.fn().mockReturnValue(() => undefined),
		writeStdin: vi.fn().mockReturnValue(true),
		onLine: vi.fn().mockReturnValue(() => undefined),
		onRaw: vi.fn().mockReturnValue(() => undefined),
		onStderr: (fn) => {
			onStderrListeners.add(fn);
			return () => onStderrListeners.delete(fn);
		},
		onJson: (fn) => {
			onJsonListeners.add(fn);
			return () => onJsonListeners.delete(fn);
		},
		onExit: (fn) => {
			onExitListeners.add(fn);
			return () => onExitListeners.delete(fn);
		},
		onError: vi.fn().mockReturnValue(() => undefined),
		kill: vi.fn().mockResolvedValue({ outcome: 'terminated', attempts: [] }),
		finalize: vi.fn().mockResolvedValue(undefined),
		emitExit: (exitCode = options?.exitCode ?? 0, reason = options?.reason ?? 'exited') => {
			for (const fn of onExitListeners) {
				fn({
					runId: 'run-1',
					pid: 1234,
					exitCode,
					signal: (options?.signal as ProcessExitResult['signal']) ?? null,
					reason: (reason ?? 'exited') as ProcessExitResult['reason'],
				});
			}
		},
		emitJson: (value: unknown) => {
			for (const fn of onJsonListeners) {
				fn({
					isJson: true,
					value,
					text: JSON.stringify(value),
					truncated: false,
					rawByteLen: 10,
				});
			}
		},
	};

	return proc;
}

describe('M8-T9 Review Zero Output (AC 7, AC 8, E-348, E-62, E-354)', () => {
	let db: DatabaseConnection;
	let runsRepo: RunsRepo;
	let tasksRepo: TasksRepo;
	let gatesRepo: GatesRepo;
	let unitOfWork: UnitOfWork;
	let bus: EventBus;
	let published: EventEnvelope[];
	let envelopeFactory: EnvelopeFactory;
	let mockAgentService: {
		refreshLogin: ReturnType<typeof vi.fn>;
		getAvailability: ReturnType<typeof vi.fn>;
	};
	let evaluateMechanicalCheckMock: ReturnType<typeof vi.fn>;
	let finalizeReviewMock: ReturnType<typeof vi.fn>;
	let logstoreMock: {
		appendRaw: ReturnType<typeof vi.fn>;
		appendEvent: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		db = openDatabase(':memory:');
		const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');
		const runner = createMigrationRunner({
			database: db,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			fileSystem: {
				readDirectory: (p) => readdirSync(p),
				readFile: (p) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);

		db.prepare(
			"INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at) VALUES ('doc-1', '/doc/path', 'project', 'hash1', '2026-09-17T12:00:00.000Z', '2026-09-17T12:00:00.000Z')",
		).run();
		db.prepare(
			"INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json) VALUES ('task-1', 'doc-1', 'T1', 'Task 1', 'M1', '[]', 'h1', '[]')",
		).run();
		db.prepare(
			"INSERT INTO dispatch_snapshots (id, task_id, contract_hash, task_paths_json, launch_spec_json, created_at) VALUES ('snap-1', 'task-1', 'h1', '[]', '{}', '2026-09-17T12:00:00.000Z')",
		).run();

		runsRepo = createRunsRepo(db);
		tasksRepo = createTasksRepo(db);
		gatesRepo = createGatesRepo(db);
		unitOfWork = createUnitOfWork(db);

		published = [];
		bus = {
			publish: vi.fn((env) => published.push(env)),
		} as unknown as EventBus;

		let envId = 1;
		envelopeFactory = {
			createEnvelope: vi.fn((opts) => ({
				id: envId++,
				ts: '2026-09-17T12:00:00.000Z',
				runId: opts.runId ?? null,
				taskId: opts.taskId ?? null,
				scope: opts.kind.startsWith('lane.')
					? 'lane'
					: opts.kind.startsWith('task.')
						? 'task'
						: 'run',
				kind: opts.kind,
				seq: 0,
				actorDeviceId: opts.actorDeviceId ?? null,
				payload: opts.payload,
			})),
		} as unknown as EnvelopeFactory;

		mockAgentService = {
			refreshLogin: vi.fn().mockResolvedValue(undefined),
			getAvailability: vi.fn().mockReturnValue({ canDispatch: true }),
		};

		evaluateMechanicalCheckMock = vi.fn().mockResolvedValue({ passed: true });
		finalizeReviewMock = vi.fn().mockResolvedValue({ action: 'awaiting_human' });
		logstoreMock = {
			appendRaw: vi.fn().mockResolvedValue({ offset: 0, length: 0 }),
			appendEvent: vi.fn().mockResolvedValue({
				offset: 0,
				length: 0,
				seq: 1,
				location: { fileSeq: 0, byteOffset: 0, byteLen: 0 },
			}),
		};
	});

	it('implementation run exits with code 0 and zero content events -> awaiting_human, exited_before_output, lane released, refreshLogin called once', async () => {
		tasksRepo.assignLaneNo('task-1', 1);

		runsRepo.insert({
			id: 'run-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-1',
			rework_count: 0,
			lane_no: 1,
		});

		const runService = createRunService({
			logFailure: console.error,
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			agentService: mockAgentService,
			evaluateMechanicalCheck: evaluateMechanicalCheckMock,
		});

		const proc = createMockProcess({ exitCode: 0 });
		const controller = runService.attachProcess('run-1', proc);

		// Process exits without emitting any content events
		proc.emitExit(0);
		await controller.waitForCompletion();

		const run = runsRepo.findById('run-1');
		expect(run?.state).toBe('awaiting_human');
		expect(run?.rework_count).toBe(0); // rework_count unchanged

		// Mechanical check was NOT called
		expect(evaluateMechanicalCheckMock).not.toHaveBeenCalled();

		// Gate comment is 'exited_before_output'
		const gate = gatesRepo.list({ pendingOnly: true })[0];
		expect(gate).toBeDefined();
		expect(gate?.comment).toBe('exited_before_output');
		expect(gate?.state).toBe('waiting');

		// Lane released event collected
		const laneReleased = published.find((e) => e.kind === 'lane.released');
		expect(laneReleased).toBeDefined();
		expect(laneReleased?.payload).toEqual(
			expect.objectContaining({
				laneNo: 1,
				reason: 'awaiting_human',
			}),
		);

		// refreshLogin was called with trigger: 'exited_before_output'
		expect(mockAgentService.refreshLogin).toHaveBeenCalledTimes(1);
		expect(mockAgentService.refreshLogin).toHaveBeenCalledWith('codex', {
			force: true,
			trigger: 'exited_before_output',
		});

		// Stderr tail is redacted and <= 20 lines
		const exitedEvent = published.find((e) => e.kind === 'run.exited');
		expect(exitedEvent).toBeDefined();
		const tail = (exitedEvent?.payload as { stderrTail?: string[] })?.stderrTail;
		expect(Array.isArray(tail)).toBe(true);
		expect(tail?.length).toBeLessThanOrEqual(20);
		expect(tail?.some((line: string) => line.includes('[REDACTED]'))).toBe(true);
		expect(tail?.some((line: string) => line.includes('sk-ant-'))).toBe(false);
	});

	it('implementation run exits with code 1 and zero content events -> awaiting_human, exited_before_output', async () => {
		tasksRepo.assignLaneNo('task-1', 2);

		runsRepo.insert({
			id: 'run-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'claude',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-2',
			rework_count: 1,
			lane_no: 2,
		});

		const runService = createRunService({
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			agentService: mockAgentService,
			evaluateMechanicalCheck: evaluateMechanicalCheckMock,
		});

		const proc = createMockProcess({ exitCode: 1 });
		const controller = runService.attachProcess('run-1', proc);

		proc.emitExit(1);
		await controller.waitForCompletion();

		const run = runsRepo.findById('run-1');
		expect(run?.state).toBe('awaiting_human');
		expect(run?.rework_count).toBe(1); // rework_count preserved
		expect(evaluateMechanicalCheckMock).not.toHaveBeenCalled();

		const gate = gatesRepo.list({ pendingOnly: true })[0];
		expect(gate?.comment).toBe('exited_before_output');
		expect(mockAgentService.refreshLogin).toHaveBeenCalledTimes(1);
	});

	it('dsh zero-output exit does not call refreshLogin', async () => {
		runsRepo.insert({
			id: 'run-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'dsh',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-dsh',
		});

		const runService = createRunService({
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			agentService: mockAgentService,
		});

		const proc = createMockProcess({ exitCode: 0 });
		const controller = runService.attachProcess('run-1', proc);

		proc.emitExit(0);
		await controller.waitForCompletion();

		expect(mockAgentService.refreshLogin).not.toHaveBeenCalled();
	});

	it('emitting agent_thought_chunk before exit routes to mechanical check', async () => {
		runsRepo.insert({
			id: 'run-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'running',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-thought',
		});

		const runService = createRunService({
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			evaluateMechanicalCheck: evaluateMechanicalCheckMock,
		});

		const proc = createMockProcess({ exitCode: 0 });
		const controller = runService.attachProcess('run-1', proc);

		// Emits one content event
		proc.emitJson({
			id: 10,
			seq: 0,
			ts: '2026-09-17T12:00:00.000Z',
			kind: 'agent_thought_chunk',
			payload: { text: 'Thinking about the problem...' },
		});

		proc.emitExit(0);
		await controller.waitForCompletion();

		// Mechanical check was called because content was produced
		expect(evaluateMechanicalCheckMock).toHaveBeenCalledTimes(1);
		expect(evaluateMechanicalCheckMock).toHaveBeenCalledWith({ runId: 'run-1', exitCode: 0 });
	});

	it('review run with zero output routes to review_incomplete (E-62)', async () => {
		runsRepo.insert({
			id: 'run-review-1',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'review',
			state: 'running',
			agent_id: 'claude',
			permission_tier: 'readOnly',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-rev',
		});

		const runService = createRunService({
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			finalizeReview: finalizeReviewMock,
		});

		const proc = createMockProcess({ exitCode: 1 });
		const controller = runService.attachProcess('run-review-1', proc);

		proc.emitExit(1);
		await controller.waitForCompletion();

		// finalizeReview invoked to handle review_incomplete
		expect(finalizeReviewMock).toHaveBeenCalledTimes(1);
		expect(finalizeReviewMock).toHaveBeenCalledWith({ runId: 'run-review-1', exitCode: 1 });
	});

	it('startup-timeout does not enter exited_before_output branch and transitions starting -> failed', async () => {
		runsRepo.insert({
			id: 'run-startup',
			task_id: 'task-1',
			attempt_no: 1,
			kind: 'implement',
			state: 'starting',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snap-1',
			idempotency_key: 'idemp-timeout',
		});

		const runService = createRunService({
			logstore: logstoreMock as unknown as RunServiceDeps['logstore'],
			bus,
			envelopeFactory,
			runsRepo: runsRepo as unknown as RunServiceDeps['runsRepo'],
			tasksRepo,
			gatesRepo,
			unitOfWork,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
			evaluateMechanicalCheck: evaluateMechanicalCheckMock,
		});

		const proc = createMockProcess({ exitCode: undefined, reason: 'startup-timeout' });
		const controller = runService.attachProcess('run-startup', proc);

		proc.emitExit(undefined, 'startup-timeout');
		await controller.waitForCompletion();

		const run = runsRepo.findById('run-startup');
		expect(run?.state).toBe('failed');
		expect(evaluateMechanicalCheckMock).not.toHaveBeenCalled();

		// No gate opened for startup timeout
		const gates = gatesRepo.list({ pendingOnly: true });
		expect(gates).toHaveLength(0);
	});
});
