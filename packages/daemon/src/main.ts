import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ContainerJob, createContainer } from './boot/container.ts';
import { registerRuntimeGuards } from './boot/guards.ts';
import {
	type HealthProbe,
	type ProcessLivenessProbe,
	acquireInstanceLock,
	acquireLockOutcomeToBootLines,
	createHttpHealthProbe,
	createSystemProcessLivenessProbe,
} from './boot/lock.ts';
import { ensureDataDir } from './boot/paths.ts';
import { createShutdownHandler, shutdown } from './boot/shutdown.ts';
import { takeBootSnapshot } from './boot/snapshot.ts';
import { type ConfigFileReader, type ProcessConfig, loadProcessConfig } from './config/env.ts';
import { createMigrationRunner } from './db/migrate.ts';
import { type DatabaseConnection, openDatabase } from './db/open-database.ts';
import { AppError } from './errors/app-error.ts';
import { type HttpServer, createHttpServer } from './http/server.ts';
import { appDataDir } from './platform/host.ts';
import type { LockFileHandle, LockMetadata, NativeLockAdapter } from './platform/lock-contract.ts';
import { createNativeLockAdapter } from './platform/lock.ts';
import { runLockCommand } from './proc/lock-command.ts';

const DAEMON_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIRECTORY = join(DAEMON_DIRECTORY, 'migrations');
const DATABASE_FILE_NAME = 'app.db';
const CONFIG_FILE_NAME = 'daemon.json';

export interface DaemonRuntime {
	readonly config: ProcessConfig;
	readonly lock: LockFileHandle;
	readonly server: HttpServer;
	stop(): Promise<void>;
}

export interface DaemonStartDependencies {
	readonly pid: number;
	readonly uid: string;
	readonly now: () => string;
	readonly writeRunLog: (line: string) => void;
	readonly hostInputs: ReturnType<typeof takeBootSnapshot>['hostInputs'];
	readonly environment: ReturnType<typeof takeBootSnapshot>['environment'];
	readonly defaultDataDir: string;
	readonly configFileReader?: ConfigFileReader;
	readonly lockAdapter: NativeLockAdapter;
	readonly processProbe: ProcessLivenessProbe;
	readonly healthProbe: HealthProbe;
	readonly ensureDataDirectory: typeof ensureDataDir;
	readonly openDatabase: (path: string) => DatabaseConnection;
	readonly runMigrations: (database: DatabaseConnection) => void;
	readonly createServer: typeof createHttpServer;
}

export async function startDaemon(dependencies: DaemonStartDependencies): Promise<DaemonRuntime> {
	const configResult = loadProcessConfig({
		environment: dependencies.environment,
		platform: dependencies.hostInputs.platform,
		defaultDataDir: dependencies.defaultDataDir,
		configFilePath: join(dependencies.defaultDataDir, CONFIG_FILE_NAME),
		fileReader: dependencies.configFileReader,
	});
	if (!configResult.ok) {
		throw new AppError(
			'E_VALIDATION',
			`${configResult.variable} has invalid format: "${configResult.actual}". Expected ${configResult.expected}.`,
			{ details: { variable: configResult.variable, expected: configResult.expected } },
		);
	}
	const config = configResult.config;
	const metadata: LockMetadata = Object.freeze({
		pid: dependencies.pid,
		uid: dependencies.uid,
		startedAt: dependencies.now(),
		port: config.port,
		bind: config.bind,
	});
	const lockOutcome = await acquireInstanceLock(metadata, {
		adapter: dependencies.lockAdapter,
		processProbe: dependencies.processProbe,
		healthProbe: dependencies.healthProbe,
	});
	if (!lockOutcome.ok) {
		for (const line of acquireLockOutcomeToBootLines(lockOutcome)) dependencies.writeRunLog(line);
		throw new AppError('E_INTERNAL', 'The daemon instance lock could not be acquired.');
	}
	const lock = lockOutcome.lock;
	let database: DatabaseConnection | undefined;
	let server: HttpServer | undefined;
	try {
		const dataDirectory = dependencies.ensureDataDirectory(config.dataDir);
		if (!dataDirectory.ok) {
			throw new AppError('E_DATA_DIR_UNRESOLVABLE', dataDirectory.message, {
				cause: dataDirectory.cause,
				details: { path: dataDirectory.path },
			});
		}
		database = dependencies.openDatabase(join(config.dataDir, DATABASE_FILE_NAME));
		dependencies.runMigrations(database);
		const container = createContainer({
			config,
			database,
			hostInputs: dependencies.hostInputs,
			lockAdapter: dependencies.lockAdapter,
			instanceLock: lock,
			clock: Object.freeze({ now: dependencies.now }),
		});
		server = dependencies.createServer({ container });
		await server.listen({ host: config.bind, port: config.port });
		for (const job of container.jobs) {
			job.start();
		}
		dependencies.writeRunLog(
			`daemon ready pid=${dependencies.pid} bind=${config.bind} port=${config.port}`,
		);
		return createDaemonRuntime(
			config,
			lock,
			server,
			database,
			dependencies.lockAdapter,
			container.jobs,
			dependencies.writeRunLog,
		);
	} catch (error) {
		await cleanupStartupFailure(
			server,
			database,
			lock,
			dependencies.lockAdapter,
			dependencies.writeRunLog,
		);
		throw error;
	}
}

