import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformHostInputs } from '../platform/contract.ts';
import { appDataDir } from '../platform/host.ts';
import type { BootSnapshot } from './snapshot.ts';
import { createMigrationRunner } from '../db/migrate.ts';
import { openDatabase } from '../db/open-database.ts';
import { createHttpServer } from '../http/server.ts';
import { parseDaemonConfig } from '../config/env.ts';
import {
	acquireInstanceLock,
	createHttpHealthProbe,
	createSystemProcessLivenessProbe,
	type AcquireLockOutcome,
	type LockHandle,
} from './lock.ts';
import { ensureDataDir } from './paths.ts';
import { createNativeLockAdapter, type NativeLockAdapter } from '../platform/lock.ts';
import type { LockMetadata } from '../platform/lock-contract.ts';
import type { EnvironmentSnapshot, ProcessConfig, ProcessConfigResult } from '../config/env.ts';

export interface AppContainer {
	readonly nodeVersion: string;
	readonly pid: number;
	readonly environment: EnvironmentSnapshot;
	readonly hostInputs: PlatformHostInputs;
	readonly writeRunLog: (line: string) => void;
	readonly lockAdapter: NativeLockAdapter;
	readonly parseProcessConfig: () => ProcessConfigResult;
	readonly dataDir: () => string;
	readonly databasePath: () => string;
	readonly migrationsDir: () => string;
	readonly lockFilePath: () => string;
	readonly ensureDataDirectory: (path: string) => ReturnType<typeof ensureDataDir>;
	readonly acquireInstanceLock: (config: ProcessConfig) => Promise<AcquireLockOutcome>;
	readonly openDatabase: (path: string) => ReturnType<typeof openDatabase>;
	readonly runMigrations: (database: ReturnType<typeof openDatabase>) => void;
	readonly createHttpServer: (deps: {
		readonly database: ReturnType<typeof openDatabase>;
		readonly config: ProcessConfig;
	}) => ReturnType<typeof createHttpServer>;
	readonly releaseLock: (lock: LockHandle) => void;
	readonly lockMetadata: (config: ProcessConfig) => LockMetadata;
}

const DATABASE_FILE_NAME = 'app.db';
const MIGRATIONS_DIR_NAME = 'migrations';

export function createContainer(snapshot: BootSnapshot): AppContainer {
	const hostInputs = snapshot.hostInputs;
	const dataDirectory = resolveDefaultDataDir(hostInputs);
	const lockAdapter = createNativeLockAdapter({
		platform: hostInputs.platform,
		host: { programData: snapshot.environment.host.appDataDir },
	});
	const processProbe = createSystemProcessLivenessProbe();
	const healthProbe = createHttpHealthProbe();

	function metadataFor(config: ProcessConfig): LockMetadata {
		return {
			pid: snapshot.pid,
			uid: stableUid(),
			startedAt: new Date().toISOString(),
			port: config.port,
			bind: config.bind,
		};
	}

	const container: AppContainer = {
		nodeVersion: snapshot.nodeVersion,
		pid: snapshot.pid,
		environment: snapshot.environment,
		hostInputs,
		writeRunLog: snapshot.writeRunLog,
		lockAdapter,
		parseProcessConfig: () => parseDaemonConfig(snapshot.environment, { dataDir: dataDirectory }),
		dataDir: () => dataDirectory,
		databasePath: () => join(dataDirectory, DATABASE_FILE_NAME),
		migrationsDir: () => join(process.cwd(), 'packages', 'daemon', MIGRATIONS_DIR_NAME),
		lockFilePath: () => lockAdapter.filePath,
		ensureDataDirectory: (path: string) => ensureDataDir(path),
		acquireInstanceLock: (config: ProcessConfig) =>
			acquireInstanceLock(metadataFor(config), {
				adapter: lockAdapter,
				processProbe,
				healthProbe,
			}),
		openDatabase: (path: string) => openDatabase(path),
		runMigrations: (database: ReturnType<typeof openDatabase>) => {
			const runner = createMigrationRunner({
				clock: { now: () => new Date().toISOString() },
				database,
				fileSystem: {
					readDirectory: (directory) => readdirSync(directory),
					readFile: (path) => readFileSync(path, 'utf8'),
				},
			});
			runner.run(join(process.cwd(), 'packages', 'daemon', MIGRATIONS_DIR_NAME));
		},
		createHttpServer: ({ database, config }) => createHttpServer({ database, config }),
		releaseLock: (lock: LockHandle) => {
			const removal = lockAdapter.remove();
			if (!removal.ok) {
				// Best effort: still mark local release to avoid double-firing elsewhere.
			}
			lock.release();
		},
		lockMetadata: metadataFor,
	};

	return container;
}

function resolveDefaultDataDir(hostInputs: PlatformHostInputs): string {
	const resolved = appDataDir(hostInputs);
	if (!resolved.ok) {
		return join(hostInputs.homedir, 'agent-scheduler');
	}
	return resolved.path;
}

function stableUid(): string {
	if (typeof process.getuid === 'function') {
		return String(process.getuid());
	}
	return '0';
}
