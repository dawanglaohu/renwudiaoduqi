import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
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

async function setup() {
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
			getAvailability: () => ({ canDispatch: false, isReady: false, status: 'not_found' }),
			getModelEffortOptions: () => undefined,
			listAgentModels: async () => ({ currentConfig: { model: null, effort: null }, models: [] }),
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
	return { folder, database, container, server, headers, docsPath, docId };
}

describe('M8-T12 document execution through the real container', () => {
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
