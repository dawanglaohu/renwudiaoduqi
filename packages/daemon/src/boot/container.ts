import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProcessConfig } from '../config/env.ts';
import type { DatabaseConnection } from '../db/open-database.ts';
import { createUnitOfWork } from '../db/unit-of-work.ts';
import { type EventBus, createEventBus } from '../events/bus.ts';
import { type EnvelopeFactory, createEnvelopeFactory } from '../events/envelope.ts';
import { type IdAllocator, createIdAllocator } from '../events/id-allocator.ts';
import { type RingBuffer, createRingBuffer } from '../events/ring-buffer.ts';
import type { LogFileSystem } from '../logstore/contract.ts';
import { createNodeLogFileSystem } from '../logstore/node-log-file-system.ts';
import { type LogstorePaths, createLogstorePaths } from '../logstore/paths.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../platform/lock-contract.ts';
import { createDefaultProcessOps } from '../proc/spawn.ts';
import { type EventSeqRepo, createEventSeqRepo } from '../repo/event-seq-repo.ts';
import { type RunsAbortRepo, createSqliteRunsAbortRepo } from '../repo/runs-abort-repo.ts';
import { type RunAbortService, createRunAbortService } from '../service/run-abort.ts';
import { type SystemService, createSystemService } from '../service/system.ts';

export interface ContainerJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
}

export interface ContainerRepos {
	readonly eventSeq: EventSeqRepo;
	readonly runsAbort: RunsAbortRepo;
	readonly [key: string]: unknown;
}

export interface ContainerEvents {
	readonly idAllocator: IdAllocator;
	readonly envelopeFactory: EnvelopeFactory;
	readonly ringBuffer: RingBuffer;
	readonly bus: EventBus;
}

export interface ContainerServices {
	readonly system: SystemService;
	readonly runAbort: RunAbortService;
}

export interface AppContainer {
	readonly config: ProcessConfig;
	readonly database: DatabaseConnection;
	readonly platform: {
		readonly hostInputs: PlatformHostInputs;
		readonly lock: NativeLockAdapter;
	};
	readonly clock: {
		readonly now: () => string;
	};
	readonly ids: {
		readonly newId: () => string;
	};
	readonly repos: ContainerRepos;
	readonly logstore: Record<string, never>;
	readonly events: ContainerEvents;
	readonly proc: Record<string, never>;
	readonly adapters: Record<string, never>;
	readonly workspace: Record<string, never>;
	readonly services: ContainerServices;
	readonly jobs: readonly ContainerJob[];
	readonly instanceLock: LockFileHandle;
	readonly startedAtMs: number;
}

export function createContainer(input: {
	readonly config: ProcessConfig;
	readonly database: DatabaseConnection;
	readonly hostInputs: PlatformHostInputs;
	readonly lockAdapter: NativeLockAdapter;
	readonly instanceLock: LockFileHandle;
	readonly clock: { readonly now: () => string };
	readonly logstorePaths?: LogstorePaths;
	readonly logFs?: LogFileSystem;
	readonly systemService?: SystemService;
	readonly runAbortService?: RunAbortService;
	readonly runsAbortRepo?: RunsAbortRepo;
	/** Sink for E-206 violation lines; main.ts hands in the daemon run log. */
	readonly logViolation?: (message: string) => void;
}): AppContainer {
	const empty = Object.freeze({});

	const eventSeq = createEventSeqRepo(input.database);
	const runsAbort = input.runsAbortRepo ?? createSqliteRunsAbortRepo(input.database);
	const repos: ContainerRepos = Object.freeze({
		eventSeq,
		runsAbort,
	});

	const idAllocator = createIdAllocator({ store: eventSeq });
	const envelopeFactory = createEnvelopeFactory({ clock: input.clock, idAllocator });
	const ringBuffer = createRingBuffer();
	const bus = createEventBus({ ringBuffer });

	const events: ContainerEvents = Object.freeze({
		idAllocator,
		envelopeFactory,
		ringBuffer,
		bus,
	});

	const logstorePaths =
		input.logstorePaths ?? createLogstorePaths(join(input.config.dataDir, 'runs'));
	const logFs = input.logFs ?? createNodeLogFileSystem();
	const systemService =
		input.systemService ??
		createSystemService({
			paths: logstorePaths,
			fs: logFs,
			bus,
			envelopeFactory,
			logViolation: input.logViolation,
		});

	const unitOfWork = createUnitOfWork(input.database);
	const processOps = createDefaultProcessOps(input.hostInputs.platform);
	const runAbortService =
		input.runAbortService ??
		createRunAbortService({
			runsRepo: runsAbort,
			processOps,
			unitOfWork,
			clock: input.clock,
			bus,
			envelopeFactory,
			platform: input.hostInputs.platform,
		});

	const services: ContainerServices = Object.freeze({
		system: systemService,
		runAbort: runAbortService,
	});

	const jobs: readonly ContainerJob[] = Object.freeze([]);
	const parsedStartedAt = Date.parse(input.clock.now());
	const startedAtMs = Number.isNaN(parsedStartedAt) ? Date.now() : parsedStartedAt;

	return Object.freeze({
		config: input.config,
		database: input.database,
		platform: Object.freeze({ hostInputs: input.hostInputs, lock: input.lockAdapter }),
		clock: input.clock,
		ids: Object.freeze({
			newId: () => `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
		}),
		repos,
		logstore: empty,
		events,
		proc: empty,
		adapters: empty,
		workspace: empty,
		services,
		jobs,
		instanceLock: input.instanceLock,
		startedAtMs,
	});
}
