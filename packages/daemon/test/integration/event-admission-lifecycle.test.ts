import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { afterEach, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import { type ManagedProcess, spawnManaged } from '../../src/proc/spawn.ts';
import { createRerunService } from '../../src/service/rerun.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function environment(queuedSettings = 4999) {
	const tempRoot = realpathSync.native(tmpdir());
	const dataDir = mkdtempSync(join(tempRoot, 'agsched-event-admission-'));
	const db = openDatabase(':memory:');
	const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrations)
		.filter((f) => f.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrations, file), 'utf8'));
	}
	let releaseWrite = () => {};
	let observeWrite = () => {};
	const blocked = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const started = new Promise<void>((resolve) => {
		observeWrite = resolve;
	});
	const fs = createNodeLogFileSystem();
	const registry = createProcessRegistry();
	const now = '2026-10-03T10:00:00.000Z';
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		processRegistry: registry,
		hostInputs: { platform: process.platform === 'win32' ? 'win32' : 'linux', homedir: dataDir },
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release() {} } as unknown as LockFileHandle,
		clock: { now: () => now },
		bootstrapPairing: false,
		agentRegistry: createAgentRegistry({
			dataDir,
			builtInDefaults: {},
			platform: 'posix',
			publishWarning() {},
		}),
		logFs: {
			...fs,
			async appendFile(path, bytes) {
				observeWrite();
				await blocked;
				await fs.appendFile(path, bytes);
			},
		},
	});
	expect(container.repos.dispatchSnapshots).toBeDefined();
	expect(container.repos.gates).toBeDefined();
	const server = createHttpServer({ container });
	let ingestion: Promise<unknown> = Promise.resolve();
	cleanups.push(async () => {
		releaseWrite();
		await ingestion;
		await server.close();
		await container.services.agents.stop();
		await container.events.dispose();
		db.close();
		expect(dirname(dataDir)).toBe(tempRoot);
		expect(basename(dataDir)).toMatch(/^agsched-event-admission-/);
		rmSync(dataDir, { recursive: true, force: true });
	});
	await server.instance.ready();
	const claim = await container.services.pairing.claimPairingCode({
		code: container.services.pairing.createPairingCode().code,
		deviceName: 'pressure observer',
	});
	const headers = { authorization: `Bearer ${claim.token}` };
	container.repos.documents.insert({
		id: 'doc',
		docs_path: '/docs',
		project_name: 'pressure',
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
		title: 'pressure',
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
	container.repos.runs.insert({
		id: 'implementation',
		task_id: 'task',
		attempt_no: 1,
		kind: 'implement',
		state: 'running',
		agent_id: 'codex',
		permission_tier: 'workspaceWrite',
		snapshot_id: 'snapshot',
		lane_no: 1,
	});
	const events: EventEnvelope[] = [];
	container.events.bus.subscribe((event) => events.push(event));
	ingestion = container.services.run.ingestEvent(
		'implementation',
		container.events.envelopeFactory.createEnvelope({
			runId: 'implementation',
			kind: 'run.started',
			payload: { runId: 'implementation', taskId: 'task', attemptNo: 1, agentId: 'codex' },
		}),
	);
	await started;
	const pipeline = {
		bughunt: 0 as const,
		wrapupMode: 'auto' as const,
		reviewOverride: null,
		wrapupAssignment: { mode: 'follow' as const },
	};
	// Ordinary committed settings events fill the real queue behind one disk-pending event.
	for (let i = 0; i < queuedSettings; i++)
		container.services.settings.updatePipeline(pipeline, null);
	return {
		dataDir,
		container,
		server,
		headers,
		pipeline,
		registry,
		events,
		release: async () => {
			releaseWrite();
			await ingestion;
		},
	};
}

it('rejects pipeline settings before committing when event admission is full, then permits retry', async () => {
	const env = await environment();
	const original = env.container.services.settings.getPipeline();
	const response = await env.server.instance.inject({
		method: 'PATCH',
		url: '/api/v1/settings/pipeline',
		headers: env.headers,
		payload: { ...env.pipeline, bughunt: 1 },
	});
	expect(response.statusCode).toBe(429);
	expect(env.container.services.settings.getPipeline()).toEqual(original);
	await env.release();
	const retry = await env.server.instance.inject({
		method: 'PATCH',
		url: '/api/v1/settings/pipeline',
		headers: env.headers,
		payload: { ...env.pipeline, bughunt: 1 },
	});
	expect(retry.statusCode).toBe(200);
	expect(env.container.services.settings.getPipeline().bughunt).toBe(1);
});

it('finishes a real process exit after event capacity becomes available', async () => {
	const env = await environment();
	const process = spawnManaged(
		{
			runId: 'implementation',
			file: globalThis.process.execPath,
			args: ['-e', 'process.exit(0)'],
			cwd: env.dataDir,
		},
		{ platform: globalThis.process.platform === 'win32' ? 'win32' : 'linux' },
	);
	const closed = once(process.child, 'close');
	const attached = env.container.services.run.attachProcess('implementation', process);
	cleanups.push(async () => {
		if (!process.isExited) await process.kill();
		attached.detach();
	});
	await closed;
	await env.release();
	await attached.waitForCompletion();
	expect(env.container.repos.runs.findById('implementation')).toMatchObject({
		state: 'awaiting_human',
		queued_reason: 'exited_before_output',
	});
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
	expect(env.events.filter((event) => event.kind === 'run.exited')).toHaveLength(1);
});

it.each([4998, 4999])(
	'keeps a rejected abort retryable with %i queued settings, then really stops the child',
	async (queuedSettings) => {
		const env = await environment(queuedSettings);
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		const closed = once(child, 'close');
		await once(child, 'spawn');
		const pid = child.pid;
		if (!pid) throw new Error('Child has no PID');
		let kills = 0;
		cleanups.push(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await closed;
		});
		env.container.repos.runs.updateState({ id: 'implementation', toState: 'running', pid });
		env.registry.register({
			runId: 'implementation',
			pid,
			isExited: false,
			async kill() {
				kills++;
				child.kill();
				await closed;
				return { outcome: 'terminated', attempts: [], killedPids: [pid], residualPids: [] };
			},
		} as unknown as ManagedProcess);
		const response = await env.server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs/implementation/abort',
			headers: env.headers,
			payload: {},
		});
		expect(response.statusCode).toBe(429);
		expect(env.container.repos.runs.findById('implementation')).toMatchObject({
			state: 'running',
			session_archived_at: null,
		});
		expect(env.container.repos.tasks.findById('task')?.lane_no).toBe(1);
		expect(kills).toBe(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
		await env.release();
		const retry = await env.server.instance.inject({
			method: 'POST',
			url: '/api/v1/runs/implementation/abort',
			headers: env.headers,
			payload: {},
		});
		expect(retry.statusCode).toBe(200);
		expect(kills).toBe(1);
		expect(() => process.kill(pid, 0)).toThrow();
		expect(env.events.filter((event) => event.kind === 'run.aborted')).toHaveLength(1);
	},
);

