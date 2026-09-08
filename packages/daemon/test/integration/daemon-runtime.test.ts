import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HealthProbe, ProcessLivenessProbe } from '../../src/boot/lock.ts';
import type { EnvironmentSnapshot } from '../../src/config/env.ts';
import type { DatabaseConnection } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { type DaemonStartDependencies, startDaemon } from '../../src/main.ts';
import type { SupportedPlatform } from '../../src/platform/contract.ts';
import type {
	NativeLockAdapter,
	NativeLockFailure,
	NativeLockReadResult,
	NativeLockWriteResult,
} from '../../src/platform/lock-contract.ts';
import { WINDOWS_SYSTEM_ROOT_FALLBACK, createNativeLockAdapter } from '../../src/platform/lock.ts';
import { runLockCommand } from '../../src/proc/lock-command.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		removeTemporaryDirectory(directory);
	}
});

describe('minimal daemon runtime', () => {
	it('starts in order, serves health, and rejects a second user even with another port', async () => {
		const lockAdapter = createMemoryLockAdapter();
		const firstPort = await availablePort();
		const secondPort = await availablePort();
		const firstEvents: string[] = [];
		const first = await startDaemon(
			dependencies({ lockAdapter, port: firstPort, uid: '1000', events: firstEvents }),
		);

		const healthResponse = await first.server.instance.inject({
			method: 'GET',
			url: '/api/v1/health',
		});
		expect(healthResponse.json()).toEqual({ ok: true });
		expect(firstEvents).toEqual([
			'lock.create',
			'lock.permissions',
			'data-dir',
			'database.open',
			'migrations.run',
			'http.create',
			'http.listen',
			'ready',
		]);

		const secondEvents: string[] = [];
		await expect(
			startDaemon(
				dependencies({
					lockAdapter,
					port: secondPort,
					uid: '2000',
					pid: 2222,
					events: secondEvents,
					processProbe: { check: () => 'alive' },
					healthProbe: {
						probe: async () => {
							const response = await first.server.instance.inject({
								method: 'GET',
								url: '/api/v1/health',
							});
							return {
								kind: 'success',
								status: response.statusCode,
								bodyOk: response.json<{ ok: boolean }>().ok,
							};
						},
					},
				}),
			),
		).rejects.toMatchObject({ code: 'E_INTERNAL' });
		expect(secondEvents).toContain(`Existing instance pid=1111 port=${firstPort}`);
		expect(lockAdapter.read()).toMatchObject({ ok: true });

		await first.stop();
		expect(lockAdapter.read()).toMatchObject({ ok: false });
	});

	it('reclaims only a lock whose process and health endpoint are both dead', async () => {
		const lockAdapter = createMemoryLockAdapter(
			'{"pid":99999,"uid":"1000","startedAt":"2026-09-07T00:00:00.000Z","port":9,"bind":"127.0.0.1"}\n',
		);
		const runtime = await startDaemon(
			dependencies({
				lockAdapter,
				port: await availablePort(),
				uid: '2000',
				processProbe: { check: () => 'dead' },
				healthProbe: { probe: async () => ({ kind: 'failure', reason: 'connect-failed' }) },
			}),
		);

		expect(runtime.lock.metadata.pid).toBe(1111);
		expect(lockAdapter.readReclaimGuard()).toMatchObject({ ok: false });
		await runtime.stop();
	});

	it('recovers an abandoned reclaim guard before competing for the stale lock', async () => {
		const stale =
			'{"pid":99999,"uid":"1000","startedAt":"2026-09-07T00:00:00.000Z","port":9,"bind":"127.0.0.1"}\n';
		const lockAdapter = createMemoryLockAdapter(stale, stale);
		const runtime = await startDaemon(
			dependencies({
				lockAdapter,
				port: await availablePort(),
				processProbe: { check: (pid) => (pid === 99999 ? 'dead' : 'alive') },
				healthProbe: { probe: async () => ({ kind: 'failure', reason: 'connect-failed' }) },
			}),
		);

		expect(runtime.lock.metadata.pid).toBe(1111);
		expect(lockAdapter.readReclaimGuard()).toMatchObject({ ok: false });
		await runtime.stop();
	});

	it('allows only one contender to reclaim the same stale lock', async () => {
		const stale =
			'{"pid":99999,"uid":"1000","startedAt":"2026-09-07T00:00:00.000Z","port":9,"bind":"127.0.0.1"}\n';
		const lockAdapter = createMemoryLockAdapter(stale);
		const processProbe: ProcessLivenessProbe = {
			check: (pid) => (pid === 99999 ? 'dead' : 'alive'),
		};
		const healthProbe: HealthProbe = {
			probe: async () => ({ kind: 'failure', reason: 'connect-failed' }),
		};
		const outcomes = await Promise.allSettled([
			startDaemon(
				dependencies({
					lockAdapter,
					port: await availablePort(),
					pid: 1111,
					processProbe,
					healthProbe,
				}),
			),
			startDaemon(
				dependencies({
					lockAdapter,
					port: await availablePort(),
					pid: 2222,
					processProbe,
					healthProbe,
				}),
			),
		]);
		const running = outcomes.filter(
			(outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof startDaemon>>> =>
				outcome.status === 'fulfilled',
		);
		expect(running).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
		await running[0]?.value.stop();
	});

	it('keeps the lock when either liveness result is uncertain', async () => {
		const contents =
			'{"pid":99999,"uid":"1000","startedAt":"2026-09-07T00:00:00.000Z","port":9,"bind":"127.0.0.1"}\n';
		const lockAdapter = createMemoryLockAdapter(contents);
		const events: string[] = [];

		await expect(
			startDaemon(
				dependencies({
					lockAdapter,
					port: await availablePort(),
					events,
					processProbe: { check: () => 'dead' },
					healthProbe: { probe: async () => ({ kind: 'failure', reason: 'timeout' }) },
				}),
			),
		).rejects.toMatchObject({ code: 'E_INTERNAL' });
		expect(lockAdapter.read()).toEqual({ ok: true, contents });
		expect(events.some((line) => line.includes('process=dead health=uncertain'))).toBe(true);
	});

	it('releases the instance lock when Fastify cannot listen on the configured port', async () => {
		const occupied = createNetServer();
		await new Promise<void>((resolvePromise) => occupied.listen(0, '127.0.0.1', resolvePromise));
		const address = occupied.address();
		if (address === null || typeof address === 'string') expect.fail('test server has no port');
		const lockAdapter = createMemoryLockAdapter();
		try {
			await expect(
				startDaemon(dependencies({ lockAdapter, port: address.port })),
			).rejects.toMatchObject({
				code: 'E_INTERNAL',
				cause: { code: 'EADDRINUSE' },
			});
			expect(lockAdapter.read()).toMatchObject({ ok: false });
		} finally {
			await new Promise<void>((resolvePromise, rejectPromise) =>
				occupied.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error))),
			);
		}
	});

	it('enforces native POSIX owner and mode, or reports the required privilege', () => {
		if (process.platform === 'win32') return;
		const directory = makeTemporaryDirectory();
		const adapter = createNativeLockAdapter({
			platform: process.platform === 'darwin' ? 'darwin' : 'linux',
			host: {},
			filePath: join(directory, 'daemon.lock'),
		});
		const result = adapter.createExclusive('{}\n');
		if (typeof process.getuid === 'function' && process.getuid() !== 0) {
			expect(result).toMatchObject({ ok: false, failure: { kind: 'permission-denied' } });
			return;
		}
		expect(result).toEqual({ ok: true });
		const stats = statSync(adapter.filePath);
		expect(stats.uid).toBe(0);
		expect(stats.gid).toBe(process.platform === 'darwin' ? 80 : 0);
		expect(stats.mode & 0o777).toBe(0o600);
	});

	it('enforces the native Windows Administrators/SYSTEM-only ACL when run on Windows', () => {
		if (process.platform !== 'win32') return;
		const directory = makeTemporaryDirectory();
		const adapter = createNativeLockAdapter({
			platform: 'win32',
			host: {},
			filePath: join(directory, 'agent-scheduler', 'daemon.lock'),
			runWindowsCommand: runLockCommand,
		});
		const result = adapter.createExclusive('{}\n');
		if (!result.ok) {
			expect(result.failure.kind).toBe('permission-denied');
			return;
		}
		expect(adapter.verifyPermissions()).toEqual({ ok: true });
	});
});

