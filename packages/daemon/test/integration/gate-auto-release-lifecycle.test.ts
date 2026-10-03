import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { MAX_PENDING_EVENT_RESERVATIONS } from '../../src/events/publication-order.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { SupportedPlatform } from '../../src/platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import type { ManagedProcess } from '../../src/proc/spawn.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';

const cleanups: Array<() => Promise<void>> = [];
const now = '2026-10-02T10:00:00.000Z';
const allAuto: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'auto' };

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createGateEnvironment() {
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-gate-release-'));
	const db = openDatabase(':memory:');
	const processRegistry = createProcessRegistry();
	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
	}
	const container = createContainer({
		processRegistry,
		agentRegistry: createAgentRegistry({
			dataDir,
			builtInDefaults: {},
			publishWarning: (warning) => {
				throw new Error(warning.message);
			},
			platform: process.platform === 'win32' ? 'win32' : 'posix',
		}),
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		hostInputs: {
			platform: process.platform as SupportedPlatform,
			homedir: dataDir,
			pathEnv: process.env.PATH,
		},
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => now },
		bootstrapPairing: false,
	});
	const server = createHttpServer({ container });
	cleanups.push(async () => {
		await server.close();
		await container.services.agents.stop();
		db.close();
		await rm(dataDir, { recursive: true, force: true });
	});
	await server.instance.ready();
	await container.services.agents.start();
	const code =
		container.services.pairing.getActivePairingCode()?.code ??
		container.services.pairing.createPairingCode().code;
	const claim = await container.services.pairing.claimPairingCode({
		code,
		deviceName: 'gate-release-test',
	});
	container.repos.documents.insert({
		id: 'doc',
		docs_path: '/docs',
		project_name: 'gate-release-test',
		repo_path: dataDir,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 1,
		content_fingerprint: 'fp',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: now,
		last_seen_at: now,
	});
	container.repos.tasks.insert({
		id: 'task',
		doc_id: 'doc',
		task_key: 'M6-T5',
		title: 'Gate release lifecycle',
		module_key: 'M6',
		deps_json: '[]',
		contract_hash: 'contract',
		is_contract_ready: 1,
		contract_reasons_json: '[]',
		lane_no: 1,
	});
	container.repos.dispatchSnapshots?.insert({
		id: 'snapshot',
		task_id: 'task',
		contract_hash: 'contract',
		task_paths_json: '[]',
		launch_spec_json: '{}',
		created_at: now,
	});
	const seedRun = (
		id: string,
		kind: 'implement' | 'review',
		attemptNo: number,
		pid: number | null,
	) => {
		container.repos.runs.insert({
			id,
			task_id: 'task',
			attempt_no: attemptNo,
			kind,
			state: 'running',
			agent_id: 'codex',
			permission_tier: kind === 'review' ? 'readOnly' : 'workspaceWrite',
			snapshot_id: 'snapshot',
			pid,
			lane_no: 1,
			vendor_session_ref: `${id}-vendor-session`,
		});
	};
	const setGates = (gates: GateSettings) =>
		server.instance.inject({
			method: 'PATCH',
			url: '/api/v1/settings/gates',
			headers: { authorization: `Bearer ${claim.token}` },
			payload: gates,
		});
	return { container, seedRun, setGates, db, processRegistry };
}

async function prepareWaitingGate(gateKind: 'review' | 'landing', pid: number | null = null) {
	const env = await createGateEnvironment();
	const { container, seedRun, setGates, db } = env;
	const initial: GateSettings = {
		dispatch: 'auto',
		review: gateKind === 'review' ? 'manual' : 'auto',
		landing: gateKind === 'landing' ? 'manual' : 'auto',
	};
	expect((await setGates(initial)).statusCode).toBe(200);
	seedRun('implementation', 'implement', 1, pid);
	seedRun('review', 'review', 2, null);
	db.prepare("UPDATE runs SET state = 'reviewing' WHERE id = 'implementation'").run();
	db.prepare(
		"UPDATE runs SET state = 'exited', parent_run_id = 'implementation' WHERE id = 'review'",
	).run();
	await container.services.gates.resolveAfterReviewAndApply({
		taskId: 'task',
		runId: 'implementation',
		reviewVerdict: 'pass',
	});
	expect(container.repos.gates?.list({ pendingOnly: true }).map((gate) => gate.kind)).toEqual([
		gateKind,
	]);
	return { ...env, initial };
}