it('rolls back a landing decision if all of its event reservations cannot fit', async () => {
	const env = await environment(4998);
	env.container.repos.runs.updateState({ id: 'implementation', toState: 'reviewing' });
	env.container.repos.gates?.create({
		id: 'landing',
		task_id: 'task',
		run_id: 'implementation',
		kind: 'landing',
		state: 'waiting',
		created_at: '2026-10-03T10:00:00.000Z',
	});
	const response = await env.server.instance.inject({
		method: 'POST',
		url: '/api/v1/gates/landing/decide',
		headers: env.headers,
		payload: { decision: 'pass' },
	});
	expect(response.statusCode).toBe(429);
	expect(env.container.repos.gates?.findById('landing')?.state).toBe('waiting');
	expect(env.container.repos.runs.findById('implementation')).toMatchObject({
		state: 'reviewing',
		session_archived_at: null,
	});
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBe(1);
	await env.release();
	const retry = await env.server.instance.inject({
		method: 'POST',
		url: '/api/v1/gates/landing/decide',
		headers: env.headers,
		payload: { decision: 'pass' },
	});
	expect(retry.statusCode).toBe(200);
	expect(env.container.repos.gates?.findById('landing')?.state).toBe('decided');
});

it('leaves document lane settings unchanged when the notification cannot be admitted', async () => {
	const env = await environment();
	const response = await env.server.instance.inject({
		method: 'PATCH',
		url: '/api/v1/documents/doc/settings',
		headers: env.headers,
		payload: { laneCount: 2 },
	});
	expect(response.statusCode).toBe(429);
	expect(env.container.repos.documents.findById('doc')?.lane_count).toBe(1);
	await env.release();
	const retry = await env.server.instance.inject({
		method: 'PATCH',
		url: '/api/v1/documents/doc/settings',
		headers: env.headers,
		payload: { laneCount: 2 },
	});
	expect(retry.statusCode).toBe(200);
	expect(env.container.repos.documents.findById('doc')?.lane_count).toBe(2);
	expect(env.events.filter((event) => event.kind === 'document.settings_changed')).toHaveLength(1);
});

it.each(['rerun', 'redispatch'] as const)(
	'keeps a rejected %s service mutation and its idempotency key retryable',
	async (mode) => {
		const env = await environment();
		const { container } = env;
		const snapshots = container.repos.dispatchSnapshots;
		if (!snapshots) throw new Error('Dispatch snapshots are missing from the real container');
		const service = createRerunService({
			...container.repos,
			runsRepo: container.repos.runs,
			tasksRepo: container.repos.tasks,
			batchesRepo: container.repos.batches,
			documentsRepo: container.repos.documents,
			dispatchSnapshotsRepo: snapshots,
			clock: container.clock,
			ids: container.ids,
			bus: container.events.bus,
			envelopeFactory: container.events.envelopeFactory,
			unitOfWork: createUnitOfWork(container.database),
		});
		container.repos.runs.updateState({ id: 'implementation', toState: 'failed' });
		const invoke = () =>
			mode === 'rerun'
				? service.rerunRun({ runId: 'implementation', idempotencyKey: 'pressure-retry' })
				: service.redispatchRun({
						taskId: 'task',
						agentId: 'codex',
						idempotencyKey: 'pressure-retry',
					});
		await expect(invoke()).rejects.toMatchObject({ code: 'E_RATE_LIMITED' });
		expect(container.repos.runs.listByTaskId('task')).toHaveLength(1);
		expect(container.repos.runs.findByIdempotencyKey('pressure-retry')).toBeNull();
		await env.release();
		const retry = await invoke();
		expect(retry.run.id).toBe(container.repos.runs.findByIdempotencyKey('pressure-retry')?.id);
		expect(container.repos.runs.listByTaskId('task')).toHaveLength(2);
	},
);

