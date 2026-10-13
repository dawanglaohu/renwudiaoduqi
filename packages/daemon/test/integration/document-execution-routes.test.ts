import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { vendorEffortDomain } from '../../src/domain/agent-effort-options.ts';
import { membershipFingerprint } from '../../src/domain/document-execution.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { writeTasksDocsData } from '../fixtures/task-docs-data.ts';

const root = resolve(__dirname, '../../../..');
const migrations = join(root, 'packages/daemon/migrations');
const folders: string[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
	for (const database of databases.splice(0)) if (database.open) database.close();
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const lockAdapter = {
	platform: 'linux',
	filePath: '/test.lock',
	dirPath: '/test',
	reclaimPath: '/test.reclaim',
	permissionLines: [],
	createExclusive: () => ({ ok: true }),
	read: () => ({ ok: true, contents: '{}' }),
	remove: () => ({ ok: true }),
	verifyPermissions: () => ({ ok: true }),
	createReclaimGuard: () => ({ ok: true }),
	readReclaimGuard: () => ({ ok: true, contents: '{}' }),
	removeReclaimGuard: () => ({ ok: true }),
	inspectPermissions: () => ({ ok: true, contents: '{}' }),
} as NativeLockAdapter;

async function setup(
	options: {
		readonly modelEffortOptions?: readonly string[];
		readonly canDispatch?: (agentId: string) => boolean;
		readonly modelCatalogUnavailable?: boolean;
		readonly domainNeedsConfigRead?: boolean;
		readonly withWrapupWorkspace?: boolean;
		readonly agentConcurrencyLimit?: number;
		readonly withImplementationProcess?: boolean;
	} = {},
) {
	const folder = mkdtempSync(join(tmpdir(), 'agsched-document-plan-'));
	folders.push(folder);
	const database = openDatabase(join(folder, 'app.db'));
	databases.push(database);
	const clock = { now: () => '2026-10-12T08:00:00.000Z' };
	createMigrationRunner({
		database,
		clock,
		fileSystem: {
			readDirectory: (path) => readdirSync(path),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	}).run(migrations);
	const registry = createAgentRegistry({
		dataDir: folder,
		platform: process.platform === 'win32' ? 'win32' : 'posix',
		publishWarning: () => {},
		builtInDefaults: options.agentConcurrencyLimit
			? {
					...BUILT_IN_AGENT_DEFAULTS,
					codex: {
						...BUILT_IN_AGENT_DEFAULTS.codex,
						maxConcurrency: options.agentConcurrencyLimit,
					},
				}
			: BUILT_IN_AGENT_DEFAULTS,
	});
	let configRead = false;
	const schedulerTickJob = {
		name: 'scheduler-tick',
		start: () => {},
		stop: async () => {},
		trigger: () => {},
	};
	let gitAvailable = true;
	let gitPause: { entered: () => void; wait: Promise<void> } | null = null;
	const spawnedRuns: string[] = [];
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir: folder, logLevel: 'error', dev: false },
		database,
		hostInputs: { platform: process.platform, homedir: folder } as never,
		lockAdapter,
		instanceLock: { release: () => undefined } as never,
		clock,
		agentRegistry: registry,
		worktreeManager:
			options.withWrapupWorkspace || options.withImplementationProcess
				? ({
						prepareWrapupWorktree: async () => ({
							worktreePath: root,
							branchName: 'wrapup-test',
							baseRef: 'HEAD',
						}),
						prepareWorktree: async (input: { taskId: string; baseRef?: string }) => ({
							worktreePath: root,
							branchName: `task/${input.taskId}`,
							baseRef: input.baseRef ?? 'HEAD',
							isReused: false,
						}),
					} as never)
				: undefined,
		spawnManaged: options.withImplementationProcess
			? (((spec: { runId: string; file: string; args: readonly string[]; cwd: string }) => {
					spawnedRuns.push(spec.runId);
					const off = () => {};
					return {
						runId: spec.runId,
						pid: 98765,
						file: spec.file,
						args: spec.args,
						cwd: spec.cwd,
						isExited: false,
						stderrTail: '',
						attachAppendQueue: () => off,
						onRaw: () => off,
						onLine: () => off,
						onJson: () => off,
						onExit: () => off,
						onStderr: () => off,
						onError: () => off,
						writeStdin: () => true,
						waitForStdinDrain: async () => {},
						onStdinDrain: () => off,
						kill: async () => ({ outcome: 'terminated', attempts: [] }),
						finalize: async () => {},
					} as never;
				}) as never)
			: undefined,
		gitRunner: {
			run: async () => {
				const held = gitPause;
				if (held) {
					gitPause = null;
					held.entered();
					await held.wait;
				}
				return gitAvailable
					? { exitCode: 0, stdout: `true\n${root}\n`, stderr: '' }
					: { exitCode: 1, stdout: '', stderr: 'repository temporarily unavailable' };
			},
		},
		// A registered but unavailable agent exercises the accepted waiting-plan path.
		agentService: {
			start: async () => {},
			stop: async () => {},
			listAgents: async () => [],
			getAgent: async () => {
				configRead = true;
				return undefined;
			},
			getAvailability: (agentId: string) => {
				const canDispatch = options.canDispatch?.(agentId) ?? false;
				return { canDispatch, isReady: canDispatch, status: canDispatch ? 'ok' : 'not_found' };
			},
			getModelEffortOptions: () => options.modelEffortOptions,
			getVendorEffortDomain: (agentId: string) => {
				if (options.domainNeedsConfigRead && !configRead) return [];
				const config = registry.getSnapshot().agents[agentId];
				return config ? vendorEffortDomain(agentId, config) : [];
			},
			listAgentModels: async () => {
				if (options.modelCatalogUnavailable)
					throw new AppError('E_AGENT_UNAVAILABLE', 'Agent model catalog is unavailable.');
				return { currentConfig: { model: null, effort: null }, models: [] };
			},
		} as never,
		schedulerTickJob,
	});
	const server = createHttpServer({ container });
	await server.instance.ready();
	const code = container.services.pairing.createPairingCode().code;
	const claim = await container.services.pairing.claimPairingCode({
		code,
		deviceName: 'document-plan-test',
	});
	const headers = { authorization: `Bearer ${claim.token}` };
	const docsPath = join(folder, 'docs-data.js');
	writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-1' }]);
	const imported = await server.instance.inject({
		method: 'POST',
		url: '/api/v1/documents',
		headers,
		payload: { docsPath, repoPath: root },
	});
	expect(imported.statusCode, imported.body).toBe(200);
	const docId = imported.json().document.id as string;
	return {
		folder,
		database,
		container,
		server,
		headers,
		docsPath,
		docId,
		registry,
		setGitAvailable: (value: boolean) => {
			gitAvailable = value;
		},
		pauseNextGitRun: () => {
			let entered = () => {};
			let release = () => {};
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			gitPause = { entered, wait };
			return { entered: enteredPromise, release };
		},
		getSpawnedRuns: () => [...spawnedRuns],
	};
}

function seedWrapupRun(
	env: Awaited<ReturnType<typeof setup>>,
	input: {
		id: string;
		batchId: string;
		attemptNo: number;
		state: 'failed' | 'landed' | 'starting';
		inputText?: string | null;
		createdAt: string;
		contractHash?: string;
	},
): void {
	const snapshotId = `snapshot-${input.id}`;
	env.container.repos.dispatchSnapshots?.insert({
		id: snapshotId,
		task_id: null,
		batch_id: input.batchId,
		input_text: input.inputText ?? null,
		contract_hash: input.contractHash ?? 'wrapup',
		task_paths_json: '[]',
		launch_spec_json: '{}',
		created_at: input.createdAt,
	});
	env.container.repos.runs.insert({
		id: input.id,
		task_id: null,
		batch_id: input.batchId,
		attempt_no: input.attemptNo,
		kind: 'wrapup',
		state: input.state,
		agent_id: 'codex',
		permission_tier: 'workspaceWrite',
		snapshot_id: snapshotId,
		started_at: input.createdAt,
		ended_at: input.state === 'starting' ? null : input.createdAt,
		is_in_head: input.state === 'landed' ? 1 : 0,
	});
}

function seedWrapupVerdict(
	env: Awaited<ReturnType<typeof setup>>,
	input: {
		id: string;
		batchId: string;
		runId: string;
		round: number;
		verdict: 'clean' | 'open';
		createdAt: string;
		taskKeys?: readonly string[];
		batchNo?: number;
	},
): void {
	env.container.repos.batchWrapups?.insert({
		id: input.id,
		batch_id: input.batchId,
		batch_no: input.batchNo ?? 1,
		tasks_json: JSON.stringify(input.taskKeys ?? ['M1-T1']),
		round: input.round,
		run_id: input.runId,
		verdict: input.verdict,
		prompt_source: 'docs',
		tests_json: '{"status":"pass","items":[]}',
		summary_text: 'historical verdict',
		findings_json: '[]',
		unassigned_json: '[]',
		fix_run_ids_json: '[]',
		report_text: 'historical report',
		created_at: input.createdAt,
	});
}

function seedImplementationRun(
	env: Awaited<ReturnType<typeof setup>>,
	input: {
		id: string;
		taskId: string;
		batchId: string;
		attemptNo: number;
		contractHash: string;
		createdAt: string;
		generationId?: number;
		agentId?: string;
		branchName?: string;
		worktreePath?: string;
	},
): void {
	const snapshotId = `snapshot-${input.id}`;
	env.container.repos.dispatchSnapshots?.insert({
		id: snapshotId,
		task_id: input.taskId,
		contract_hash: input.contractHash,
		task_paths_json: '[]',
		launch_spec_json:
			input.generationId === undefined
				? '{}'
				: JSON.stringify({ documentGenerationId: input.generationId }),
		created_at: input.createdAt,
	});
	env.container.repos.runs.insert({
		id: input.id,
		task_id: input.taskId,
		attempt_no: input.attemptNo,
		kind: 'implement',
		state: 'landed',
		agent_id: input.agentId ?? 'codex',
		permission_tier: 'workspaceWrite',
		snapshot_id: snapshotId,
		branch_name: input.branchName ?? null,
		worktree_path: input.worktreePath ?? null,
		started_at: input.createdAt,
		ended_at: input.createdAt,
		is_in_head: 1,
		in_head_checked_at: input.createdAt,
	});
}

function seedQueuedStageRun(
	env: Awaited<ReturnType<typeof setup>>,
	input: {
		readonly id: string;
		readonly taskId: string;
		readonly batchId: string;
		readonly contractHash: string;
		readonly generationId: number;
		readonly attemptNo?: number;
		readonly kind: 'review' | 'bughunt' | 'implement';
		readonly origin?: 'wrapup-fix';
		readonly parentRunId?: string;
		readonly spawnedByRunId?: string;
		readonly omitOwnGeneration?: boolean;
	},
): void {
	const snapshotId = `snapshot-${input.id}`;
	env.container.repos.dispatchSnapshots?.insert({
		id: snapshotId,
		task_id: input.taskId,
		contract_hash: input.contractHash,
		task_paths_json: '["src/"]',
		launch_spec_json: input.omitOwnGeneration
			? '{}'
			: JSON.stringify({ documentGenerationId: input.generationId }),
		impl_prompt: 'Continue the queued stage',
		created_at: '2026-10-12T08:00:00.000Z',
	});
	env.container.repos.runs.insert({
		id: input.id,
		task_id: input.taskId,
		batch_id: input.batchId,
		attempt_no: input.attemptNo ?? 1,
		kind: input.kind,
		origin: input.origin ?? 'dispatch',
		parent_run_id: input.parentRunId ?? null,
		spawned_by_run_id: input.spawnedByRunId ?? null,
		state: 'queued',
		agent_id: 'codex',
		permission_tier: 'workspaceWrite',
		snapshot_id: snapshotId,
		queued_reason: 'lane_full',
		started_at: null,
	});
}