describe('settings auto-release task lifecycle', () => {
	it.each([
		{ gateKind: 'review', superseded: true },
		{ gateKind: 'landing', superseded: true },
		{ gateKind: 'review', superseded: false },
		{ gateKind: 'landing', superseded: false },
	] as const)(
		'preserves stale $gateKind gate state (new attempt: $superseded)',
		async ({ gateKind, superseded }) => {
			const { container, seedRun, setGates, db } = await prepareWaitingGate(gateKind);
			const priorState = superseded ? 'reviewing' : 'aborted';
			db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(priorState, 'implementation');
			if (superseded) seedRun('new-implementation', 'implement', 3, null);
			const events: EventEnvelope[] = [];
			container.events.bus.subscribe((event) => events.push(event));
			expect((await setGates(allAuto)).statusCode).toBe(200);
			expect(container.repos.runs.findById('implementation')?.state).toBe(priorState);
			expect(container.repos.tasks.findById('task')).toMatchObject({
				manual_state: 'awaiting_human',
				lane_no: 1,
			});
			expect(
				container.repos.runs.listByTaskId('task').every((run) => run.session_archived_at === null),
			).toBe(true);
			if (superseded)
				expect(container.repos.runs.findById('new-implementation')?.state).toBe('running');
			expect(container.repos.gates?.list({ pendingOnly: true }).map((gate) => gate.kind)).toEqual([
				gateKind,
			]);
			expect(events.map((event) => event.kind)).toEqual(['settings.gates_changed']);
		},
	);

	it.each(['review', 'landing'] as const)(
		'settles the task and sessions when a waiting %s gate becomes automatic',
		async (gateKind) => {
			const { container, setGates, db } = await prepareWaitingGate(gateKind);
			expect((await setGates(allAuto)).statusCode).toBe(200);
			expect(container.repos.tasks.findById('task')?.manual_state).toBe('landed');
			expect(container.repos.gates?.list({ pendingOnly: true })).toEqual([]);
			expect.soft(container.repos.runs.findById('implementation')?.state).toBe('landed');
			expect.soft(container.repos.tasks.findById('task')?.lane_no).toBeNull();
			expect
				.soft(container.repos.runs.listByTaskId('task').map((run) => run.session_archived_at))
				.toEqual([now, now]);
			container.repos.batches.insert({
				id: 'next-batch',
				doc_id: 'doc',
				batch_no: 1,
				state: 'running',
				started_at: now,
			});
			container.repos.tasks.insert({
				id: 'next-task',
				doc_id: 'doc',
				task_key: 'M8-T1',
				title: 'Next task',
				module_key: 'M8',
				deps_json: '[]',
				batch_id: 'next-batch',
				contract_hash: 'next',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});
			container.repos.tasks.setAssignmentDraft(
				'next-task',
				JSON.stringify({
					agentId: 'codex',
					model: null,
					effort: null,
					draftedAt: now,
				}),
			);
			const dispatchSnapshotsRepo = container.repos.dispatchSnapshots;
			if (!dispatchSnapshotsRepo) throw new Error('Missing production snapshot repository');
			const dispatch = createDispatchService({
				unitOfWork: createUnitOfWork(db),
				tasksRepo: container.repos.tasks,
				runsRepo: container.repos.runs,
				batchesRepo: container.repos.batches,
				documentsRepo: container.repos.documents,
				dispatchSnapshotsRepo,
				clock: { now: () => now },
				ids: container.ids,
				listDispatchableAgents: () => [
					{ agentId: 'codex', canDispatch: true, concurrencyLimit: 1 },
				],
			});
			expect((await dispatch.tick()).tasksDeferred).toEqual([]);
			expect(container.repos.runs.listByTaskId('next-task')).toHaveLength(1);
			expect(container.repos.tasks.findById('next-task')?.lane_no).toBe(1);
		},
	);

	it('rolls back settings, gates, run state, and lane release if session archival fails', async () => {
		const { container, setGates, db, initial } = await prepareWaitingGate('landing');
		const events: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => events.push(event));
		db.exec(`CREATE TRIGGER reject_archive BEFORE UPDATE OF session_archived_at ON runs
			BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END`);
		expect((await setGates(allAuto)).statusCode).toBe(500);
		expect(container.services.settings.getGates()).toEqual(initial);
		expect(container.repos.tasks.findById('task')).toMatchObject({
			manual_state: 'awaiting_human',
			lane_no: 1,
		});
		expect(container.repos.runs.findById('implementation')).toMatchObject({
			state: 'reviewing',
			session_archived_at: null,
		});
		expect(container.repos.gates?.list({ pendingOnly: true }).map((gate) => gate.kind)).toEqual([
			'landing',
		]);
		expect(events).toEqual([]);
		db.exec('DROP TRIGGER reject_archive');
		expect((await setGates(allAuto)).statusCode).toBe(200);
		expect(events.map((event) => event.kind)).toContain('task.sessions_archived');
	});

	it('awaits process termination after committing the landed state and lane release', async () => {
		const { container, setGates, db, processRegistry } = await prepareWaitingGate('landing', 55001);
		let signalStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let finishKill: () => void = () => {};
		const finished = new Promise<void>((resolve) => {
			finishKill = resolve;
		});
		let stateAtKill: unknown;
		processRegistry.register({
			runId: 'implementation',
			pid: 55001,
			kill: async () => {
				stateAtKill = {
					inTransaction: db.inTransaction,
					state: container.repos.runs.findById('implementation')?.state,
					archivedAt: container.repos.runs.findById('implementation')?.session_archived_at,
					laneNo: container.repos.tasks.findById('task')?.lane_no,
				};
				signalStarted();
				await finished;
				return { outcome: 'terminated', attempts: [] };
			},
		} as unknown as ManagedProcess);
		const events: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => events.push(event));
		let replied = false;
		const response = setGates(allAuto).then((value) => {
			replied = true;
			return value;
		});
		await started;
		expect(stateAtKill).toEqual({
			inTransaction: false,
			state: 'landed',
			archivedAt: now,
			laneNo: null,
		});
		expect(replied).toBe(false);
		finishKill();
		expect((await response).statusCode).toBe(200);
		expect(processRegistry.has('implementation')).toBe(false);
		expect(events.filter((event) => event.kind === 'task.sessions_archived')).toMatchObject([
			{ payload: { runIds: ['implementation', 'review'], killedPids: [55001], residualPids: [] } },
		]);
	});

	it('attempts every archived task cleanup when event capacity fails after the first kill', async () => {
		const { container, setGates, processRegistry } = await prepareWaitingGate('landing', 55001);
		container.repos.tasks.insert({
			id: 'second-task',
			doc_id: 'doc',
			task_key: 'M8-T2',
			title: 'Second task',
			module_key: 'M8',
			deps_json: '[]',
			contract_hash: 'second',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});
		container.repos.dispatchSnapshots?.insert({
			id: 'second-snapshot',
			task_id: 'second-task',
			contract_hash: 'second',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: now,
		});
		container.repos.runs.insert({
			id: 'second-implementation',
			task_id: 'second-task',
			attempt_no: 1,
			kind: 'implement',
			state: 'reviewing',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'second-snapshot',
			pid: 55002,
		});
		await container.services.gates.resolveAfterReviewAndApply({
			taskId: 'second-task',
			runId: 'second-implementation',
			reviewVerdict: 'pass',
		});
		const killed: string[] = [];
		const blockers: EventEnvelope[] = [];
		for (const [runId, pid] of [
			['implementation', 55001],
			['second-implementation', 55002],
		] as const) {
			processRegistry.register({
				runId,
				pid,
				kill: async () => {
					killed.push(runId);
					if (blockers.length === 0) {
						for (let i = 0; i < MAX_PENDING_EVENT_RESERVATIONS; i++) {
							blockers.push(
								container.events.envelopeFactory.createEnvelope({
									kind: 'agent_message_chunk',
									payload: { chunk: 'blocked concurrent output' },
								}),
							);
						}
					}
					return { outcome: 'terminated', attempts: [] };
				},
			} as unknown as ManagedProcess);
		}
		try {
			expect((await setGates(allAuto)).statusCode).toBe(429);
			expect(killed.sort()).toEqual(['implementation', 'second-implementation']);
			expect(processRegistry.size).toBe(0);
		} finally {
			for (const event of blockers) container.events.envelopeFactory.cancelEnvelope(event);
		}
	});
});