it('queues one disk-full warning without blocking the failing writer callback', async () => {
	const env = await environment();
	expect(() => env.container.services.system.notifyDiskFull(env.dataDir)).not.toThrow();
	env.container.services.system.notifyDiskFull(env.dataDir);
	expect(env.container.services.system.isDispatchHalted()).toBe(true);
	expect(env.events.filter((event) => event.kind === 'system.disk_warning')).toHaveLength(0);
	await env.release();
	await expect
		.poll(() => env.events.filter((event) => event.kind === 'system.disk_warning').length)
		.toBe(1);
});

it('rolls back a new document and its tasks when its changed event cannot be admitted', async () => {
	const env = await environment();
	const source = join(env.dataDir, 'docs-data.js');
	const payload = {
		schemaVersion: 1,
		project: 'admission import',
		pres: { handoff: { repo: env.dataDir, mainBranch: 'main', branchPrefix: 'task/' } },
		handoff: {
			version: '1.1.0',
			schemaVersion: 1,
			contracts: { 'T-1': { hash: 't1', effectivePaths: ['src/a.ts'] } },
			readiness: { 'T-1': { ready: true, contractHash: 't1', reasons: [] } },
			effectivePaths: { 'T-1': ['src/a.ts'] },
		},
		data: {
			tasks: [
				{ id: 'T-1', title: 'Imported task', module: 'M1', deps: [], accept: 'Check its result' },
			],
		},
		dispatch: {
			'T-1': { contractHash: 't1', implementation: 'Implement T-1', review: 'Review T-1' },
		},
	};
	writeFileSync(source, `window.DOCS = ${JSON.stringify(payload)};`);
	await expect(env.container.services.docs.importDocument(source)).rejects.toMatchObject({
		code: 'E_RATE_LIMITED',
	});
	expect(env.container.repos.documents.findByPath(source)).toBeNull();
	expect(env.container.repos.tasks.findById('task')).not.toBeNull();
	await env.release();
	const result = await env.container.services.docs.importDocument(source);
	expect(result.tasksImported).toBe(true);
	expect(env.container.repos.tasks.listByDocId(result.document.id)).toHaveLength(1);
	expect(env.events.filter((event) => event.kind === 'system.docs_changed')).toHaveLength(1);
});

it('finishes model rejection once capacity returns without losing its failure record', async () => {
	const env = await environment();
	let waiting = () => {};
	const atCapacity = new Promise<void>((resolve) => {
		waiting = resolve;
	});
	const factory = env.container.events.envelopeFactory;
	const snapshots = env.container.repos.dispatchSnapshots;
	if (!snapshots) throw new Error('Dispatch snapshots are missing');
	const service = createRerunService({
		batchesRepo: env.container.repos.batches,
		runsRepo: env.container.repos.runs,
		tasksRepo: env.container.repos.tasks,
		documentsRepo: env.container.repos.documents,
		dispatchSnapshotsRepo: snapshots,
		clock: { now: () => '2026-10-03T10:00:00.000Z' },
		ids: { newId: () => 'model-rejection' },
		unitOfWork: createUnitOfWork(env.container.database),
		envelopeFactory: {
			...factory,
			waitForCapacity: () => {
				waiting();
				return factory.waitForCapacity();
			},
		},
		bus: env.container.events.bus,
	});
	const completion = service.handleModelInvalid({
		runId: 'implementation',
		message: 'unsupported model',
	});
	await atCapacity;
	expect(env.container.repos.runs.findById('implementation')?.state).toBe('running');
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBe(1);
	await env.release();
	expect((await completion).state).toBe('failed');
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
	expect(
		env.events.filter(
			(event) =>
				event.kind === 'run.state_changed' &&
				'reason' in event.payload &&
				event.payload.reason === 'model_invalid',
		),
	).toHaveLength(1);
});

it('retains a stall notification while its committed warning waits for event capacity', async () => {
	const env = await environment();
	const notify = env.container.services.run.publishStalledSuspected;
	if (!notify) throw new Error('Container did not wire stall notifications');
	const completion = notify({
		kind: 'run.stalled_suspected',
		runId: 'implementation',
		taskId: 'task',
		payload: { durationMs: 60_000, severity: 'weak' },
	});
	await env.release();
	await completion;
	expect(env.events.filter((event) => event.kind === 'run.stalled_suspected')).toHaveLength(1);
});