function dependencies(input: {
	readonly lockAdapter: NativeLockAdapter;
	readonly port: number;
	readonly pid?: number;
	readonly uid?: string;
	readonly events?: string[];
	readonly processProbe?: ProcessLivenessProbe;
	readonly healthProbe?: HealthProbe;
}): DaemonStartDependencies {
	const directory = makeTemporaryDirectory();
	const events = input.events ?? [];
	const environment: EnvironmentSnapshot = Object.freeze({
		product: Object.freeze({
			port: String(input.port),
			bind: '127.0.0.1',
			dataDir: directory,
			logLevel: 'info',
			dev: '0',
		}),
		host: Object.freeze({
			appData: undefined,
			xdgDataHome: undefined,
			programData: undefined,
			systemRoot: undefined,
		}),
	});
	return {
		pid: input.pid ?? 1111,
		uid: input.uid ?? '1000',
		now: () => '2026-09-07T01:02:03.004Z',
		writeRunLog: (line) => events.push(line.startsWith('daemon ready') ? 'ready' : line),
		hostInputs: Object.freeze({ platform: hostPlatform(), homedir: directory }),
		environment,
		defaultDataDir: directory,
		lockAdapter: instrumentLock(input.lockAdapter, events),
		processProbe: input.processProbe ?? { check: () => 'alive' },
		healthProbe: input.healthProbe ?? {
			probe: async ({ host, port, path, timeoutMs }) => {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), timeoutMs);
				try {
					const response = await fetch(`http://${host}:${port}${path}`, {
						signal: controller.signal,
					});
					const body = (await response.json()) as { ok?: boolean };
					return { kind: 'success' as const, status: response.status, bodyOk: body.ok === true };
				} catch (error) {
					return {
						kind: 'failure' as const,
						reason:
							error instanceof Error && error.name === 'AbortError'
								? ('timeout' as const)
								: ('connect-failed' as const),
					};
				} finally {
					clearTimeout(timeout);
				}
			},
		},
		ensureDataDirectory: (path) => {
			events.push('data-dir');
			return { ok: true, path };
		},
		openDatabase: () => {
			events.push('database.open');
			return { close: () => undefined } as unknown as DatabaseConnection;
		},
		runMigrations: () => events.push('migrations.run'),
		createServer: ({ container }) => {
			events.push('http.create');
			const server = createHttpServer({ container });
			return {
				...server,
				listen: (options) => {
					events.push('http.listen');
					return server.listen(options);
				},
			};
		},
	};
}

