import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	AGENT_MESSAGE_CHUNK_EVENT_KIND,
	type EventEnvelope,
} from '@agent-scheduler/shared/api/events';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { SupportedPlatform } from '../../src/platform/contract.ts';
import type { KillTreeProcessOps } from '../../src/platform/kill-tree-contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { ManagedProcess, ProcessExitResult } from '../../src/proc/spawn.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';

const cleanups: Array<() => Promise<void>> = [];
const now = '2026-10-02T10:00:00.000Z';

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createAbortEnvironment(processOps?: KillTreeProcessOps) {
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-abort-lifecycle-'));
	const db = openDatabase(':memory:');
	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
	}
	const container = createContainer({
		processOps,
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
		deviceName: 'abort-test',
	});
	container.repos.documents.insert({
		id: 'doc',
		docs_path: '/docs',
		project_name: 'abort-test',
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
		title: 'Abort lifecycle',
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
	const abort = (runId = 'implementation') =>
		server.instance.inject({
			method: 'POST',
			url: `/api/v1/runs/${runId}/abort`,
			headers: { authorization: `Bearer ${claim.token}` },
			payload: {},
		});
	return { container, seedRun, abort, dataDir, db };
}

describe('production abort lifecycle', () => {
	it('archives every task session and releases its lane when the implementation is stopped', async () => {
		const { container, seedRun, abort } = await createAbortEnvironment();
		seedRun('implementation', 'implement', 1, null);
		seedRun('review', 'review', 2, null);
		container.repos.gates?.create({
			id: 'pending-review',
			task_id: 'task',
			run_id: 'implementation',
			kind: 'review',
			state: 'waiting',
			created_at: now,
		});
		const events: EventEnvelope[] = [];
		container.events.bus.subscribe((event) => {
			events.push(event);
		});
		const response = await abort();
		expect(response.statusCode).toBe(200);
		expect(container.repos.runs.findById('implementation')?.state).toBe('aborted');
		expect(container.repos.tasks.findById('task')?.lane_no).toBeNull();
		expect(container.repos.runs.listByTaskId('task').map((run) => run.session_archived_at)).toEqual(
			[now, now],
		);
		expect(events.filter((event) => event.kind === 'lane.released')).toHaveLength(1);
		expect(events.filter((event) => event.kind === 'task.sessions_archived')).toHaveLength(1);
		expect(container.repos.gates?.list({ pendingOnly: true })).toEqual([]);
	});

	it('records actual uncommitted changes through the container workspace inspector', async () => {
		const { container, seedRun, abort, dataDir, db } = await createAbortEnvironment();
		const worktreePath = join(dataDir, 'repository');
		execFileSync('git', ['init', worktreePath], { stdio: 'pipe' });
		execFileSync(
			'git',
			[
				'-C',
				worktreePath,
				'-c',
				'user.name=Test',
				'-c',
				'user.email=test@example.invalid',
				'commit',
				'--allow-empty',
				'-m',
				'baseline',
			],
			{ stdio: 'pipe' },
		);
		writeFileSync(join(worktreePath, 'unreviewed.txt'), 'work in progress');
		seedRun('implementation', 'implement', 1, null);
		db.prepare('UPDATE runs SET worktree_path = ? WHERE id = ?').run(
			worktreePath,
			'implementation',
		);
		expect((await abort()).statusCode).toBe(200);
		expect(container.repos.runs.findById('implementation')).toMatchObject({
			state: 'aborted',
			changed_file_count: 1,
			queued_reason: '已中止（有未验收改动）',
		});
		expect(readFileSync(join(worktreePath, 'unreviewed.txt'), 'utf8')).toBe('work in progress');
	});

	it.each([
		['running', 'review'],
		['starting', 'review'],
		['starting', 'implement'],
	] as const)(
		'makes agent capacity available after an archived %s %s process exits',
		async (initialState, kind) => {
			const { container, seedRun, abort, db } = await createAbortEnvironment();
			seedRun('implementation', 'implement', 1, null);
			seedRun('review', kind, 2, null);
			const archiveEvents: EventEnvelope[] = [];
			container.events.bus.subscribe((event) => {
				if (event.kind === 'task.sessions_archived') archiveEvents.push(event);
			});
			db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(initialState, 'review');
			let exitReview: ((result: ProcessExitResult) => void) | undefined;
			const reviewProcess = {
				runId: 'review',
				pid: 50002,
				stderrTail: '',
				stderrTailLines: [],
				isExited: false,
				onRaw: () => () => {},
				onStderr: () => () => {},
				onJson: () => () => {},
				onExit: (listener: (result: ProcessExitResult) => void) => {
					exitReview = listener;
					return () => {};
				},
			} as unknown as ManagedProcess;
			const attachment = container.services.run.attachProcess('review', reviewProcess);
			await abort();
			exitReview?.({
				runId: 'review',
				pid: reviewProcess.pid,
				exitCode: 0,
				signal: null,
				reason: 'exited',
			});
			await attachment.waitForCompletion();
			attachment.detach();
			expect(container.repos.runs.findById('review')?.state).toBe(
				initialState === 'starting' ? 'failed' : 'exited',
			);
			expect(container.repos.runs.findActiveByTaskId('task')).toBeNull();
			expect(container.repos.gates?.list({ pendingOnly: true })).toEqual([]);
			expect(archiveEvents).toHaveLength(1);
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
			const tick = await dispatch.tick();
			expect(tick.tasksDeferred).toEqual([]);
			expect(container.repos.runs.listByTaskId('next-task')).toHaveLength(1);
		},
	);

	it('keeps an explicit stop effective when the process exits while its tree is being terminated', async () => {
		let exitListener: ((result: ProcessExitResult) => void) | undefined;
		const result: ProcessExitResult = {
			runId: 'implementation',
			pid: 50001,
			exitCode: null,
			signal: 'SIGTERM',
			reason: 'exited',
		};
		const ops: KillTreeProcessOps = {
			now: () => now,
			signalGroup: () => {
				exitListener?.(result);
				return 'still-running';
			},
			wait: async () => {
				await awaitCompletion?.();
			},
			probeGroup: () => 'terminated',
			taskkill: async () => {
				exitListener?.(result);
				return 'still-running';
			},
			probeTree: async () => 'terminated',
		};
		const { container, seedRun, abort } = await createAbortEnvironment(ops);
		seedRun('implementation', 'implement', 1, result.pid);
		const managed = {
			runId: result.runId,
			pid: result.pid,
			stderrTail: '',
			stderrTailLines: [],
			isExited: false,
			onRaw: () => () => {},
			onStderr: () => () => {},
			onJson: () => () => {},
			onExit: (listener: (exit: ProcessExitResult) => void) => {
				exitListener = listener;
				return () => {
					exitListener = undefined;
				};
			},
		} as unknown as ManagedProcess;
		const attachment = container.services.run.attachProcess(result.runId, managed);
		const awaitCompletion = attachment.waitForCompletion;
		const response = await abort();
		expect(response.statusCode, response.body).toBe(200);
		expect(container.repos.runs.findById(result.runId)?.state).toBe('aborted');
		expect(container.repos.tasks.findById('task')?.lane_no).toBeNull();
		expect(container.repos.gates?.list({ pendingOnly: true })).toEqual([]);
		attachment.detach();
	});

	it('routes a directly stopped review with a pass report to the incomplete-review gate', async () => {
		const { container, seedRun, abort, db } = await createAbortEnvironment();
		seedRun('implementation', 'implement', 1, null);
		seedRun('review', 'review', 2, null);
		db.prepare("UPDATE runs SET state = 'reviewing' WHERE id = 'implementation'").run();
		db.prepare("UPDATE runs SET parent_run_id = 'implementation' WHERE id = 'review'").run();
		let exitReview: ((result: ProcessExitResult) => void) | undefined;
		const process = {
			runId: 'review',
			pid: 50002,
			stderrTail: '',
			stderrTailLines: [],
			isExited: false,
			onRaw: () => () => {},
			onStderr: () => () => {},
			onJson: () => () => {},
			onExit: (listener: (result: ProcessExitResult) => void) => {
				exitReview = listener;
				return () => {};
			},
		} as unknown as ManagedProcess;
		const attachment = container.services.run.attachProcess('review', process);
		await container.services.run.ingestEvent(
			'review',
			container.events.envelopeFactory.createEnvelope({
				kind: AGENT_MESSAGE_CHUNK_EVENT_KIND,
				runId: 'review',
				taskId: 'task',
				payload: { chunk: 'VERDICT: pass\n\nREWORK\n- none\n\nDOC_ISSUE\n- none' },
			}),
		);
		expect((await abort('review')).statusCode).toBe(200);
		exitReview?.({
			runId: 'review',
			pid: process.pid,
			exitCode: null,
			signal: 'SIGTERM',
			reason: 'exited',
		});
		await attachment.waitForCompletion();
		attachment.detach();
		expect(container.repos.runs.findById('review')?.review_verdict).toBe('incomplete');
		expect(container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
		expect(container.repos.gates?.list({ pendingOnly: true }).map((gate) => gate.kind)).toEqual([
			'review',
		]);
		expect(container.repos.runs.findById('implementation')?.session_archived_at).toBeNull();
	});
});
