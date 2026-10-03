import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

async function connectStream(baseUrl: string, token: string, lastEventId?: number) {
	const abort = new AbortController();
	const response = await fetch(`${baseUrl}/api/v1/events`, {
		headers: {
			authorization: `Bearer ${token}`,
			...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
		},
		signal: abort.signal,
	});
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/event-stream');
	const reader = response.body?.getReader();
	if (!reader) throw new Error('SSE response has no body');
	const decoder = new TextDecoder();
	const events: EventEnvelope[] = [];
	let buffered = '';
	return {
		events,
		async readUntil(count: number) {
			while (events.length < count) {
				const next = await reader.read();
				if (next.done) throw new Error('SSE ended before the expected events arrived');
				buffered += decoder.decode(next.value, { stream: true });
				let boundary = buffered.indexOf('\n\n');
				while (boundary >= 0) {
					const frame = buffered.slice(0, boundary);
					buffered = buffered.slice(boundary + 2);
					const data = frame.split('\n').find((line) => line.startsWith('data: '));
					if (data) {
						const event = JSON.parse(data.slice(6)) as EventEnvelope;
						expect(frame).toContain(`id: ${event.id}\n`);
						events.push(event);
					}
					boundary = buffered.indexOf('\n\n');
				}
			}
			return events;
		},
		close: () => abort.abort(),
	};
}

it('keeps TCP SSE IDs increasing through a container rollback, delayed disk publication and replay', async () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-tcp-event-order-'));
	const db = openDatabase(':memory:');
	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
	}
	let releaseWrite = () => {};
	const blockedWrite = new Promise<void>((resolveWrite) => {
		releaseWrite = resolveWrite;
	});
	let observeWrite = () => {};
	const writeStarted = new Promise<void>((resolveStarted) => {
		observeWrite = resolveStarted;
	});
	const realFs = createNodeLogFileSystem();
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		hostInputs: { platform: 'linux', homedir: dataDir },
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => '2026-10-02T10:00:00.000Z' },
		bootstrapPairing: false,
		agentRegistry: createAgentRegistry({
			dataDir,
			builtInDefaults: {},
			platform: 'posix',
			publishWarning: (warning) => {
				throw new Error(warning.message);
			},
		}),
		logFs: {
			...realFs,
			async appendFile(path, bytes) {
				observeWrite();
				await blockedWrite;
				await realFs.appendFile(path, bytes);
			},
		},
	});
	const server = createHttpServer({ container });
	const streams: Array<Awaited<ReturnType<typeof connectStream>>> = [];
	let ingesting: Promise<unknown> | undefined;
	try {
		await container.services.agents.start();
		const baseUrl = await server.listen({ host: '127.0.0.1', port: 0 });
		const claim = await fetch(`${baseUrl}/api/v1/pair/claim`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				code: container.services.pairing.createPairingCode().code,
				deviceName: 'TCP event observer',
			}),
		});
		expect(claim.status).toBe(200);
		const { token } = (await claim.json()) as { token: string };
		const unauthorized = await fetch(`${baseUrl}/api/v1/events`);
		expect(unauthorized.status).toBe(401);
		await unauthorized.arrayBuffer();
		const stream = await connectStream(baseUrl, token);
		streams.push(stream);
		container.repos.documents.insert({
			id: 'doc',
			docs_path: '/docs/tcp.js',
			project_name: 'TCP order',
			repo_path: null,
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 1,
			content_fingerprint: 'fp',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: container.clock.now(),
			last_seen_at: container.clock.now(),
		});
		container.repos.batches.insert({ id: 'batch', doc_id: 'doc', batch_no: 1, state: 'running' });
		// Defer failure until COMMIT, after the production batch service reserves its event ID.
		db.exec(`CREATE TABLE commit_guard (batch_id TEXT REFERENCES batches(id) DEFERRABLE INITIALLY DEFERRED);
			CREATE TRIGGER reject_batch_commit AFTER UPDATE OF state ON batches BEGIN
			INSERT INTO commit_guard(batch_id) VALUES ('missing'); END;`);
		const rolledBackId = container.events.idAllocator.nextId();
		expect(() =>
			container.services.batch?.transitionBatch('batch', 'paused', 'must rollback'),
		).toThrow();
		expect(container.repos.batches.findById('batch')?.state).toBe('running');
		expect(container.events.idAllocator.nextId()).toBe(rolledBackId + 1);
		db.exec('DROP TRIGGER reject_batch_commit');

		ingesting = container.services.run.ingestEvent(
			'tcp-run',
			container.events.envelopeFactory.createEnvelope({
				runId: 'tcp-run',
				kind: 'agent_message_chunk',
				payload: { chunk: 'durable TCP message' },
			}),
		);
		await writeStarted;
		const patchGates = () =>
			fetch(`${baseUrl}/api/v1/settings/gates`, {
				method: 'PATCH',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: JSON.stringify({ dispatch: 'auto', review: 'manual', landing: 'manual' }),
			});
		const changed = await patchGates();
		expect(changed.status).toBe(200);
		await changed.arrayBuffer();
		expect(container.events.ringBuffer.size()).toBe(0);
		releaseWrite();
		await ingesting;
		await stream.readUntil(2);
		expect(stream.events.map((event) => event.kind)).toEqual([
			'agent_message_chunk',
			'settings.gates_changed',
		]);
		expect(stream.events.map((event) => event.id)).toEqual([rolledBackId + 1, rolledBackId + 2]);
		container.services.batch?.transitionBatch('batch', 'paused', 'committed');
		await stream.readUntil(3);
		expect(stream.events[2]?.kind).toBe('batch.advanced');
		const persisted = JSON.parse(
			readFileSync(join(dataDir, 'runs', 'tcp-run', 'events.ndjson'), 'utf8'),
		) as EventEnvelope;
		expect(persisted).toEqual(stream.events[0]);

		const replay = await connectStream(baseUrl, token, stream.events[0]?.id);
		streams.push(replay);
		await replay.readUntil(2);
		expect(replay.events).toEqual(stream.events.slice(1));
		const continued = await patchGates();
		expect(continued.status).toBe(200);
		await continued.arrayBuffer();
		await Promise.all([stream.readUntil(4), replay.readUntil(3)]);
		expect(stream.events.map((event) => event.id)).toEqual(
			[1, 2, 3, 4].map((offset) => rolledBackId + offset),
		);
		expect(replay.events).toEqual(stream.events.slice(1));
	} finally {
		releaseWrite();
		await ingesting?.catch(() => undefined);
		for (const stream of streams) stream.close();
		await server.close();
		await container.services.agents.stop();
		container.events.dispose();
		db.close();
		expect(dirname(resolve(dataDir))).toBe(resolve(tmpdir()));
		expect(basename(dataDir)).toMatch(/^agsched-tcp-event-order-/);
		rmSync(dataDir, { recursive: true, force: true });
	}
});