function instrumentLock(adapter: NativeLockAdapter, events: string[]): NativeLockAdapter {
	return Object.freeze({
		...adapter,
		createExclusive(contents: string): NativeLockWriteResult {
			events.push('lock.create');
			return adapter.createExclusive(contents);
		},
		verifyPermissions() {
			events.push('lock.permissions');
			return adapter.verifyPermissions();
		},
	});
}

function createMemoryLockAdapter(
	initialContents?: string,
	initialReclaimContents?: string,
): NativeLockAdapter {
	let lockContents = initialContents;
	let reclaimContents = initialReclaimContents;
	const missing = (): NativeLockFailure => ({
		kind: 'not-found',
		error: new AppError('E_INTERNAL', 'Memory lock is missing.'),
	});
	const create = (current: string | undefined, contents: string): NativeLockWriteResult =>
		current === undefined
			? { ok: true }
			: {
					ok: false,
					failure: {
						kind: 'already-exists',
						error: new AppError('E_INTERNAL', 'Memory lock already exists.'),
					},
				};
	return Object.freeze({
		platform: 'linux',
		filePath: '/machine/daemon.lock',
		dirPath: '/machine',
		reclaimPath: '/machine/daemon.lock.reclaim',
		permissionLines: ['root:root 0600'],
		createExclusive(contents: string): NativeLockWriteResult {
			const result = create(lockContents, contents);
			if (result.ok) lockContents = contents;
			return result;
		},
		read(): NativeLockReadResult {
			return lockContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: lockContents };
		},
		remove(): NativeLockWriteResult {
			lockContents = undefined;
			return { ok: true };
		},
		verifyPermissions: (): NativeLockWriteResult => ({ ok: true }),
		createReclaimGuard(contents: string): NativeLockWriteResult {
			const result = create(reclaimContents, contents);
			if (result.ok) reclaimContents = contents;
			return result;
		},
		readReclaimGuard(): NativeLockReadResult {
			return reclaimContents === undefined
				? { ok: false, failure: missing() }
				: { ok: true, contents: reclaimContents };
		},
		removeReclaimGuard(): NativeLockWriteResult {
			reclaimContents = undefined;
			return { ok: true };
		},
		inspectPermissions: (): NativeLockReadResult => ({
			ok: true,
			contents: 'root:root mode=600',
		}),
	});
}

async function availablePort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
	const address = server.address();
	if (address === null || typeof address === 'string') expect.fail('test server has no port');
	await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
	return address.port;
}

function makeTemporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'agent-scheduler-m1-t10-'));
	temporaryDirectories.push(directory);
	return directory;
}

function hostPlatform(): SupportedPlatform {
	return process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
}

function removeTemporaryDirectory(directory: string): void {
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch (error) {
		if (process.platform !== 'win32') throw error;
		const icaclsPath = win32.join(
			process.env.SystemRoot ?? WINDOWS_SYSTEM_ROOT_FALLBACK,
			'System32',
			'icacls.exe',
		);
		runLockCommand({
			file: icaclsPath,
			args: [directory, '/T', '/C', '/grant', 'Users:(OI)(CI)F'],
		});
		rmSync(directory, { recursive: true, force: true });
	}
}
