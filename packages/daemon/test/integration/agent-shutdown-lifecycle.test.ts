import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { AppContainer } from '../../src/boot/container.ts';
import { BUILT_IN_AGENT_DEFAULTS } from '../../src/config/defaults.ts';
import { type AgentRegistryFileSystem, createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { startDaemon } from '../../src/main.ts';
import type { NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { createAgentService } from '../../src/service/agents.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function controlledRegistryFiles() {
	const readStarted = deferred<void>();
	const readResult = deferred<string>();
	let blockRead = false;
	let closed = false;
	const fileSystem: AgentRegistryFileSystem = {
		async readUtf8File() {
			if (!blockRead) return '{"schemaVersion":1,"defaults":{},"overrides":{}}';
			readStarted.resolve();
			return readResult.promise;
		},
		async writeUtf8File() {},
		watchDirectory() {
			const watcher = {
				close: () => {
					closed = true;
				},
				on: () => watcher,
			};
			return watcher;
		},
	};
	return {
		fileSystem,
		readStarted,
		readResult,
		block: () => {
			blockRead = true;
		},
		isClosed: () => closed,
	};
}

it('waits for a registry read already in flight before service stop resolves', async () => {
	const files = controlledRegistryFiles();
	files.block();
	const registry = createAgentRegistry({
		dataDir: '/synthetic-agents',
		platform: 'posix',
		builtInDefaults: {},
		fileSystem: files.fileSystem,
		publishWarning: () => {},
	});
	const service = createAgentService({
		registry,
		hostInputs: { platform: 'linux', homedir: '/synthetic-home' },
	});
	const starting = service.start();
	await files.readStarted.promise;
	let stopped = false;
	const stopping = Promise.resolve(service.stop()).then(() => {
		stopped = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const stoppedBeforeRead = stopped;
	files.readResult.resolve('{}');
	await starting;
	await stopping;
	expect(files.isClosed()).toBe(true);
	expect(stoppedBeforeRead).toBe(false);
	expect(service.stop()).toBe(service.stop());
	await expect(service.start()).rejects.toMatchObject({ code: 'E_INTERNAL' });
	await expect(service.probeAll()).rejects.toMatchObject({ code: 'E_INTERNAL' });
	await expect(registry.reload()).rejects.toMatchObject({ code: 'E_INTERNAL' });
});

it('drains an active availability probe before service stop completes', async () => {
	const probeStarted = deferred<void>();
	const probeResult = deferred<void>();
	const files = controlledRegistryFiles();
	const registry = createAgentRegistry({
		dataDir: '/synthetic-agents',
		platform: 'posix',
		fileSystem: files.fileSystem,
		publishWarning: () => {},
		builtInDefaults: {
			test: {
				...BUILT_IN_AGENT_DEFAULTS.codex,
				execPath: '/synthetic/test',
				versionFingerprint: { args: ['--version'], expectedPattern: 'test' },
			},
		},
	});
	let nextId = 0;
	const bus = createEventBus({ ringBuffer: createRingBuffer() });
	const factory = createEnvelopeFactory({
		clock: { now: () => '2026-10-03T00:00:00Z' },
		idAllocator: { allocate: () => ++nextId },
	});
	const events: number[] = [];
	bus.subscribe((event) => {
		events.push(event.id);
	});
	const stat = { isFile: () => true, isSymbolicLink: () => false, mtimeMs: 1, size: 1 };
	const service = createAgentService({
		registry,
		bus,
		envelopeFactory: factory,
		hostInputs: { platform: 'linux', homedir: '/synthetic-home' },
		fileSystem: {
			stat: async () => stat,
			lstat: async () => stat,
			realpath: async (path) => path,
			access: async () => {},
			readlink: async (path) => path,
		},
		commandRunner: async () => {
			probeStarted.resolve();
			await probeResult.promise;
			return { ok: true, exitCode: 0, stdout: 'test 1.0.0', stderr: '' };
		},
	});
	const starting = service.start();
	await probeStarted.promise;
	let stopped = false;
	const stopping = Promise.resolve(service.stop()).then(() => {
		stopped = true;
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const stoppedBeforeProbe = stopped;
	probeResult.resolve();
	await starting;
	await stopping;
	expect(events.length).toBeGreaterThan(0);
	expect(stoppedBeforeProbe).toBe(false);
});

it.each(['reload probe', 'background login'] as const)(
	'drains a %s started after initialization',
	async (phase) => {
		const pendingStarted = deferred<void>();
		const release = deferred<void>();
		const files = controlledRegistryFiles();
		const registry = createAgentRegistry({
			dataDir: '/synthetic-agents',
			platform: 'posix',
			fileSystem: files.fileSystem,
			publishWarning: () => {},
			builtInDefaults: {
				test: {
					...BUILT_IN_AGENT_DEFAULTS.codex,
					execPath: '/synthetic/test',
					versionFingerprint: { args: ['--version'], expectedPattern: 'test' },
				},
			},
		});
		const stat = { isFile: () => true, isSymbolicLink: () => false, mtimeMs: 1, size: 1 };
		let initializing = true;
		let probesCompleted = 0;
		const service = createAgentService({
			registry,
			hostInputs: { platform: 'linux', homedir: '/synthetic-home' },
			fileSystem: {
				stat: async () => stat,
				lstat: async () => stat,
				realpath: async (path) => path,
				access: async () => {},
				readlink: async (path) => path,
			},
			commandRunner: async ({ args }) => {
				if (!initializing && (phase === 'reload probe' || args[0] === 'login')) {
					pendingStarted.resolve();
					await release.promise;
					probesCompleted++;
				}
				return {
					ok: true,
					exitCode: 0,
					stdout:
						!initializing && phase === 'background login' && args[0] === '--version'
							? 'unrecognized binary'
							: 'test 1.0.0',
					stderr: '',
				};
			},
		});
		const starting = service.start();
		expect(service.start()).toBe(starting);
		await starting;
		expect(service.getAvailability('test')?.isAvailable).toBe(true);
		initializing = false;
		if (phase === 'reload probe') {
			files.block();
			files.readResult.resolve(
				'{"schemaVersion":1,"defaults":{},"overrides":{"test":{"execPath":"/synthetic/reloaded"}}}',
			);
			await registry.reload();
		} else {
			await service.probeAll({ force: true });
		}
		await pendingStarted.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const completedEarly = stopped;
		release.resolve();
		await stopping;
		expect(completedEarly).toBe(false);
		expect(probesCompleted).toBe(1);
		await expect(service.listAgents()).rejects.toMatchObject({ code: 'E_INTERNAL' });
	},
);

it.each(['shutdown', 'listen failure'] as const)(
	'drains registry work before SQLite closes during real main %s',
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), 'agsched-agent-stop-'));
		const db = openDatabase(':memory:');
		const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
		for (const file of readdirSync(migrations)
			.filter((name) => name.endsWith('.sql'))
			.sort())
			db.exec(readFileSync(join(migrations, file), 'utf8'));
		const files = controlledRegistryFiles();
		let container!: AppContainer;
		const registry = createAgentRegistry({
			dataDir: directory,
			platform: process.platform === 'win32' ? 'win32' : 'posix',
			builtInDefaults: {},
			fileSystem: files.fileSystem,
			publishWarning: (warning) => {
				const envelope = container.events.envelopeFactory.createEnvelope({
					kind: 'agent.availability_changed',
					payload: { agentId: 'system', available: false, reason: warning.message },
				});
				container.events.bus.publish(envelope);
			},
		});
		const httpClosed = deferred<void>();
		let pendingReload: Promise<unknown> | undefined;
		let lockContents: string | undefined;
		const missing = {
			ok: false,
			failure: { kind: 'not-found', error: new AppError('E_INTERNAL', 'missing') },
		} as const;
		const lockAdapter = {
			platform: 'linux',
			filePath: '/synthetic/daemon.lock',
			dirPath: '/synthetic',
			reclaimPath: '/synthetic/reclaim',
			permissionLines: [],
			createExclusive: (contents: string) => {
				lockContents = contents;
				return { ok: true };
			},
			read: () => (lockContents === undefined ? missing : { ok: true, contents: lockContents }),
			remove: () => {
				lockContents = undefined;
				return { ok: true };
			},
			verifyPermissions: () => ({ ok: true }),
			createReclaimGuard: () => ({ ok: true }),
			readReclaimGuard: () => missing,
			removeReclaimGuard: () => ({ ok: true }),
			inspectPermissions: () => ({ ok: true, contents: '' }),
		} as NativeLockAdapter;
		let runtime: Awaited<ReturnType<typeof startDaemon>> | undefined;
		cleanups.push(async () => {
			files.readResult.resolve('{}');
			await pendingReload;
			await runtime?.stop();
			await container?.services.agents.stop();
			if (db.open) db.close();
			rmSync(directory, { recursive: true, force: true });
		});
		const starting = startDaemon({
			agentRegistry: registry,
			pid: 1111,
			uid: '1000',
			now: () => '2026-10-03T00:00:00Z',
			writeRunLog: () => {},
			hostInputs: {
				platform: process.platform === 'win32' ? 'win32' : 'linux',
				homedir: directory,
			},
			environment: {
				product: {
					port: '7817',
					bind: '127.0.0.1',
					dataDir: directory,
					logLevel: 'error',
					dev: '0',
				},
				host: {
					appData: undefined,
					xdgDataHome: undefined,
					programData: undefined,
					systemRoot: undefined,
				},
			},
			defaultDataDir: directory,
			lockAdapter,
			processProbe: { check: () => 'dead' },
			healthProbe: { probe: async () => ({ kind: 'failure', reason: 'connect-failed' }) },
			ensureDataDirectory: (path) => ({ ok: true, path }),
			openDatabase: () => db,
			runMigrations: () => {},
			createServer: (input) => {
				container = input.container;
				const server = createHttpServer(input);
				return {
					...server,
					close: async () => {
						await server.close();
						httpClosed.resolve();
					},
					listen: async () => {
						await container.services.agents.start();
						if (mode === 'listen failure') {
							files.block();
							pendingReload = registry.reload().catch((error: unknown) => error);
							await files.readStarted.promise;
							throw new Error('controlled listen failure');
						}
						await server.instance.ready();
						return 'http://127.0.0.1:7817';
					},
				};
			},
		});
		let completed = false;
		let finishing: Promise<unknown>;
		if (mode === 'shutdown') {
			runtime = await starting;
			files.block();
			pendingReload = registry.reload().catch((error: unknown) => error);
			await files.readStarted.promise;
			finishing = runtime.stop().then(() => {
				completed = true;
			});
		} else {
			finishing = starting.catch((error: unknown) => {
				completed = true;
				return error;
			});
			await files.readStarted.promise;
		}
		await httpClosed.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const completedBeforeRead = completed;
		const openBeforeRead = db.open;
		files.readResult.resolve('{invalid-json');
		const reloadResult = await pendingReload;
		await finishing;
		expect(openBeforeRead).toBe(true);
		expect(completedBeforeRead).toBe(false);
		expect(reloadResult).toMatchObject({ status: 'rejected' });
		expect(files.isClosed()).toBe(true);
		expect(db.open).toBe(false);
		expect(lockContents).toBeUndefined();
	},
);
