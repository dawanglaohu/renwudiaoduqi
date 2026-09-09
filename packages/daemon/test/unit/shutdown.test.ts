import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { type ShutdownJob, createShutdownHandler, shutdown } from '../../src/boot/shutdown.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import type { HttpServer } from '../../src/http/server.ts';
import type {
	LockFileHandle,
	NativeLockAdapter,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';

describe('boot/shutdown', () => {
	it('AC 4 & E-01: stops jobs first, then closes HTTP, then closes DB, then releases lock', async () => {
		const callOrder: string[] = [];

		const job1: ShutdownJob = {
			name: 'job-1',
			stop: vi.fn(async () => {
				callOrder.push('job1.stop');
			}),
		};

		const job2: ShutdownJob = {
			name: 'job-2',
			stop: vi.fn(async () => {
				callOrder.push('job2.stop');
			}),
		};

		const server: Partial<HttpServer> = {
			close: vi.fn(async () => {
				callOrder.push('server.close');
			}),
		};

		const database: Partial<DatabaseConnection> = {
			close: vi.fn(() => {
				callOrder.push('database.close');
				return {} as unknown as ReturnType<DatabaseConnection['close']>;
			}),
		};

		const lock: LockFileHandle = {
			path: '/tmp/test.lock',
			serializedMetadata: '{"pid":123}',
			released: false,
			release: vi.fn(),
			metadata: {
				pid: 123,
				uid: '1000',
				startedAt: '2026-09-09T00:00:00.000Z',
				port: 7817,
				bind: '127.0.0.1',
			},
		};

		const lockAdapter: Partial<NativeLockAdapter> = {
			read: vi.fn((): NativeLockReadResult => Object.freeze({ ok: true, contents: '{"pid":123}' })),
			remove: vi.fn((): NativeLockWriteResult => {
				callOrder.push('lockAdapter.remove');
				return Object.freeze({ ok: true, value: null });
			}),
		};

		await shutdown({
			jobs: [job1, job2],
			server: server as HttpServer,
			database: database as DatabaseConnection,
			lock,
			lockAdapter: lockAdapter as NativeLockAdapter,
		});

		expect(callOrder).toEqual([
			'job1.stop',
			'job2.stop',
			'server.close',
			'database.close',
			'lockAdapter.remove',
		]);
	});

	it('AC 4 & E-01: does NOT terminate running agent child processes (shutdown.ts does not import proc/ or kill-tree)', () => {
		const shutdownSource = readFileSync(
			resolve(dirname(fileURLToPath(import.meta.url)), '../../src/boot/shutdown.ts'),
			'utf8',
		);
		expect(shutdownSource).not.toMatch(/from ['"][^'"]*proc\/[^'"]*['"]/);
		expect(shutdownSource).not.toMatch(/from ['"][^'"]*kill-tree[^'"]*['"]/);
		expect(shutdownSource).not.toMatch(/killTree/);
	});

	it('continues gracefully if a job throws an error during stop', async () => {
		const logs: string[] = [];
		const jobFaulty: ShutdownJob = {
			name: 'faulty-job',
			stop: vi.fn(async () => {
				throw new Error('job exploded');
			}),
		};

		let dbClosed = false;
		const database: Partial<DatabaseConnection> = {
			close: vi.fn(() => {
				dbClosed = true;
				return {} as unknown as ReturnType<DatabaseConnection['close']>;
			}),
		};

		await shutdown({
			jobs: [jobFaulty],
			database: database as DatabaseConnection,
			writeRunLog: (msg) => logs.push(msg),
		});

		expect(dbClosed).toBe(true);
		expect(logs.some((log) => log.includes('job faulty-job failed'))).toBe(true);
	});

	it('createShutdownHandler is idempotent across concurrent and sequential calls', async () => {
		let closeCount = 0;
		const server: Partial<HttpServer> = {
			close: vi.fn(async () => {
				closeCount++;
			}),
		};

		const handler = createShutdownHandler({
			server: server as HttpServer,
		});

		// Call concurrently
		await Promise.all([handler(), handler(), handler()]);
		expect(closeCount).toBe(1);

		// Call sequentially after finished
		await handler();
		expect(closeCount).toBe(1);
	});
});