export async function main(): Promise<never> {
	const snapshot = takeBootSnapshot();
	registerRuntimeGuards({
		pid: snapshot.pid,
		writeRunLog: snapshot.writeRunLog,
		fatalExit: () => process.exit(1),
	});
	const runtime = await startDaemon(createNativeDependencies(snapshot));
	await waitForShutdown(runtime);
	process.exit(0);
}

function createNativeDependencies(
	snapshot: ReturnType<typeof takeBootSnapshot>,
): DaemonStartDependencies {
	const defaultDataDirResult = appDataDir(snapshot.hostInputs);
	if (!defaultDataDirResult.ok) {
		throw new AppError(defaultDataDirResult.error.code, defaultDataDirResult.error.message, {
			details: { ...defaultDataDirResult.error.details },
		});
	}
	const lockAdapter = createNativeLockAdapter({
		platform: snapshot.hostInputs.platform,
		host: {
			programData: snapshot.environment.host.programData,
			systemRoot: snapshot.environment.host.systemRoot,
		},
		runWindowsCommand: snapshot.hostInputs.platform === 'win32' ? runLockCommand : undefined,
	});
	const now = (): string => new Date().toISOString();
	return Object.freeze({
		pid: snapshot.pid,
		uid: typeof process.getuid === 'function' ? String(process.getuid()) : '0',
		now,
		writeRunLog: snapshot.writeRunLog,
		hostInputs: snapshot.hostInputs,
		environment: snapshot.environment,
		defaultDataDir: defaultDataDirResult.path,
		lockAdapter,
		processProbe: createSystemProcessLivenessProbe(),
		healthProbe: createHttpHealthProbe(),
		ensureDataDirectory: ensureDataDir,
		openDatabase,
		runMigrations: (database: DatabaseConnection): void => {
			createMigrationRunner({
				database,
				clock: { now },
				fileSystem: {
					readDirectory: (directory) => readdirSync(directory),
					readFile: (path) => readFileSync(path, 'utf8'),
				},
			}).run(MIGRATIONS_DIRECTORY);
		},
		createServer: createHttpServer,
	});
}

function createDaemonRuntime(
	config: ProcessConfig,
	lock: LockFileHandle,
	server: HttpServer,
	database: DatabaseConnection,
	lockAdapter: NativeLockAdapter,
	jobs: readonly ContainerJob[],
	writeRunLog: (line: string) => void,
): DaemonRuntime {
	const stop = createShutdownHandler({
		jobs,
		server,
		database,
		lock,
		lockAdapter,
		writeRunLog,
	});
	return Object.freeze({
		config,
		lock,
		server,
		stop,
	});
}

async function cleanupStartupFailure(
	server: HttpServer | undefined,
	database: DatabaseConnection | undefined,
	lock: LockFileHandle,
	lockAdapter: NativeLockAdapter,
	writeRunLog: (line: string) => void,
): Promise<void> {
	await shutdown({
		server,
		database,
		lock,
		lockAdapter,
		writeRunLog,
	});
}

function waitForShutdown(runtime: DaemonRuntime): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		let stopping = false;
		const stop = (): void => {
			if (stopping) return;
			stopping = true;
			void runtime.stop().then(
				() => process.exit(0),
				(error) => reject(error),
			);
		};
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	});
}

function handleStartupFailure(error: unknown): never {
	const summary = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	process.stderr.write(`[startupFailure] ${summary}\n`);
	process.exit(1);
}

export function runMain(): void {
	void main().catch(handleStartupFailure);
}