describe('M8-T12 document execution through the real container', () => {
	it('E-361: duplicate start reads the committed plan while the repository is unavailable', async () => {
		const { server, container, headers, docId, setGitAvailable } = await setup();
		const url = `/api/v1/documents/${docId}/execution/start`;
		const body = {
			expectedVersion: 0,
			expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
		};
		expect(
			(await server.instance.inject({ method: 'POST', url, headers, payload: body })).statusCode,
		).toBe(200);
		const eventId = container.events.ringBuffer.latest()?.id;
		setGitAvailable(false);
		const retried = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(retried.statusCode, retried.body).toBe(200);
		expect(retried.json().execution).toMatchObject({ state: 'running', version: 1 });
		expect(container.events.ringBuffer.latest()?.id).toBe(eventId);
		await server.instance.close();
	});

	it('E-361: an old start cannot mask a version conflict after pause and resume', async () => {
		const { server, container, headers, docId, setGitAvailable } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const startBody = {
			expectedVersion: 0,
			expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
		};
		const post = (action: string, payload: Record<string, unknown>) =>
			server.instance.inject({ method: 'POST', url: `${url}/${action}`, headers, payload });
		expect((await post('start', startBody)).statusCode).toBe(200);
		const firstEventId = container.events.ringBuffer.latest()?.id;
		expect((await post('start', { ...startBody, expectedVersion: 1 })).statusCode).toBe(200);
		expect(container.events.ringBuffer.latest()?.id).toBe(firstEventId);
		expect((await post('pause', { expectedVersion: 1 })).statusCode).toBe(200);
		expect(
			(
				await post('resume', {
					expectedVersion: 2,
					expectedFingerprint: startBody.expectedFingerprint,
				})
			).statusCode,
		).toBe(200);
		const eventId = container.events.ringBuffer.latest()?.id;
		const stale = await post('start', startBody);
		expect(stale.statusCode, stale.body).toBe(400);
		expect(stale.json().error.details).toMatchObject({ expectedVersion: 0, actualVersion: 3 });
		expect(container.repos.documentExecutions.findByDocId(docId)).toMatchObject({
			state: 'running',
			version: 3,
		});
		expect(container.events.ringBuffer.latest()?.id).toBe(eventId);
		setGitAvailable(false);
		const unavailable = await post('start', startBody);
		expect(unavailable.statusCode, unavailable.body).toBe(400);
		expect(unavailable.json().error).toMatchObject({
			code: 'E_VALIDATION',
			details: { expectedVersion: 0, actualVersion: 3 },
		});
		expect(container.events.ringBuffer.latest()?.id).toBe(eventId);
		await server.instance.close();
	});

	it('E-361: duplicate resume reads the committed plan while the repository is unavailable', async () => {
		const { server, container, headers, docId, setGitAvailable } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		expect(
			(
				await server.instance.inject({
					method: 'POST',
					url: `${url}/start`,
					headers,
					payload: {
						expectedVersion: 0,
						expectedFingerprint: fingerprint,
						defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
					},
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await server.instance.inject({
					method: 'POST',
					url: `${url}/pause`,
					headers,
					payload: { expectedVersion: 1 },
				})
			).statusCode,
		).toBe(200);
		const resumeBody = { expectedVersion: 2, expectedFingerprint: fingerprint };
		expect(
			(
				await server.instance.inject({
					method: 'POST',
					url: `${url}/resume`,
					headers,
					payload: resumeBody,
				})
			).statusCode,
		).toBe(200);
		const eventId = container.events.ringBuffer.latest()?.id;
		setGitAvailable(false);
		const retried = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: resumeBody,
		});
		expect(retried.statusCode, retried.body).toBe(200);
		expect(retried.json().execution).toMatchObject({ state: 'running', version: 3 });
		expect(container.events.ringBuffer.latest()?.id).toBe(eventId);
		await server.instance.close();
	});

	it('E-361: duplicate start returns the committed plan after Agent capability changes', async () => {
		const { server, container, headers, docId, registry } = await setup();
		const url = `/api/v1/documents/${docId}/execution/start`;
		const body = {
			expectedVersion: 0,
			expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
		};
		const started = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(started.statusCode, started.body).toBe(200);
		const eventId = container.events.ringBuffer.latest()?.id;
		expect((await registry.updateOverrides('codex', { effortVendorMap: null })).ok).toBe(true);
		const retried = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(retried.statusCode, retried.body).toBe(200);
		expect(retried.json().execution).toMatchObject({ state: 'running', version: 1 });
		expect(container.events.ringBuffer.latest()?.id).toBe(eventId);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		const paused = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/pause`,
			headers,
			payload: { expectedVersion: 1 },
		});
		expect(paused.statusCode).toBe(200);
		const stale = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(stale.statusCode).toBe(400);
		expect(stale.json().error.details.actualVersion).toBe(2);
		expect(container.repos.documentExecutions.findByDocId(docId)?.state).toBe('paused');
		await server.instance.close();
	});

	it('E-369: read-only execution DTO retains persisted generation and attempts until resume', async () => {
		const env = await setup();
		const { server, container, headers, docId, docsPath } = env;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		expect(batchId).toBeDefined();
		if (!batchId) return;
		container.services.batch?.transitionBatch(batchId, 'running', 'legacy_start');
		container.services.batch?.transitionBatch(batchId, 'needs_attention', 'legacy_attention');
		seedWrapupRun(env, {
			id: 'legacy-attempt',
			batchId,
			attemptNo: 1,
			state: 'failed',
			createdAt: '2026-09-01T08:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		expect(start.json().execution.wrapupProgress).toMatchObject({
			generationId: 0,
			physicalAttempts: 1,
		});
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const read = await server.instance.inject({ method: 'GET', url, headers });
		expect(read.json().execution).toMatchObject({
			state: 'paused',
			wrapupProgress: { generationId: 0, physicalAttempts: 1 },
		});
		await server.instance.close();
	});

	it('E-365: landed work does not remain blocked by its unavailable Agent', async () => {
		const env = await setup();
		const { server, container, headers, docId } = env;
		const taskId = container.repos.tasks.listByDocId(docId)[0]?.id;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		expect(taskId).toBeDefined();
		expect(batchId).toBeDefined();
		if (!taskId || !batchId) return;
		seedImplementationRun(env, {
			id: 'landed-before-plan',
			taskId,
			batchId,
			attemptNo: 1,
			contractHash: 'contract-1',
			createdAt: '2026-09-01T08:00:00.000Z',
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(
			started
				.json()
				.execution.blockers.some((item: { code: string }) => item.code === 'agent_unavailable'),
		).toBe(false);
		await server.instance.close();
	});

	it('E-369: refresh publishes a pause after source becomes unreadable', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode).toBe(200);
		const before = container.events.ringBuffer.latest()?.id ?? 0;
		rmSync(docsPath);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.json().error.code).toBe('E_DOC_SOURCE_UNREADABLE');
		expect(container.repos.documentExecutions.findByDocId(docId)).toMatchObject({
			state: 'paused',
			version: 2,
		});
		expect(
			container.events.ringBuffer
				.getAll()
				.filter((event) => event.id > before)
				.map((event) => event.kind),
		).toContain('document.execution_changed');
		await server.instance.close();
	});

	it('E-369: control preflight publishes a pause after source becomes unreadable', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const url = `/api/v1/documents/${docId}/execution/start`;
		const body = {
			expectedVersion: 0,
			expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
		};
		expect(
			(await server.instance.inject({ method: 'POST', url, headers, payload: body })).statusCode,
		).toBe(200);
		const before = container.events.ringBuffer.latest()?.id ?? 0;
		rmSync(docsPath);
		const retry = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(retry.json().error.code).toBe('E_DOC_SOURCE_UNREADABLE');
		expect(container.repos.documentExecutions.findByDocId(docId)).toMatchObject({
			state: 'paused',
			version: 2,
		});
		expect(
			container.events.ringBuffer
				.getAll()
				.filter((event) => event.id > before)
				.map((event) => event.kind),
		).toContain('document.execution_changed');
		await server.instance.close();
	});

	it('E-361: control events retain the authenticated device', async () => {
		const { server, container, headers, docId } = await setup();
		const actorDeviceId = container.services.pairing.authenticateToken(
			headers.authorization,
		).deviceId;
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode).toBe(200);
		expect(container.events.ringBuffer.latest()?.actorDeviceId).toBe(actorDeviceId);
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: 1 },
		});
		expect(pause.statusCode).toBe(200);
		expect(container.events.ringBuffer.latest()?.actorDeviceId).toBe(actorDeviceId);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: { expectedVersion: 2, expectedFingerprint: fingerprint },
		});
		expect(resume.statusCode).toBe(200);
		expect(container.events.ringBuffer.latest()?.actorDeviceId).toBe(actorDeviceId);
		await server.instance.close();
	});

	it('E-365: an established vendor effort survives a narrower cached model list', async () => {
		const { server, container, headers, docId } = await setup({ modelEffortOptions: ['high'] });
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.defaultAssignment.effort).toEqual({ vendor: 'ultra' });
		await server.instance.close();
	});

	it('E-365: an offline registered agent accepts a configured vendor effort as a waiting plan', async () => {
		const { server, container, headers, docId } = await setup({
			modelCatalogUnavailable: true,
			domainNeedsConfigRead: true,
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution).toMatchObject({
			state: 'running',
			defaultAssignment: { effort: { vendor: 'ultra' } },
		});
		expect(started.json().execution.blockers).toContainEqual(
			expect.objectContaining({ code: 'agent_unavailable' }),
		);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		await server.instance.close();
	});

	it('E-365: resume rejects a saved vendor effort after its Agent capability is removed', async () => {
		const { server, container, headers, docId, registry } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const paused = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: 1 },
		});
		expect(paused.statusCode).toBe(200);
		expect((await registry.updateOverrides('codex', { effortVendorMap: null })).ok).toBe(true);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: { expectedVersion: 2, expectedFingerprint: fingerprint },
		});
		expect(resumed.statusCode).toBe(400);
		expect(resumed.json().error.code).toBe('E_VALIDATION');
		expect(container.repos.documentExecutions.findByDocId(docId)).toMatchObject({
			state: 'paused',
			version: 2,
		});
		await server.instance.close();
	});

	it('E-365: an unavailable draft agent remains an execution blocker', async () => {
		const { server, container, headers, docId } = await setup();
		const taskId = container.repos.tasks.listByDocId(docId)[0]?.id;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		expect(taskId).toBeDefined();
		expect(batchId).toBeDefined();
		const draft = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/batches/${batchId}/assignments`,
			headers,
			payload: { assignments: [{ taskId, agentId: 'codex', effort: null }] },
		});
		expect(draft.statusCode, draft.body).toBe(200);
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.blockers).toContainEqual({
			code: 'agent_unavailable',
			batchId,
			taskIds: [taskId],
		});
		await server.instance.close();
	});

	it('E-365: a draft on another unavailable agent blocks while the default is available', async () => {
		const { server, container, headers, docId } = await setup({
			canDispatch: (agentId) => agentId === 'codex',
		});
		const taskId = container.repos.tasks.listByDocId(docId)[0]?.id;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		const draft = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/batches/${batchId}/assignments`,
			headers,
			payload: { assignments: [{ taskId, agentId: 'claude', effort: null }] },
		});
		expect(draft.statusCode, draft.body).toBe(200);
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.blockers).toContainEqual({
			code: 'agent_unavailable',
			batchId,
			taskIds: [taskId],
		});
		await server.instance.close();
	});

	it('E-366: two legacy active batches appear in the idle execution DTO', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const batches = container.repos.batches.listByDocId(docId);
		expect(batches).toHaveLength(2);
		for (const batch of batches)
			container.services.batch?.transitionBatch(batch.id, 'running', 'legacy_start');
		const execution = (
			await server.instance.inject({
				method: 'GET',
				url: `/api/v1/documents/${docId}/execution`,
				headers,
			})
		).json().execution;
		expect(execution.blockers).toContainEqual({
			code: 'legacy_batches_active',
			batchId: null,
			taskIds: [],
		});
		expect(execution.canStart).toBe(false);
		await server.instance.close();
	});
	it('E-366: a lone later legacy batch blocks start while an earlier batch is incomplete', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const batches = container.repos.batches.listByDocId(docId);
		expect(batches).toHaveLength(2);
		const later = batches[1];
		expect(later).toBeDefined();
		if (!later) return;
		container.services.batch?.transitionBatch(later.id, 'running', 'legacy_start');
		const url = `/api/v1/documents/${docId}/execution`;
		const execution = (await server.instance.inject({ method: 'GET', url, headers })).json()
			.execution;
		expect(execution.blockers).toContainEqual({
			code: 'legacy_batches_active',
			batchId: null,
			taskIds: [],
		});
		expect(execution.canStart).toBe(false);
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.json().error.code).toBe('E_VALIDATION');
		await server.instance.close();
	});
	it('R3: first adoption retains legacy wrapup attempts and two effective rounds in generation zero', async () => {
		const env = await setup();
		const { server, container, headers, docId } = env;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		expect(batchId).toBeDefined();
		if (!batchId) return;
		container.services.batch?.transitionBatch(batchId, 'running', 'legacy_start');
		container.services.batch?.transitionBatch(batchId, 'needs_attention', 'legacy_attention');
		for (let attemptNo = 1; attemptNo <= 6; attemptNo++) {
			seedWrapupRun(env, {
				id: `legacy-wrapup-${attemptNo}`,
				batchId,
				attemptNo,
				state: 'failed',
				createdAt: `2026-09-0${attemptNo}T08:00:00.000Z`,
			});
		}
		seedWrapupVerdict(env, {
			id: 'legacy-verdict-1',
			batchId,
			runId: 'legacy-wrapup-1',
			round: 1,
			verdict: 'open',
			createdAt: '2026-09-01T09:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'legacy-verdict-2',
			batchId,
			runId: 'legacy-wrapup-2',
			round: 2,
			verdict: 'open',
			createdAt: '2026-09-02T09:00:00.000Z',
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.wrapupProgress).toEqual({
			generationId: 0,
			validRounds: 2,
			physicalAttempts: 6,
		});
		const stored = container.repos.documentExecutions.findByDocId(docId);
		const plan = JSON.parse(stored?.plan_json ?? '[]') as Array<{
			generationId: number;
			wrapupRunIds: string[];
		}>;
		expect(plan[0]?.generationId).toBe(0);
		expect(plan[0]?.wrapupRunIds).toHaveLength(6);
		await server.instance.close();
	});

	it('R4: a later landed run cannot retroactively prove an older clean verdict for the same task key', async () => {
		const env = await setup();
		const { server, container, headers, docId, docsPath } = env;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		const taskId = container.repos.tasks.listByDocId(docId)[0]?.id;
		expect(batchId).toBeDefined();
		expect(taskId).toBeDefined();
		if (!batchId || !taskId) return;
		seedImplementationRun(env, {
			id: 'old-implement',
			taskId,
			batchId,
			attemptNo: 1,
			contractHash: 'contract-1',
			createdAt: '2026-09-01T08:00:00.000Z',
		});
		const oldMembers = [{ task_key: 'M1-T1', contractHash: 'contract-1' }];
		const oldFingerprint = membershipFingerprint(
			[{ taskKey: 'M1-T1', contractHash: 'contract-1' }],
			(value) => createHash('sha256').update(value, 'utf8').digest('hex'),
		);
		seedWrapupRun(env, {
			id: 'old-clean-wrapup',
			batchId,
			attemptNo: 1,
			state: 'landed',
			inputText: JSON.stringify({
				generationId: 0,
				membershipFingerprint: oldFingerprint,
				members: oldMembers,
			}),
			createdAt: '2026-09-02T08:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'old-clean-verdict',
			batchId,
			runId: 'old-clean-wrapup',
			round: 1,
			verdict: 'clean',
			createdAt: '2026-09-02T09:00:00.000Z',
		});
		container.services.batch?.transitionBatch(batchId, 'running', 'legacy_start');
		container.services.batch?.transitionBatch(batchId, 'wrapping', 'legacy_wrapup');
		container.services.batch?.transitionBatch(batchId, 'done', 'legacy_clean');
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refreshed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refreshed.statusCode, refreshed.body).toBe(200);
		seedImplementationRun(env, {
			id: 'new-implement',
			taskId,
			batchId,
			attemptNo: 2,
			contractHash: 'contract-2',
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution).toMatchObject({
			state: 'running',
			completedBatchCount: 0,
			currentBatchId: batchId,
		});
		expect(container.repos.batches.findById(batchId)).toMatchObject({
			state: 'running',
			finished_at: null,
		});
		expect(container.repos.batchWrapups?.findById('old-clean-verdict')?.verdict).toBe('clean');
		await server.instance.close();
	});

	it('R4: adopts an old done only when the wrapup froze matching members and earlier landed evidence', async () => {
		const env = await setup();
		const { server, container, headers, docId } = env;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		const taskId = container.repos.tasks.listByDocId(docId)[0]?.id;
		expect(batchId).toBeDefined();
		expect(taskId).toBeDefined();
		if (!batchId || !taskId) return;
		seedImplementationRun(env, {
			id: 'proved-implement',
			taskId,
			batchId,
			attemptNo: 1,
			contractHash: 'contract-1',
			createdAt: '2026-09-01T08:00:00.000Z',
		});
		const frozenFingerprint = membershipFingerprint(
			[{ taskKey: 'M1-T1', contractHash: 'contract-1' }],
			(value) => createHash('sha256').update(value, 'utf8').digest('hex'),
		);
		seedWrapupRun(env, {
			id: 'proved-wrapup',
			batchId,
			attemptNo: 1,
			state: 'landed',
			inputText: JSON.stringify({
				generationId: 0,
				membershipFingerprint: frozenFingerprint,
				members: [{ task_key: 'M1-T1', contractHash: 'contract-1' }],
			}),
			createdAt: '2026-09-02T08:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'proved-verdict',
			batchId,
			runId: 'proved-wrapup',
			round: 1,
			verdict: 'clean',
			createdAt: '2026-09-02T09:00:00.000Z',
		});
		container.services.batch?.transitionBatch(batchId, 'running', 'legacy_start');
		container.services.batch?.transitionBatch(batchId, 'wrapping', 'legacy_wrapup');
		container.services.batch?.transitionBatch(batchId, 'done', 'legacy_clean');
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution).toMatchObject({
			state: 'completed',
			completedBatchCount: 1,
			currentBatchId: null,
		});
		expect(container.repos.batches.findById(batchId)?.state).toBe('done');
		await server.instance.close();
	});
	it('R1: resumes after the old active batch loses every member', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const executionUrl = `/api/v1/documents/${docId}/execution`;
		const originalFingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const batchId = container.repos.batches.listByDocId(docId)[0]?.id;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${executionUrl}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: originalFingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode).toBe(200);
		writeTasksDocsData(docsPath, []);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode).toBe(200);
		const doc = container.repos.documents.findById(docId);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${executionUrl}/resume`,
			headers,
			payload: { expectedVersion: 2, expectedFingerprint: doc?.content_fingerprint },
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		expect(resumed.json().execution).toMatchObject({
			state: 'completed',
			currentBatchId: null,
			totalBatchCount: 0,
		});
		expect(container.repos.batches.findById(batchId ?? '')).toMatchObject({
			state: 'idle',
			finished_at: null,
		});
		expect(container.repos.tasks.listByDocId(docId)[0]?.is_removed_from_doc).toBe(1);
		await server.instance.close();
	});

	it('R2: pauses on a same-fingerprint source rebinding', async () => {
		const { folder, server, container, headers, docId } = await setup();
		const executionUrl = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${executionUrl}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode).toBe(200);
		const reboundPath = join(folder, 'rebound', 'docs-data.js');
		mkdirSync(join(folder, 'rebound'));
		expect(writeTasksDocsData(reboundPath, [{ id: 'M1-T1', hash: 'contract-1' }])).toBe(
			fingerprint,
		);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: { docsPath: reboundPath, repoPath: root },
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const execution = (
			await server.instance.inject({ method: 'GET', url: executionUrl, headers })
		).json().execution;
		expect(execution).toMatchObject({ state: 'paused', pauseReason: 'doc_changed', version: 2 });
		expect(container.repos.documents.findById(docId)?.content_fingerprint).toBe(fingerprint);
		await server.instance.close();
	});

	it('R2: re-import publishes the committed document execution change', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode).toBe(200);
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'changed-contract' }]);
		const imported = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers,
			payload: { docsPath, repoPath: root },
		});
		expect(imported.statusCode, imported.body).toBe(200);
		expect(imported.json().document.id).toBe(docId);
		expect(container.repos.documentExecutions.findByDocId(docId)).toMatchObject({
			state: 'paused',
			version: 2,
		});
		expect(container.events.ringBuffer.latest()?.kind).toBe('document.execution_changed');
		await server.instance.close();
	});
	it('keeps a legal vendor effort value and rejects an unknown value before a plan exists', async () => {
		const { server, container, headers, docId } = await setup();
		const url = `/api/v1/documents/${docId}/execution/start`;
		const expectedFingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const body = {
			expectedVersion: 0,
			expectedFingerprint,
			defaultAssignment: {
				agentId: 'codex',
				modelName: null,
				effort: { vendor: 'unrecognized-level' },
			},
		};
		const invalid = await server.instance.inject({ method: 'POST', url, headers, payload: body });
		expect(invalid.statusCode).toBe(400);
		expect(container.repos.documentExecutions.findByDocId(docId)).toBeNull();
		const valid = await server.instance.inject({
			method: 'POST',
			url,
			headers,
			payload: {
				...body,
				defaultAssignment: { ...body.defaultAssignment, effort: { vendor: 'ultra' } },
			},
		});
		expect(valid.statusCode, valid.body).toBe(200);
		expect(valid.json().execution.defaultAssignment.effort).toEqual({ vendor: 'ultra' });
		expect(container.repos.runs.listAll()).toHaveLength(0);
		await server.instance.close();
	});
	it('rejects unknown agents and stale source without creating a plan, then pauses a live plan on restart', async () => {
		const { server, container, headers, docId } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const body = {
			expectedVersion: 0,
			expectedFingerprint: fingerprint,
			defaultAssignment: { agentId: 'missing-agent', modelName: null, effort: null },
		};
		const unknown = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: body,
		});
		expect(unknown.statusCode).toBe(400);
		expect(unknown.json().error.code).toBe('E_VALIDATION');
		const stale = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				...body,
				expectedFingerprint: 'old-fingerprint',
				defaultAssignment: { ...body.defaultAssignment, agentId: 'codex' },
			},
		});
		expect(stale.json().error.code).toBe('E_SNAPSHOT_STALE');
		expect(container.repos.documentExecutions.findByDocId(docId)).toBeNull();
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: { ...body, defaultAssignment: { ...body.defaultAssignment, agentId: 'codex' } },
		});
		expect(started.statusCode).toBe(200);
		container.services.documentExecution.pauseRunningOnRestart();
		const afterRestart = (await server.instance.inject({ method: 'GET', url, headers })).json()
			.execution;
		expect(afterRestart).toMatchObject({
			state: 'paused',
			pauseReason: 'daemon_restarted',
			version: 2,
			currentBatchNo: 1,
		});
		expect(container.repos.runs.listAll()).toHaveLength(0);
		await server.instance.close();
	});
	it('imports idle, then persists one waiting plan and preserves a newer pause against an old resume retry', async () => {
		const { server, container, headers, docId, database } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const read = () => server.instance.inject({ method: 'GET', url, headers });
		const first = (await read()).json().execution;
		expect(first.state).toBe('idle');
		expect(first.version).toBe(0);
		expect(container.repos.batches.listByDocId(docId)[0]?.state).toBe('idle');
		expect(container.repos.runs.listAll()).toHaveLength(0);
		const beforeReadEvent = container.events.ringBuffer.latest()?.id ?? null;
		const snapshot = await server.instance.inject({
			method: 'GET',
			url: '/api/v1/snapshot',
			headers,
		});
		expect(snapshot.json().documentExecutions[0].state).toBe('idle');
		expect(container.repos.runs.listAll()).toHaveLength(0);
		expect(container.events.ringBuffer.latest()?.id ?? null).toBe(beforeReadEvent);

		const startBody = {
			expectedVersion: 0,
			expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
		};
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: startBody,
		});
		expect(start.statusCode).toBe(200);
		expect(start.json().execution).toMatchObject({
			state: 'running',
			version: 1,
			currentBatchNo: 1,
		});
		expect(start.json().execution.blockers).toContainEqual(
			expect.objectContaining({ code: 'agent_unavailable' }),
		);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		const afterStartEvent = container.events.ringBuffer.latest()?.id ?? null;
		const retry = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: startBody,
		});
		expect(retry.statusCode).toBe(200);
		expect(retry.json().execution.version).toBe(1);
		expect(container.events.ringBuffer.latest()?.id ?? null).toBe(afterStartEvent);

		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: 1 },
		});
		expect(pause.json().execution).toMatchObject({ state: 'paused', version: 2 });
		const resumeBody = { expectedVersion: 2, expectedFingerprint: startBody.expectedFingerprint };
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: resumeBody,
		});
		expect(resumed.json().execution).toMatchObject({ state: 'running', version: 3 });
		await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: 3 },
		});
		const lostResponseRetry = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: resumeBody,
		});
		expect(lostResponseRetry.statusCode).toBe(400);
		expect(lostResponseRetry.json().error.details.actualVersion).toBe(4);
		expect((await read()).json().execution.state).toBe('paused');
		expect(
			(
				database
					.prepare('SELECT COUNT(*) AS count FROM document_executions WHERE doc_id = ?')
					.get(docId) as { count: number }
			).count,
		).toBe(1);
		await server.instance.close();
	});

	it('refresh pauses a running plan and explicit resume creates a new generation for changed members', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode).toBe(200);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode).toBe(200);
		const paused = (await server.instance.inject({ method: 'GET', url, headers })).json().execution;
		expect(paused).toMatchObject({ state: 'paused', pauseReason: 'doc_changed', version: 2 });
		const current = container.repos.documents.findById(docId);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: { expectedVersion: 2, expectedFingerprint: current?.content_fingerprint },
		});
		expect(resumed.statusCode).toBe(200);
		expect(resumed.json().execution).toMatchObject({
			state: 'running',
			version: 3,
			totalBatchCount: 1,
		});
		expect(resumed.json().execution.wrapupProgress.generationId).toBe(3);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		await server.instance.close();
	});

	it('resumes an unstarted task after daemon restart and Agent recovery', async () => {
		let available = false;
		const { server, container, headers, docId } = await setup({
			canDispatch: () => available,
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
			},
		});
		expect(started.statusCode).toBe(200);
		expect((await container.services.dispatch.tick()).runsDispatched).toHaveLength(0);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		container.services.documentExecution.pauseRunningOnRestart();
		expect(container.services.documentExecution.get(docId).execution).toMatchObject({
			state: 'paused',
			pauseReason: 'daemon_restarted',
		});
		expect((await container.services.dispatch.tick()).runsDispatched).toHaveLength(0);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		available = true;
		const dispatched = await container.services.dispatch.tick();
		expect(dispatched.runsDispatched).toHaveLength(1);
		expect(container.repos.runs.listAll()).toHaveLength(1);
		const run = container.repos.runs.findById(dispatched.runsDispatched[0] ?? '');
		expect(run?.effort_vendor).toBe('ultra');
		const snapshot = container.repos.dispatchSnapshots?.findById(run?.snapshot_id ?? '');
		expect(JSON.parse(snapshot?.assignment_json ?? '{}').effortVendor).toBe('ultra');
		await server.instance.close();
	});

	it('activates the next batch only after frozen clean wrapup evidence enters HEAD', async () => {
		const env = await setup();
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const refreshed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refreshed.statusCode, refreshed.body).toBe(200);
		const batches = container.repos.batches.listByDocId(docId);
		expect(batches).toHaveLength(2);
		const first = batches[0];
		const second = batches[1];
		if (!first || !second) return;
		const task = container.repos.tasks.listByBatchId(first.id)[0];
		if (!task) return;
		seedImplementationRun(env, {
			id: 'first-implement',
			taskId: task.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const row = container.repos.documentExecutions.findByDocId(docId);
		expect(row).not.toBeNull();
		if (!row) return;
		const plan = JSON.parse(row?.plan_json ?? '[]');
		const entry = plan[0];
		const frozen = JSON.stringify({
			generationId: entry.generationId,
			membershipFingerprint: entry.membershipFingerprint,
			members: entry.members.map((member: { taskKey: string; contractHash: string }) => ({
				task_key: member.taskKey,
				contractHash: member.contractHash,
			})),
		});
		seedWrapupRun(env, {
			id: 'first-wrapup',
			batchId: first.id,
			attemptNo: 1,
			state: 'landed',
			inputText: frozen,
			contractHash: entry.membershipFingerprint,
			createdAt: '2026-10-12T08:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'first-clean',
			batchId: first.id,
			runId: 'first-wrapup',
			round: 1,
			verdict: 'clean',
			createdAt: '2026-10-12T08:00:00.000Z',
		});
		container.repos.documentExecutions.save({
			...row,
			version: row.version + 1,
			plan_json: JSON.stringify([{ ...entry, wrapupRunIds: ['first-wrapup'] }, plan[1]]),
		});
		await container.services.batch?.transitionBatch(first.id, 'wrapping', 'wrapup_dispatched');
		await container.services.batch?.transitionBatch(first.id, 'done', 'wrapup_clean');
		await container.services.dispatch.tick();
		expect(container.repos.batches.findById(second.id)?.state).toBe('running');
		expect(container.repos.documentExecutions.findByDocId(docId)?.current_batch_id).toBe(second.id);
		const secondTask = container.repos.tasks.listByBatchId(second.id)[0];
		if (!secondTask) return;
		seedImplementationRun(env, {
			id: 'second-implement',
			taskId: secondTask.id,
			batchId: second.id,
			attemptNo: 1,
			contractHash: secondTask.contract_hash,
			createdAt: '2026-10-12T09:00:00.000Z',
		});
		const secondRow = container.repos.documentExecutions.findByDocId(docId);
		expect(secondRow).not.toBeNull();
		if (!secondRow) return;
		const secondPlan = JSON.parse(secondRow?.plan_json ?? '[]');
		const secondEntry = secondPlan[1];
		seedWrapupRun(env, {
			id: 'second-wrapup',
			batchId: second.id,
			attemptNo: 1,
			state: 'landed',
			inputText: JSON.stringify({
				generationId: secondEntry.generationId,
				membershipFingerprint: secondEntry.membershipFingerprint,
				members: secondEntry.members.map((member: { taskKey: string; contractHash: string }) => ({
					task_key: member.taskKey,
					contractHash: member.contractHash,
				})),
			}),
			contractHash: secondEntry.membershipFingerprint,
			createdAt: '2026-10-12T10:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'second-clean',
			batchId: second.id,
			runId: 'second-wrapup',
			round: 1,
			verdict: 'clean',
			taskKeys: ['M1-T2'],
			batchNo: 2,
			createdAt: '2026-10-12T10:00:00.000Z',
		});
		container.repos.documentExecutions.save({
			...secondRow,
			version: secondRow.version + 1,
			plan_json: JSON.stringify([
				secondPlan[0],
				{ ...secondEntry, wrapupRunIds: ['second-wrapup'] },
			]),
		});
		await container.services.batch?.transitionBatch(second.id, 'wrapping', 'wrapup_dispatched');
		await container.services.batch?.transitionBatch(second.id, 'done', 'wrapup_clean');
		await container.services.dispatch.tick();
		const completed = container.repos.documentExecutions.findByDocId(docId);
		expect(completed).toMatchObject({ state: 'completed', current_batch_id: null });
		await container.services.dispatch.tick();
		expect(container.repos.documentExecutions.findByDocId(docId)?.version).toBe(completed?.version);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T0', hash: 'new-contract' },
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		const idle = container.services.documentExecution.get(docId).execution;
		expect(idle.state).toBe('idle');
		const restarted = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: idle.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(restarted.statusCode, restarted.body).toBe(200);
		expect(restarted.json().execution.currentBatchId).toBe(first.id);
		expect(container.repos.batches.findById(first.id)?.state).toBe('running');
		expect(container.repos.batches.findById(second.id)?.state).toBe('done');
		await server.instance.close();
	});

	it('freezes the active generation and run ownership when production wrapup is admitted', async () => {
		const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
		const { server, container, headers, docId } = env;
		const batch = container.repos.batches.listByDocId(docId)[0];
		const task = container.repos.tasks.listByDocId(docId)[0];
		if (!batch || !task) return;
		seedImplementationRun(env, {
			id: 'landed-before-wrapup',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const result = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		expect(result?.run.id).toBeDefined();
		const row = container.repos.documentExecutions.findByDocId(docId);
		const entry = JSON.parse(row?.plan_json ?? '[]')[0];
		expect(entry.wrapupRunIds).toContain(result?.run.id);
		const run = container.repos.runs.findById(result?.run.id ?? '');
		const snapshot = container.repos.dispatchSnapshots?.findById(run?.snapshot_id ?? '');
		expect(snapshot?.contract_hash).toBe(entry.membershipFingerprint);
		expect(JSON.parse(snapshot?.input_text ?? 'null')).toMatchObject({
			generationId: entry.generationId,
			membershipFingerprint: entry.membershipFingerprint,
		});
		await server.instance.close();
	});

	it.each([{ inHead: true }, { inHead: false }])(
		'E-367: a clean wrapup completed during pause is adopted on resume (inHead=$inHead)',
		async ({ inHead }) => {
			const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
			const { server, container, headers, docId } = env;
			const batch = container.repos.batches.listByDocId(docId)[0];
			const task = container.repos.tasks.listByDocId(docId)[0];
			if (!batch || !task) return;
			seedImplementationRun(env, {
				id: 'landed-before-paused-wrapup',
				taskId: task.id,
				batchId: batch.id,
				attemptNo: 1,
				contractHash: task.contract_hash,
				createdAt: '2026-10-12T07:00:00.000Z',
			});
			const url = `/api/v1/documents/${docId}/execution`;
			const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
			const started = await server.instance.inject({
				method: 'POST',
				url: `${url}/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(started.statusCode, started.body).toBe(200);
			const wrapup = await container.services.wrapup?.triggerWrapup({
				batchId: batch.id,
				trigger: 'manual',
			});
			const runId = wrapup?.run.id ?? '';
			container.repos.runs.updateState({ id: runId, toState: 'starting' });
			container.repos.runs.updateState({ id: runId, toState: 'running' });
			const paused = await server.instance.inject({
				method: 'POST',
				url: `${url}/pause`,
				headers,
				payload: {
					expectedVersion: container.services.documentExecution.get(docId).execution.version,
				},
			});
			expect(paused.statusCode, paused.body).toBe(200);
			await container.services.wrapup?.recordWrapupResult({
				runId,
				rawText: readFileSync(
					join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
					'utf8',
				),
			});
			container.repos.runs.updateInHead?.({
				id: runId,
				isInHead: inHead ? 1 : 0,
				checkedAt: '2026-10-12T11:00:00.000Z',
			});
			expect(container.repos.batches.findById(batch.id)?.state).toBe('done');
			const resumed = await server.instance.inject({
				method: 'POST',
				url: `${url}/resume`,
				headers,
				payload: {
					expectedVersion: container.services.documentExecution.get(docId).execution.version,
					expectedFingerprint: fingerprint,
				},
			});
			expect(resumed.statusCode, resumed.body).toBe(200);
			expect(container.services.documentExecution.get(docId).execution.state).toBe(
				inHead ? 'completed' : 'running',
			);
			expect(container.repos.batches.findById(batch.id)?.state).toBe('done');
			if (!inHead) {
				await container.services.dispatch.tick();
				expect(container.repos.batches.findById(batch.id)?.state).toBe('done');
				container.repos.runs.updateInHead?.({
					id: runId,
					isInHead: 1,
					checkedAt: '2026-10-12T11:30:00.000Z',
				});
				await container.services.dispatch.tick();
				expect(container.services.documentExecution.get(docId).execution.state).toBe('completed');
			}
			expect(
				container.repos.runs
					.listAll()
					.filter((run) => run.batch_id === batch.id && run.kind === 'wrapup'),
			).toHaveLength(1);
			await server.instance.close();
		},
	);

	it('E-367: an open wrapup saves its report during pause and plans fixes once on resume', async () => {
		const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
		const { server, container, headers, docId } = env;
		const batch = container.repos.batches.listByDocId(docId)[0];
		const task = container.repos.tasks.listByDocId(docId)[0];
		if (!batch || !task) return;
		seedImplementationRun(env, {
			id: 'landed-before-paused-open',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		const runId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: runId, toState: 'starting' });
		container.repos.runs.updateState({ id: runId, toState: 'running' });
		const paused = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
			},
		});
		expect(paused.statusCode, paused.body).toBe(200);
		const report = readFileSync(
			join(root, 'packages/daemon/test/fixtures/wrapup/open-not-fixed.md'),
			'utf8',
		).replace('M4-T7', task.task_key);
		await container.services.wrapup?.recordWrapupResult({ runId, rawText: report });
		expect(container.repos.batchWrapups?.findLatestByBatchId(batch.id)?.verdict).toBe('open');
		expect(
			container.repos.runs.listByTaskId(task.id).filter((run) => run.origin === 'wrapup-fix'),
		).toHaveLength(0);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		await container.services.dispatch.tick();
		expect(
			container.repos.runs.listByTaskId(task.id).filter((run) => run.origin === 'wrapup-fix'),
		).toHaveLength(1);
		await container.services.dispatch.tick();
		expect(
			container.repos.runs.listByTaskId(task.id).filter((run) => run.origin === 'wrapup-fix'),
		).toHaveLength(1);
		expect(container.repos.batchWrapups?.listByBatchId(batch.id)).toHaveLength(1);
		await server.instance.close();
	});

	it.each([
		{ label: 'active', terminal: null },
		{ label: 'aborted', terminal: 'aborted' as const },
		{ label: 'interrupted', terminal: 'interrupted' as const },
	])(
		'keeps a late old-generation wrapup as history while new members wait ($label)',
		async ({ terminal }) => {
			let available = true;
			const env = await setup({
				canDispatch: () => available,
				withWrapupWorkspace: true,
			});
			const { server, container, headers, docId, docsPath } = env;
			const batch = container.repos.batches.listByDocId(docId)[0];
			const task = container.repos.tasks.listByDocId(docId)[0];
			if (!batch || !task) return;
			seedImplementationRun(env, {
				id: 'old-landed',
				taskId: task.id,
				batchId: batch.id,
				attemptNo: 1,
				contractHash: task.contract_hash,
				createdAt: '2026-10-12T07:00:00.000Z',
			});
			const url = `/api/v1/documents/${docId}/execution`;
			const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
			const start = await server.instance.inject({
				method: 'POST',
				url: `${url}/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(start.statusCode, start.body).toBe(200);
			const old = await container.services.wrapup?.triggerWrapup({
				batchId: batch.id,
				trigger: 'manual',
			});
			const oldRunId = old?.run.id ?? '';
			container.repos.runs.updateState({ id: oldRunId, toState: 'starting' });
			container.repos.runs.updateLaneNo?.(oldRunId, 1);
			writeTasksDocsData(docsPath, [
				{ id: 'M1-T1', hash: 'contract-1' },
				{ id: 'M1-T2', hash: 'contract-2' },
			]);
			const refresh = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/refresh`,
				headers,
				payload: {},
			});
			expect(refresh.statusCode, refresh.body).toBe(200);
			const paused = container.services.documentExecution.get(docId).execution;
			available = false;
			const resume = await server.instance.inject({
				method: 'POST',
				url: `${url}/resume`,
				headers,
				payload: {
					expectedVersion: paused.version,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				},
			});
			expect(resume.statusCode, resume.body).toBe(200);
			expect(resume.json().execution.blockers).toContainEqual({
				code: 'source_runs_pending',
				batchId: batch.id,
				taskIds: [],
			});
			expect((await container.services.dispatch.tick()).runsDispatched).toHaveLength(0);
			const cleanReport = readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			);
			if (terminal) container.repos.runs.updateState({ id: oldRunId, toState: terminal });
			const beforeCallback = container.events.ringBuffer.latest()?.id ?? 0;
			await container.services.wrapup?.recordWrapupResult({
				runId: oldRunId,
				rawText: cleanReport,
			});
			expect(container.repos.runs.findById(oldRunId)?.state).toBe(terminal ?? 'landed');
			expect(container.repos.batches.findById(batch.id)?.state).toBe('running');
			expect(container.repos.batchWrapups?.listByBatchId(batch.id).at(-1)?.run_id).toBe(oldRunId);
			const callbackEvents = container.events.ringBuffer
				.getAll()
				.filter((event) => event.id > beforeCallback && event.runId === oldRunId);
			if (terminal) {
				expect(callbackEvents.some((event) => event.kind === 'run.state_changed')).toBe(false);
			} else {
				expect(container.repos.runs.findById(oldRunId)?.lane_no).toBeNull();
				expect(callbackEvents.some((event) => event.kind === 'lane.released')).toBe(true);
			}
			expect(container.services.documentExecution.get(docId).execution.blockers).not.toContainEqual(
				{
					code: 'source_runs_pending',
					batchId: batch.id,
					taskIds: [],
				},
			);
			await server.instance.close();
		},
	);

	it('fails an unstarted old-generation wrapup before dispatching the new generation', async () => {
		let available = true;
		const env = await setup({
			canDispatch: () => available,
			withWrapupWorkspace: true,
		});
		const { server, container, headers, docId, docsPath } = env;
		const batch = container.repos.batches.listByDocId(docId)[0];
		const task = container.repos.tasks.listByDocId(docId)[0];
		if (!batch || !task) return;
		seedImplementationRun(env, {
			id: 'landed-before-old-queue',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const start = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const old = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		const oldRunId = old?.run.id ?? '';
		expect(container.repos.runs.findById(oldRunId)?.state).toBe('queued');
		container.repos.runs.updateLaneNo?.(oldRunId, 1);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		available = false;
		const resume = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		const beforeReconcile = container.events.ringBuffer.latest()?.id ?? 0;
		await container.services.dispatch.tick();
		expect(container.repos.runs.findById(oldRunId)).toMatchObject({
			state: 'failed',
			queued_reason: 'source_changed',
		});
		const reconciliationEvents = container.events.ringBuffer
			.getAll()
			.filter((event) => event.id > beforeReconcile && event.runId === oldRunId);
		expect(reconciliationEvents.some((event) => event.kind === 'run.state_changed')).toBe(true);
		expect(reconciliationEvents.some((event) => event.kind === 'lane.released')).toBe(true);
		expect(container.repos.batches.findById(batch.id)?.state).toBe('running');
		await server.instance.close();
	});

	it('E-369: a stale wrapup human gate cannot complete the rebuilt generation', async () => {
		let available = true;
		const env = await setup({ canDispatch: () => available, withWrapupWorkspace: true });
		const { server, container, headers, docId, docsPath } = env;
		const batch = container.repos.batches.listByDocId(docId)[0];
		const task = container.repos.tasks.listByDocId(docId)[0];
		if (!batch || !task) return;
		seedImplementationRun(env, {
			id: 'stale-gate-implementation',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const old = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		const oldRunId = old?.run.id ?? '';
		await container.services.wrapup?.recordWrapupResult({
			runId: oldRunId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/missing-next.md'),
				'utf8',
			),
		});
		const gate = container.repos.gates?.findPendingByRunId?.(oldRunId);
		expect(gate?.state).toBe('waiting');
		expect(container.repos.runs.findById(oldRunId)?.state).toBe('awaiting_human');
		await container.services.dispatch.tick();
		expect(container.repos.gates?.findById(gate?.id ?? '')?.state).toBe('waiting');
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		available = false;
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		await container.services.wrapup?.recordWrapupResult({
			runId: oldRunId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			),
		});
		expect(container.repos.gates?.findById(gate?.id ?? '')?.state).toBe('decided');
		await container.services.dispatch.tick();
		expect(container.repos.gates?.findById(gate?.id ?? '')).toMatchObject({
			state: 'decided',
			decision: null,
			comment: 'superseded',
		});
		expect(container.repos.runs.findById(oldRunId)).toMatchObject({
			state: 'landed',
		});
		await expect(
			container.services.gates?.decideGate({
				gateId: gate?.id ?? '',
				decision: 'pass',
				comment: 'Late old verdict',
				actorDeviceId: 'dev-1',
			}),
		).rejects.toMatchObject({ code: 'E_GATE_ALREADY_DECIDED' });
		expect(container.repos.batches.findById(batch.id)?.state).toBe('running');
		await server.instance.close();
	});

	it('does not admit a run after pause wins an asynchronous tick preflight', async () => {
		const { server, container, headers, docId, pauseNextGitRun } = await setup({
			canDispatch: () => true,
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const fingerprint = container.repos.documents.findById(docId)?.content_fingerprint;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const gate = pauseNextGitRun();
		const tick = container.services.dispatch.tick();
		await gate.entered;
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: started.json().execution.version },
		});
		expect(pause.statusCode, pause.body).toBe(200);
		gate.release();
		expect((await tick).runsDispatched).toHaveLength(0);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		expect(container.services.documentExecution.get(docId).execution.state).toBe('paused');
		await server.instance.close();
	});

	it('pauses a running plan when the source changes before refresh', async () => {
		const { server, container, headers, docId, docsPath } = await setup();
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'changed-contract' }]);
		await container.services.dispatch.tick();
		expect(container.services.documentExecution.get(docId).execution).toMatchObject({
			state: 'paused',
			pauseReason: 'doc_changed',
		});
		expect(container.repos.runs.listAll()).toHaveLength(0);
		await server.instance.close();
	});

	it('shares the Agent limit across two running documents in one tick', async () => {
		const { server, container, headers, docId, folder } = await setup({
			canDispatch: () => true,
		});
		const secondPath = join(folder, 'second-docs-data.js');
		writeTasksDocsData(secondPath, [{ id: 'M1-T2', hash: 'other-contract' }]);
		writeFileSync(secondPath, readFileSync(secondPath, 'utf8').replaceAll('src/', 'unrelated/'));
		const imported = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers,
			payload: { docsPath: secondPath, repoPath: root },
		});
		expect(imported.statusCode, imported.body).toBe(200);
		const secondId = imported.json().document.id as string;
		for (const id of [docId, secondId]) {
			const started = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${id}/execution/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: container.repos.documents.findById(id)?.content_fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(started.statusCode, started.body).toBe(200);
		}
		const result = await container.services.dispatch.tick();
		expect(result.runsDispatched).toHaveLength(1);
		expect(container.repos.runs.listAll()).toHaveLength(1);
		await server.instance.close();
	});

	it('uses a task draft while an unavailable document default waits', async () => {
		const { server, container, headers, docId, docsPath } = await setup({
			canDispatch: (agentId) => agentId === 'pi',
		});
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const tasks = container.repos.tasks.listByDocId(docId);
		const draftTask = tasks.find((task) => task.task_key === 'M1-T1');
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!draftTask || !batch) return;
		await container.services.assignments.putDrafts({
			batchId: batch.id,
			assignments: [{ taskId: draftTask.id, agentId: 'pi', model: null, effort: null }],
		});
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: { vendor: 'ultra' } },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).toHaveLength(1);
		const run = container.repos.runs.findById(tick.runsDispatched[0] ?? '');
		expect(run?.task_id).toBe(draftTask.id);
		expect(run?.agent_id).toBe('pi');
		expect(run?.effort_vendor).not.toBe('ultra');
		expect(container.services.documentExecution.get(docId).execution.blockers).toContainEqual({
			code: 'agent_unavailable',
			batchId: batch.id,
			taskIds: [tasks.find((task) => task.task_key === 'M1-T2')?.id],
		});
		await server.instance.close();
	});

	it('holds a shared path across two documents even with two Agent slots', async () => {
		const { server, container, headers, docId, folder, registry } = await setup({
			canDispatch: () => true,
			agentConcurrencyLimit: 2,
		});
		expect(registry.getSnapshot().agents.codex?.maxConcurrency).toBe(2);
		const secondPath = join(folder, 'same-path-docs-data.js');
		writeTasksDocsData(secondPath, [{ id: 'M1-T2', hash: 'other-contract' }]);
		const imported = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers,
			payload: { docsPath: secondPath, repoPath: root },
		});
		expect(imported.statusCode, imported.body).toBe(200);
		for (const id of [docId, imported.json().document.id as string]) {
			const started = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${id}/execution/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: container.repos.documents.findById(id)?.content_fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(started.statusCode, started.body).toBe(200);
		}
		const result = await container.services.dispatch.tick();
		expect(result.runsDispatched).toHaveLength(1);
		expect(container.repos.runs.listAll()).toHaveLength(1);
		await server.instance.close();
	});

	it('E-362: an in-flight run holds its frozen paths after document refresh', async () => {
		const { server, container, headers, docId, docsPath, folder } = await setup({
			canDispatch: () => true,
			agentConcurrencyLimit: 2,
			withImplementationProcess: true,
		});
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-1' }]);
		writeFileSync(docsPath, readFileSync(docsPath, 'utf8').replaceAll('src/', 'src/old/'));
		const firstRefresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(firstRefresh.statusCode, firstRefresh.body).toBe(200);
		const firstStart = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(firstStart.statusCode, firstStart.body).toBe(200);
		const firstTick = await container.services.dispatch.tick();
		expect(firstTick.runsDispatched).toHaveLength(1);
		const firstRun = container.repos.runs.findById(firstTick.runsDispatched[0] ?? '');
		expect(
			container.repos.dispatchSnapshots?.findById(firstRun?.snapshot_id ?? '')?.task_paths_json,
		).toContain('src/old/');
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-1' }]);
		writeFileSync(docsPath, readFileSync(docsPath, 'utf8').replaceAll('src/', 'src/new/'));
		const secondRefresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(secondRefresh.statusCode, secondRefresh.body).toBe(200);
		expect(container.repos.tasks.listByDocId(docId)[0]?.task_paths_json).toContain('src/new/');
		const secondPath = join(folder, 'frozen-path-docs-data.js');
		writeTasksDocsData(secondPath, [{ id: 'M1-T2', hash: 'other-contract' }]);
		writeFileSync(secondPath, readFileSync(secondPath, 'utf8').replaceAll('src/', 'src/old/'));
		const imported = await server.instance.inject({
			method: 'POST',
			url: '/api/v1/documents',
			headers,
			payload: { docsPath: secondPath, repoPath: root },
		});
		expect(imported.statusCode, imported.body).toBe(200);
		const secondId = imported.json().document.id as string;
		const secondStart = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${secondId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(secondId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(secondStart.statusCode, secondStart.body).toBe(200);
		const secondTick = await container.services.dispatch.tick();
		expect(secondTick.runsDispatched).toHaveLength(0);
		expect(container.repos.runs.listAll()).toHaveLength(1);
		await server.instance.close();
	});

	it('relays after production wrapup records clean and its branch reaches HEAD', async () => {
		let available = true;
		const env = await setup({
			canDispatch: () => available,
			withWrapupWorkspace: true,
		});
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const batches = container.repos.batches.listByDocId(docId);
		const first = batches[0];
		const second = batches[1];
		if (!first || !second) return;
		const task = container.repos.tasks.listByBatchId(first.id)[0];
		if (!task) return;
		seedImplementationRun(env, {
			id: 'first-landed-for-real-wrapup',
			taskId: task.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const start = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: first.id,
			trigger: 'manual',
		});
		const runId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: runId, toState: 'starting' });
		container.repos.runs.updateState({ id: runId, toState: 'running' });
		const cleanReport = readFileSync(
			join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
			'utf8',
		);
		await container.services.wrapup?.recordWrapupResult({ runId, rawText: cleanReport });
		available = false;
		expect(container.repos.batches.findById(first.id)?.state).toBe('done');
		container.repos.runs.updateInHead?.({
			id: runId,
			isInHead: 0,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		expect(container.repos.batches.findById(second.id)?.state).toBe('idle');
		container.repos.runs.updateInHead?.({
			id: runId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		expect(container.repos.batches.findById(second.id)?.state).toBe('running');
		expect(container.repos.documentExecutions.findByDocId(docId)?.current_batch_id).toBe(second.id);
		await server.instance.close();
	});

	it('reaches the managed process port from document start through the production tick', async () => {
		const { server, container, headers, docId, getSpawnedRuns } = await setup({
			canDispatch: () => true,
			withImplementationProcess: true,
		});
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		await container.services.dispatch.tick();
		await vi.waitFor(() => expect(getSpawnedRuns()).toHaveLength(1));
		const run = container.repos.runs.findById(getSpawnedRuns()[0] ?? '');
		expect(run?.state).toBe('running');
		const snapshot = container.repos.dispatchSnapshots?.findById(run?.snapshot_id ?? '');
		const generationId = JSON.parse(
			container.repos.documentExecutions.findByDocId(docId)?.plan_json ?? '[]',
		)[0].generationId;
		expect(JSON.parse(snapshot?.launch_spec_json ?? '{}').documentGenerationId).toBe(generationId);
		await server.instance.close();
	});

	it('R1: revalidates a changed landed contract before current-generation wrapup', async () => {
		const env = await setup({
			canDispatch: () => true,
			withWrapupWorkspace: true,
			withImplementationProcess: true,
		});
		const { server, container, headers, docId, docsPath } = env;
		const batch = container.repos.batches.listByDocId(docId)[0];
		const task = container.repos.tasks.listByDocId(docId)[0];
		if (!batch || !task) return;
		seedImplementationRun(env, {
			id: 'r1-old-landed',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		container.repos.tasks.updateManualState(task.id, 'landed');
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		const pending = await container.services.dispatch.tick();
		expect(pending.tasksBlocked).toContainEqual({
			taskId: task.id,
			reason: 'doc_changed_pending_confirmation',
		});
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(task.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		const dispatched = await container.services.dispatch.tick();
		expect(dispatched.runsDispatched).toHaveLength(1);
		const newRunId = dispatched.runsDispatched[0] ?? '';
		const newRun = container.repos.runs.findById(newRunId);
		expect(newRun?.kind).toBe('implement');
		expect(newRun?.id).not.toBe('r1-old-landed');
		expect(
			container.repos.dispatchSnapshots?.findById(newRun?.snapshot_id ?? '')?.contract_hash,
		).toBe('contract-2');
		container.repos.runs.updateState({
			id: newRunId,
			toState: 'landed',
			endedAt: '2026-10-12T09:00:00.000Z',
		});
		container.repos.runs.updateInHead?.({
			id: newRunId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		const wrapupRunId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: wrapupRunId, toState: 'starting' });
		container.repos.runs.updateState({ id: wrapupRunId, toState: 'running' });
		await container.services.wrapup?.recordWrapupResult({
			runId: wrapupRunId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			),
		});
		container.repos.runs.updateInHead?.({
			id: wrapupRunId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		expect(container.services.documentExecution.get(docId).execution.state).toBe('completed');
		expect(container.repos.runs.findById('r1-old-landed')?.state).toBe('landed');
		await server.instance.close();
	});

	it('E-369: completed execution reopens when refresh moves a member without changing task hashes', async () => {
		const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const firstRefresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(firstRefresh.statusCode, firstRefresh.body).toBe(200);
		const batch = container.repos.batches.listByDocId(docId)[0];
		const tasks = container.repos.tasks.listByDocId(docId);
		if (!batch || tasks.length !== 2) return;
		for (const [index, task] of tasks.entries()) {
			seedImplementationRun(env, {
				id: `completed-move-${index}`,
				taskId: task.id,
				batchId: batch.id,
				attemptNo: 1,
				contractHash: task.contract_hash,
				createdAt: '2026-10-12T07:00:00.000Z',
			});
		}
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
		});
		const wrapupId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: wrapupId, toState: 'starting' });
		container.repos.runs.updateState({ id: wrapupId, toState: 'running' });
		await container.services.wrapup?.recordWrapupResult({
			runId: wrapupId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			),
		});
		container.repos.runs.updateInHead?.({
			id: wrapupId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		const completed = container.services.documentExecution.get(docId).execution;
		expect(completed.state).toBe('completed');
		const runCount = container.repos.runs.listAll().length;
		const beforeRefreshEvent = container.events.ringBuffer.latest()?.id;
		const unchanged = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(unchanged.statusCode, unchanged.body).toBe(200);
		expect(container.services.documentExecution.get(docId).execution.version).toBe(
			completed.version,
		);
		expect(container.events.ringBuffer.latest()?.id).toBe(beforeRefreshEvent);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const moved = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(moved.statusCode, moved.body).toBe(200);
		const reopened = container.services.documentExecution.get(docId).execution;
		expect(reopened.state).toBe('idle');
		expect(reopened.version).toBeGreaterThan(completed.version);
		expect(container.repos.documentExecutions.findByDocId(docId)?.completed_at).toBeNull();
		expect(container.repos.runs.listAll()).toHaveLength(runCount);
		expect(
			container.events.ringBuffer
				.getAll()
				.some(
					(event) =>
						event.id > (beforeRefreshEvent ?? 0) && event.kind === 'document.execution_changed',
				),
		).toBe(true);
		const restarted = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: reopened.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(restarted.statusCode, restarted.body).toBe(200);
		expect(restarted.json().execution.state).toBe('running');
		await server.instance.close();
	});

	it.each([
		{ label: 'clean', report: 'clean-report.md' },
		{ label: 'open', report: 'open-not-fixed.md' },
	])(
		'E-369: a returned contract uses valid evidence for $label wrapup artifacts',
		async ({ label, report }) => {
			const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
			const { server, container, headers, docId, docsPath } = env;
			const task = container.repos.tasks.listByDocId(docId)[0];
			const batch = container.repos.batches.listByDocId(docId)[0];
			if (!task || !batch) return;
			seedImplementationRun(env, {
				id: 'contract-a-landed',
				taskId: task.id,
				batchId: batch.id,
				attemptNo: 1,
				contractHash: 'contract-1',
				agentId: 'codex',
				branchName: 'task/contract-a',
				worktreePath: '/valid-a',
				createdAt: '2026-10-12T07:00:00.000Z',
			});
			const url = `/api/v1/documents/${docId}/execution`;
			const started = await server.instance.inject({
				method: 'POST',
				url: `${url}/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(started.statusCode, started.body).toBe(200);
			writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
			const changedToB = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/refresh`,
				headers,
				payload: {},
			});
			expect(changedToB.statusCode, changedToB.body).toBe(200);
			const resumedB = await server.instance.inject({
				method: 'POST',
				url: `${url}/resume`,
				headers,
				payload: {
					expectedVersion: container.services.documentExecution.get(docId).execution.version,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				},
			});
			expect(resumedB.statusCode, resumedB.body).toBe(200);
			seedImplementationRun(env, {
				id: 'contract-b-failed',
				taskId: task.id,
				batchId: batch.id,
				attemptNo: 2,
				contractHash: 'contract-2',
				agentId: 'pi',
				branchName: 'task/contract-b',
				worktreePath: '/failed-b',
				createdAt: '2026-10-12T08:00:00.000Z',
			});
			container.repos.runs.updateState({ id: 'contract-b-failed', toState: 'failed' });
			writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-1' }]);
			const returnedToA = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/refresh`,
				headers,
				payload: {},
			});
			expect(returnedToA.statusCode, returnedToA.body).toBe(200);
			const resumedA = await server.instance.inject({
				method: 'POST',
				url: `${url}/resume`,
				headers,
				payload: {
					expectedVersion: container.services.documentExecution.get(docId).execution.version,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				},
			});
			expect(resumedA.statusCode, resumedA.body).toBe(200);
			container.repos.dispatchSnapshots?.updateTaskChangedFlags(task.id, {
				hasAcceptChanged: false,
				hasPromptChanged: false,
			});
			const wrapup = await container.services.wrapup?.triggerWrapup({
				batchId: batch.id,
				trigger: 'manual',
			});
			expect(wrapup?.run.agentId).toBe('codex');
			const wrapupId = wrapup?.run.id ?? '';
			const wrapupSnapshot = container.repos.dispatchSnapshots?.findById(
				container.repos.runs.findById(wrapupId)?.snapshot_id ?? '',
			);
			expect(wrapupSnapshot?.impl_prompt).toContain('task/contract-a');
			expect(wrapupSnapshot?.impl_prompt).not.toContain('task/contract-b');
			container.repos.runs.updateState({ id: wrapupId, toState: 'starting' });
			container.repos.runs.updateState({ id: wrapupId, toState: 'running' });
			const reportText = readFileSync(
				join(root, `packages/daemon/test/fixtures/wrapup/${report}`),
				'utf8',
			);
			await container.services.wrapup?.recordWrapupResult({
				runId: wrapupId,
				rawText: label === 'open' ? reportText.replace('M4-T7', 'M1-T1') : reportText,
			});
			if (label === 'open') {
				const wrapupRecord = container.repos.batchWrapups?.findLatestByBatchId(batch.id);
				const fixRunIds = JSON.parse(wrapupRecord?.fix_run_ids_json ?? '[]') as string[];
				expect(fixRunIds).toHaveLength(1);
				const fixRun = container.repos.runs.findById(fixRunIds[0] ?? '');
				const fixSnapshot = container.repos.dispatchSnapshots?.findById(fixRun?.snapshot_id ?? '');
				expect(fixRun?.agent_id).toBe('codex');
				expect(fixSnapshot?.contract_hash).toBe('contract-1');
				expect(fixSnapshot?.impl_prompt).not.toContain('task/contract-b');
			} else {
				container.repos.runs.updateInHead?.({
					id: wrapupId,
					isInHead: 1,
					checkedAt: '2026-10-12T11:00:00.000Z',
				});
				await container.services.dispatch.tick();
				expect(container.services.documentExecution.get(docId).execution.state).toBe('completed');
			}
			expect(container.repos.runs.findById('contract-a-landed')?.state).toBe('landed');
			expect(container.repos.runs.findById('contract-b-failed')?.state).toBe('failed');
			await server.instance.close();
		},
	);

	it('R1: changed-contract work reports an unavailable Agent despite old landed history', async () => {
		let available = true;
		const env = await setup({ canDispatch: () => available });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		seedImplementationRun(env, {
			id: 'r1-availability-old-landed',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refreshed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refreshed.statusCode, refreshed.body).toBe(200);
		available = false;
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		expect(resumed.json().execution.blockers).toContainEqual({
			code: 'agent_unavailable',
			batchId: batch.id,
			taskIds: [task.id],
		});
		expect(container.repos.runs.findById('r1-availability-old-landed')?.state).toBe('landed');
		await server.instance.close();
	});

	it('R1: stale reworking implementation cannot replace the changed contract', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		seedImplementationRun(env, {
			id: 'r1-stale-rework',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		container.repos.runs.updateState({ id: 'r1-stale-rework', toState: 'reworking' });
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refreshed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refreshed.statusCode, refreshed.body).toBe(200);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(task.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).toHaveLength(1);
		const next = container.repos.runs.findById(tick.runsDispatched[0] ?? '');
		expect(next?.kind).toBe('implement');
		expect(next?.id).not.toBe('r1-stale-rework');
		expect(
			container.repos.dispatchSnapshots?.findById(next?.snapshot_id ?? '')?.contract_hash,
		).toBe('contract-2');
		expect(container.repos.runs.findById('r1-stale-rework')?.state).toBe('failed');
		await server.instance.close();
	});

	it.each([{ state: 'reworking' as const }, { state: 'awaiting_human' as const }])(
		'R1: a moved $state task cannot hold the new batch Agent slot or path',
		async ({ state }) => {
			const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
			const { server, container, headers, docId, docsPath } = env;
			writeTasksDocsData(docsPath, [
				{ id: 'M1-T1', hash: 'contract-1' },
				{ id: 'M1-T2', hash: 'contract-2' },
			]);
			const refreshed = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/refresh`,
				headers,
				payload: {},
			});
			expect(refreshed.statusCode, refreshed.body).toBe(200);
			const firstTask = container.repos.tasks
				.listByDocId(docId)
				.find((task) => task.task_key === 'M1-T1');
			const movedTask = container.repos.tasks
				.listByDocId(docId)
				.find((task) => task.task_key === 'M1-T2');
			const firstBatch = container.repos.batches.listByDocId(docId)[0];
			if (!firstTask || !movedTask || !firstBatch) return;
			const url = `/api/v1/documents/${docId}/execution`;
			const started = await server.instance.inject({
				method: 'POST',
				url: `${url}/start`,
				headers,
				payload: {
					expectedVersion: 0,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
					defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
				},
			});
			expect(started.statusCode, started.body).toBe(200);
			seedImplementationRun(env, {
				id: 'r1-moved-rework',
				taskId: movedTask.id,
				batchId: firstBatch.id,
				attemptNo: 1,
				contractHash: movedTask.contract_hash,
				generationId: started.json().execution.wrapupProgress.generationId,
				createdAt: '2026-10-12T07:00:00.000Z',
			});
			container.repos.runs.updateState({ id: 'r1-moved-rework', toState: state });
			if (state === 'awaiting_human')
				container.repos.tasks.updateManualState(movedTask.id, 'awaiting_human');
			writeTasksDocsData(docsPath, [
				{ id: 'M1-T1', hash: 'contract-1' },
				{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
			]);
			const changed = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/documents/${docId}/refresh`,
				headers,
				payload: {},
			});
			expect(changed.statusCode, changed.body).toBe(200);
			await container.services.dispatch.tick();
			expect(container.services.documentExecution.get(docId).execution.state).toBe('paused');
			const resumed = await server.instance.inject({
				method: 'POST',
				url: `${url}/resume`,
				headers,
				payload: {
					expectedVersion: container.services.documentExecution.get(docId).execution.version,
					expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				},
			});
			expect(resumed.statusCode, resumed.body).toBe(200);
			expect(resumed.json().execution.currentBatchId).toBe(firstBatch.id);
			container.repos.dispatchSnapshots?.updateTaskChangedFlags(firstTask.id, {
				hasAcceptChanged: false,
				hasPromptChanged: false,
			});
			const tick = await container.services.dispatch.tick();
			expect(container.repos.runs.findById('r1-moved-rework')?.state).toBe('failed');
			if (state === 'awaiting_human')
				expect(container.repos.tasks.findById(movedTask.id)?.manual_state).toBeNull();
			expect(
				tick.runsDispatched.some(
					(id) => container.repos.runs.findById(id)?.task_id === firstTask.id,
				),
			).toBe(true);
			await server.instance.close();
		},
	);

	it('R1: a changed contract clears its obsolete human gate before new dispatch', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		seedImplementationRun(env, {
			id: 'r1-obsolete-human',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			generationId: started.json().execution.wrapupProgress.generationId,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		container.repos.runs.updateState({ id: 'r1-obsolete-human', toState: 'awaiting_human' });
		container.repos.tasks.updateManualState(task.id, 'awaiting_human');
		container.repos.gates?.create({
			id: 'gate-r1-obsolete-human',
			task_id: task.id,
			run_id: 'r1-obsolete-human',
			kind: 'review',
			state: 'waiting',
			created_at: '2026-10-12T07:00:00.000Z',
		});
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		expect(
			resumed
				.json()
				.execution.blockers.some((blocker: { code: string }) => blocker.code === 'gate_waiting'),
		).toBe(false);
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(task.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		const tick = await container.services.dispatch.tick();
		expect(container.repos.runs.findById('r1-obsolete-human')?.state).toBe('failed');
		expect(container.repos.tasks.findById(task.id)?.manual_state).toBeNull();
		expect(container.repos.gates?.findById('gate-r1-obsolete-human')).toMatchObject({
			state: 'decided',
			decision: null,
			comment: 'superseded',
		});
		await expect(
			container.services.gates?.decideGate({
				gateId: 'gate-r1-obsolete-human',
				decision: 'reject',
				comment: 'Late old gate',
				actorDeviceId: 'dev-1',
			}),
		).rejects.toMatchObject({ code: 'E_GATE_ALREADY_DECIDED' });
		expect(
			tick.runsDispatched.some((id) => container.repos.runs.findById(id)?.task_id === task.id),
		).toBe(true);
		await server.instance.close();
	});

	it('E-364: a current pre-dispatch human gate stays visible without a run', async () => {
		const { server, container, headers, docId } = await setup({ canDispatch: () => true });
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		container.repos.tasks.updateManualState(task.id, 'awaiting_human');
		const started = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/execution/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.blockers).toContainEqual({
			code: 'gate_waiting',
			batchId: batch.id,
			taskIds: [task.id],
		});
		expect((await container.services.dispatch.tick()).runsDispatched).toHaveLength(0);
		expect(container.repos.tasks.findById(task.id)?.manual_state).toBe('awaiting_human');
		await server.instance.close();
	});

	it('E-369: a moved task retries in its new batch after an old-batch failure', async () => {
		const env = await setup({
			canDispatch: () => true,
			withWrapupWorkspace: true,
			withImplementationProcess: true,
		});
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
		]);
		const imported = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(imported.statusCode, imported.body).toBe(200);
		const [first] = container.repos.batches.listByDocId(docId);
		const landedTask = container.repos.tasks
			.listByDocId(docId)
			.find((task) => task.task_key === 'M1-T1');
		const movedTask = container.repos.tasks
			.listByDocId(docId)
			.find((task) => task.task_key === 'M1-T2');
		if (!first || !landedTask || !movedTask) return;
		seedImplementationRun(env, {
			id: 'moved-prior-landed',
			taskId: landedTask.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: landedTask.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		seedImplementationRun(env, {
			id: 'moved-prior-failed',
			taskId: movedTask.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: movedTask.contract_hash,
			createdAt: '2026-10-12T07:30:00.000Z',
		});
		container.repos.runs.updateState({ id: 'moved-prior-failed', toState: 'failed' });
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
		]);
		const moved = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(moved.statusCode, moved.body).toBe(200);
		await container.services.dispatch.tick();
		expect(container.services.documentExecution.get(docId).execution.state).toBe('paused');
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		const second = container.repos.batches
			.listByDocId(docId)
			.find((batch) => batch.id !== first.id);
		expect(second).toBeDefined();
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: first.id,
			trigger: 'manual',
		});
		const wrapupId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: wrapupId, toState: 'starting' });
		container.repos.runs.updateState({ id: wrapupId, toState: 'running' });
		await container.services.wrapup?.recordWrapupResult({
			runId: wrapupId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			),
		});
		container.repos.runs.updateInHead?.({
			id: wrapupId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		expect(container.services.documentExecution.get(docId).execution.currentBatchId).toBe(
			second?.id,
		);
		const blocked = await container.services.dispatch.tick();
		expect(blocked.tasksBlocked).toContainEqual({
			taskId: movedTask.id,
			reason: 'doc_changed_pending_confirmation',
		});
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(movedTask.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		const next = await container.services.dispatch.tick();
		expect(
			next.runsDispatched.some((id) => container.repos.runs.findById(id)?.task_id === movedTask.id),
		).toBe(true);
		expect(container.repos.runs.listByTaskId(landedTask.id)).toHaveLength(1);
		expect(container.repos.runs.findById('moved-prior-landed')?.state).toBe('landed');
		expect(container.repos.runs.findById('moved-prior-failed')?.state).toBe('failed');
		await server.instance.close();
	});

	it('R2: removed unlanded member cannot block current wrapup and next batch', async () => {
		let available = true;
		const env = await setup({
			canDispatch: () => available,
			withWrapupWorkspace: true,
		});
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2' },
			{ id: 'M1-T3', hash: 'contract-3', deps: ['M1-T1'] },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const batches = container.repos.batches.listByDocId(docId);
		const first = batches[0];
		const second = batches[1];
		const landed = container.repos.tasks
			.listByDocId(docId)
			.find((task) => task.task_key === 'M1-T1');
		const removed = container.repos.tasks
			.listByDocId(docId)
			.find((task) => task.task_key === 'M1-T2');
		if (!first || !second || !landed || !removed) return;
		seedImplementationRun(env, {
			id: 'r2-landed',
			taskId: landed.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: landed.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T3', hash: 'contract-3', deps: ['M1-T1'] },
		]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		expect(container.repos.tasks.findById(removed.id)?.is_removed_from_doc).toBe(1);
		const wrapup = await container.services.wrapup?.triggerWrapup({
			batchId: first.id,
			trigger: 'manual',
		});
		const runId = wrapup?.run.id ?? '';
		container.repos.runs.updateState({ id: runId, toState: 'starting' });
		container.repos.runs.updateState({ id: runId, toState: 'running' });
		await container.services.wrapup?.recordWrapupResult({
			runId,
			rawText: readFileSync(
				join(root, 'packages/daemon/test/fixtures/wrapup/clean-report.md'),
				'utf8',
			),
		});
		available = false;
		container.repos.runs.updateInHead?.({
			id: runId,
			isInHead: 1,
			checkedAt: '2026-10-12T11:00:00.000Z',
		});
		await container.services.dispatch.tick();
		expect(container.repos.batches.findById(second.id)?.state).toBe('running');
		expect(container.repos.runs.findById('r2-landed')?.state).toBe('landed');
		await server.instance.close();
	});

	it('R3: a queued wrapup from a removed batch releases its lane and publishes its failure', async () => {
		let available = true;
		const env = await setup({ canDispatch: () => available, withWrapupWorkspace: true });
		const { server, container, headers, docId, docsPath } = env;
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T2', hash: 'contract-2', deps: ['M1-T1'] },
			{ id: 'M1-T3', hash: 'contract-3', deps: ['M1-T2'] },
		]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const [first, second] = container.repos.batches.listByDocId(docId);
		const firstTask = container.repos.tasks.listByDocId(docId).find((t) => t.task_key === 'M1-T1');
		const secondTask = container.repos.tasks.listByDocId(docId).find((t) => t.task_key === 'M1-T2');
		if (!first || !second || !firstTask || !secondTask) return;
		container.repos.documents.updateLaneCount(docId, 1);
		seedImplementationRun(env, {
			id: 'r3-first-landed',
			taskId: firstTask.id,
			batchId: first.id,
			attemptNo: 1,
			contractHash: firstTask.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const firstFingerprint = membershipFingerprint(
			[{ taskKey: firstTask.task_key, contractHash: firstTask.contract_hash }],
			(value) => createHash('sha256').update(value, 'utf8').digest('hex'),
		);
		seedWrapupRun(env, {
			id: 'r3-first-wrapup',
			batchId: first.id,
			attemptNo: 1,
			state: 'landed',
			inputText: JSON.stringify({
				generationId: 0,
				membershipFingerprint: firstFingerprint,
				members: [{ task_key: firstTask.task_key, contractHash: firstTask.contract_hash }],
			}),
			contractHash: firstFingerprint,
			createdAt: '2026-10-12T08:00:00.000Z',
		});
		seedWrapupVerdict(env, {
			id: 'r3-first-clean',
			batchId: first.id,
			runId: 'r3-first-wrapup',
			round: 1,
			verdict: 'clean',
			createdAt: '2026-10-12T08:00:00.000Z',
		});
		await container.services.batch?.transitionBatch(first.id, 'running', 'legacy_start');
		await container.services.batch?.transitionBatch(first.id, 'wrapping', 'legacy_wrapup');
		await container.services.batch?.transitionBatch(first.id, 'done', 'legacy_clean');
		seedImplementationRun(env, {
			id: 'r3-second-landed',
			taskId: secondTask.id,
			batchId: second.id,
			attemptNo: 1,
			contractHash: secondTask.contract_hash,
			createdAt: '2026-10-12T09:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		expect(started.json().execution.currentBatchId).toBe(second.id);
		const oldWrapup = await container.services.wrapup?.triggerWrapup({
			batchId: second.id,
			trigger: 'manual',
		});
		const oldRunId = oldWrapup?.run.id ?? '';
		expect(container.repos.runs.findById(oldRunId)?.state).toBe('queued');
		container.repos.runs.updateLaneNo?.(oldRunId, 1);
		writeTasksDocsData(docsPath, [
			{ id: 'M1-T1', hash: 'contract-1' },
			{ id: 'M1-T3', hash: 'contract-3' },
		]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		available = false;
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		expect(resumed.json().execution.currentBatchId).toBe(first.id);
		const beforeReconcile = container.events.ringBuffer.latest()?.id ?? 0;
		await container.services.dispatch.tick();
		expect(container.repos.runs.findById(oldRunId)).toMatchObject({
			state: 'failed',
			queued_reason: 'source_changed',
			lane_no: null,
		});
		const events = container.events.ringBuffer
			.getAll()
			.filter((event) => event.id > beforeReconcile);
		expect(
			events.some((event) => event.kind === 'run.state_changed' && event.runId === oldRunId),
		).toBe(true);
		expect(events.some((event) => event.kind === 'lane.released' && event.runId === oldRunId)).toBe(
			true,
		);
		seedWrapupRun(env, {
			id: 'r3-old-running-wrapup',
			batchId: second.id,
			attemptNo: 3,
			state: 'starting',
			createdAt: '2026-10-12T10:00:00.000Z',
		});
		container.repos.runs.updateLaneNo?.('r3-old-running-wrapup', 1);
		const moved = container.repos.tasks
			.listByDocId(docId)
			.find((task) => task.task_key === 'M1-T3');
		if (!moved) return;
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(moved.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		available = true;
		expect(container.services.documentExecution.get(docId).execution.blockers).toContainEqual({
			code: 'source_runs_pending',
			batchId: first.id,
			taskIds: [],
		});
		const held = await container.services.dispatch.tick();
		expect(held.runsDispatched).toHaveLength(0);
		expect(container.repos.runs.listByTaskId(moved.id)).toHaveLength(0);
		container.repos.runs.updateState({ id: 'r3-old-running-wrapup', toState: 'failed' });
		container.repos.runs.updateLaneNo?.('r3-old-running-wrapup', null);
		const resumedTick = await container.services.dispatch.tick();
		expect(
			resumedTick.runsDispatched.some(
				(id) => container.repos.runs.findById(id)?.task_id === moved.id,
			),
		).toBe(true);
		await server.instance.close();
	});

	it.each([
		{ label: 'review', kind: 'review' as const },
		{ label: 'bughunt', kind: 'bughunt' as const },
		{ label: 'wrapup-fix', kind: 'implement' as const, origin: 'wrapup-fix' as const },
	])('R3: stale queued $label stays out of the rebuilt generation', async (stage) => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const oldGeneration = start.json().execution.wrapupProgress.generationId as number;
		const queuedId = `r3-old-${stage.label}`;
		seedQueuedStageRun(env, {
			id: queuedId,
			taskId: task.id,
			batchId: batch.id,
			contractHash: task.contract_hash,
			generationId: oldGeneration,
			kind: stage.kind,
			origin: 'origin' in stage ? stage.origin : undefined,
		});
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).not.toContain(queuedId);
		expect(container.repos.runs.findById(queuedId)).toMatchObject({
			state: 'failed',
			queued_reason: 'source_changed',
		});
		expect(container.repos.dispatchSnapshots?.findById(`snapshot-${queuedId}`)).not.toBeNull();
		await server.instance.close();
	});

	it('R3: rejecting an old queued bughunt retires its parked implementation parent', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const generationId = started.json().execution.wrapupProgress.generationId as number;
		seedImplementationRun(env, {
			id: 'r3-parked-parent',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			generationId,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		container.repos.runs.updateState({ id: 'r3-parked-parent', toState: 'reviewing' });
		container.repos.runs.updateLaneNo?.('r3-parked-parent', 1);
		container.repos.tasks.assignLaneNo(task.id, 1);
		seedQueuedStageRun(env, {
			id: 'r3-old-bughunt-child',
			taskId: task.id,
			batchId: batch.id,
			contractHash: task.contract_hash,
			generationId,
			attemptNo: 2,
			kind: 'bughunt',
			parentRunId: 'r3-parked-parent',
		});
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const changed = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(changed.statusCode, changed.body).toBe(200);
		const resumed = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resumed.statusCode, resumed.body).toBe(200);
		container.repos.dispatchSnapshots?.updateTaskChangedFlags(task.id, {
			hasAcceptChanged: false,
			hasPromptChanged: false,
		});
		const beforeReconcile = container.events.ringBuffer.latest()?.id ?? 0;
		const tick = await container.services.dispatch.tick();
		expect(container.repos.runs.findById('r3-old-bughunt-child')).toMatchObject({
			state: 'failed',
			queued_reason: 'source_changed',
		});
		expect(container.repos.runs.findById('r3-parked-parent')).toMatchObject({
			state: 'failed',
			queued_reason: 'source_changed',
			lane_no: null,
		});
		const replacement = tick.runsDispatched
			.map((id) => container.repos.runs.findById(id))
			.find((run) => run?.task_id === task.id);
		expect(replacement).toBeDefined();
		expect(container.repos.tasks.findById(task.id)?.lane_no).toBe(replacement?.lane_no);
		expect(
			container.events.ringBuffer
				.getAll()
				.some(
					(event) =>
						event.id > beforeReconcile &&
						event.kind === 'lane.released' &&
						event.runId === 'r3-parked-parent',
				),
		).toBe(true);
		await server.instance.close();
	});

	it('R3: same-generation queued review resumes after a user pause', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const generationId = start.json().execution.wrapupProgress.generationId as number;
		seedQueuedStageRun(env, {
			id: 'r3-current-review',
			taskId: task.id,
			batchId: batch.id,
			contractHash: task.contract_hash,
			generationId,
			kind: 'review',
		});
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: start.json().execution.version },
		});
		expect(pause.statusCode, pause.body).toBe(200);
		expect((await container.services.dispatch.tick()).runsDispatched).toHaveLength(0);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: pause.json().execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		expect(resume.json().execution.wrapupProgress.generationId).toBe(generationId);
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).toContain('r3-current-review');
		await server.instance.close();
	});

	it('R3: queued review inherits durable generation from its implementation parent', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId, docsPath } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const oldGeneration = start.json().execution.wrapupProgress.generationId as number;
		seedImplementationRun(env, {
			id: 'r3-parent-impl',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			generationId: oldGeneration,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		seedQueuedStageRun(env, {
			id: 'r3-parented-review',
			taskId: task.id,
			batchId: batch.id,
			contractHash: task.contract_hash,
			generationId: oldGeneration,
			kind: 'review',
			attemptNo: 2,
			parentRunId: 'r3-parent-impl',
			omitOwnGeneration: true,
		});
		writeTasksDocsData(docsPath, [{ id: 'M1-T1', hash: 'contract-2' }]);
		const refresh = await server.instance.inject({
			method: 'POST',
			url: `/api/v1/documents/${docId}/refresh`,
			headers,
			payload: {},
		});
		expect(refresh.statusCode, refresh.body).toBe(200);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).not.toContain('r3-parented-review');
		expect(container.repos.runs.findById('r3-parented-review')?.state).toBe('failed');
		expect(container.repos.runs.findById('r3-parent-impl')?.state).toBe('landed');
		await server.instance.close();
	});

	it('R3: queued wrapup-fix follows its current wrapup generation over an older copied snapshot', async () => {
		const env = await setup({ canDispatch: () => true, withImplementationProcess: true });
		const { server, container, headers, docId } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const generationId = start.json().execution.wrapupProgress.generationId as number;
		seedWrapupRun(env, {
			id: 'r3-current-wrapup',
			batchId: batch.id,
			attemptNo: 1,
			state: 'landed',
			createdAt: '2026-10-12T07:00:00.000Z',
			inputText: JSON.stringify({ generationId }),
		});
		seedQueuedStageRun(env, {
			id: 'r3-current-fix',
			taskId: task.id,
			batchId: batch.id,
			contractHash: task.contract_hash,
			generationId: generationId - 1,
			kind: 'implement',
			origin: 'wrapup-fix',
			spawnedByRunId: 'r3-current-wrapup',
		});
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: start.json().execution.version },
		});
		expect(pause.statusCode, pause.body).toBe(200);
		const resume = await server.instance.inject({
			method: 'POST',
			url: `${url}/resume`,
			headers,
			payload: {
				expectedVersion: pause.json().execution.version,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
			},
		});
		expect(resume.statusCode, resume.body).toBe(200);
		const tick = await container.services.dispatch.tick();
		expect(tick.runsDispatched).toContain('r3-current-fix');
		await server.instance.close();
	});

	it('R4: a legacy tick observed without a plan cannot admit after start and pause', async () => {
		const { server, container, headers, docId, pauseNextGitRun, getSpawnedRuns } = await setup({
			canDispatch: () => true,
			withImplementationProcess: true,
		});
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!batch) return;
		expect(container.repos.documentExecutions.findByDocId(docId)).toBeNull();
		await container.services.batch?.transitionBatch(batch.id, 'running', 'legacy_start');
		const gate = pauseNextGitRun();
		const legacyTick = container.services.dispatch.tick();
		await gate.entered;
		const url = `/api/v1/documents/${docId}/execution`;
		const start = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(start.statusCode, start.body).toBe(200);
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: { expectedVersion: start.json().execution.version },
		});
		expect(pause.statusCode, pause.body).toBe(200);
		gate.release();
		const result = await legacyTick;
		expect(result.runsDispatched).toHaveLength(0);
		expect(container.repos.runs.listAll()).toHaveLength(0);
		expect(getSpawnedRuns()).toHaveLength(0);
		expect(container.services.documentExecution.get(docId).execution.state).toBe('paused');
		await server.instance.close();
	});

	it('E-361: a lost manual-wrapup response remains discoverable after document pause', async () => {
		const env = await setup({ canDispatch: () => true, withWrapupWorkspace: true });
		const { server, container, headers, docId } = env;
		const task = container.repos.tasks.listByDocId(docId)[0];
		const batch = container.repos.batches.listByDocId(docId)[0];
		if (!task || !batch) return;
		seedImplementationRun(env, {
			id: 'manual-wrapup-task',
			taskId: task.id,
			batchId: batch.id,
			attemptNo: 1,
			contractHash: task.contract_hash,
			createdAt: '2026-10-12T07:00:00.000Z',
		});
		const url = `/api/v1/documents/${docId}/execution`;
		const started = await server.instance.inject({
			method: 'POST',
			url: `${url}/start`,
			headers,
			payload: {
				expectedVersion: 0,
				expectedFingerprint: container.repos.documents.findById(docId)?.content_fingerprint,
				defaultAssignment: { agentId: 'codex', modelName: null, effort: null },
			},
		});
		expect(started.statusCode, started.body).toBe(200);
		const first = await container.services.wrapup?.triggerWrapup({
			batchId: batch.id,
			trigger: 'manual',
			idempotencyKey: 'wrapup-lost-response',
		});
		const pause = await server.instance.inject({
			method: 'POST',
			url: `${url}/pause`,
			headers,
			payload: {
				expectedVersion: container.services.documentExecution.get(docId).execution.version,
			},
		});
		expect(pause.statusCode, pause.body).toBe(200);
		await expect(
			container.services.wrapup?.triggerWrapup({
				batchId: batch.id,
				trigger: 'manual',
				idempotencyKey: 'wrapup-lost-response',
			}),
		).rejects.toMatchObject({
			code: 'E_RUN_ALREADY_EXISTS',
			details: { run: { id: first?.run.id } },
		});
		expect(container.repos.runs.listWrapupsByBatchId?.(batch.id)).toHaveLength(1);
		await server.instance.close();
	});
});
