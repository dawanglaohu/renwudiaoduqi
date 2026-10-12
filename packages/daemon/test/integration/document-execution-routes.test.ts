import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
		builtInDefaults: BUILT_IN_AGENT_DEFAULTS,
	});
	let configRead = false;
	const schedulerTickJob = {
		name: 'scheduler-tick',
		start: () => {},
		stop: async () => {},
		trigger: () => {},
	};
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir: folder, logLevel: 'error', dev: false },
		database,
		hostInputs: { platform: process.platform, homedir: folder } as never,
		lockAdapter,
		instanceLock: { release: () => undefined } as never,
		clock,
		agentRegistry: registry,
		gitRunner: { run: async () => ({ exitCode: 0, stdout: `true\n${root}\n`, stderr: '' }) },
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
	return { folder, database, container, server, headers, docsPath, docId, registry };
}

function seedWrapupRun(
	env: Awaited<ReturnType<typeof setup>>,
	input: {
		id: string;
		batchId: string;
		attemptNo: number;
		state: 'failed' | 'landed';
		inputText?: string | null;
		createdAt: string;
	},
): void {
	const snapshotId = `snapshot-${input.id}`;
	env.container.repos.dispatchSnapshots?.insert({
		id: snapshotId,
		task_id: null,
		batch_id: input.batchId,
		input_text: input.inputText ?? null,
		contract_hash: 'wrapup',
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
		ended_at: input.createdAt,
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
	},
): void {
	env.container.repos.batchWrapups?.insert({
		id: input.id,
		batch_id: input.batchId,
		batch_no: 1,
		tasks_json: '["M1-T1"]',
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
	},
): void {
	const snapshotId = `snapshot-${input.id}`;
	env.container.repos.dispatchSnapshots?.insert({
		id: snapshotId,
		task_id: input.taskId,
		contract_hash: input.contractHash,
		task_paths_json: '[]',
		launch_spec_json: '{}',
		created_at: input.createdAt,
	});
	env.container.repos.runs.insert({
		id: input.id,
		task_id: input.taskId,
		attempt_no: input.attemptNo,
		kind: 'implement',
		state: 'landed',
		agent_id: 'codex',
		permission_tier: 'workspaceWrite',
		snapshot_id: snapshotId,
		started_at: input.createdAt,
		ended_at: input.createdAt,
		is_in_head: 1,
		in_head_checked_at: input.createdAt,
	});
}

describe('M8-T12 document execution through the real container', () => {
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
});
