import type { ProcessConfig } from '../config/env.ts';
import type { DatabaseConnection } from '../db/open-database.ts';
import { type EventBus, createEventBus } from '../events/bus.ts';
import { type EnvelopeFactory, createEnvelopeFactory } from '../events/envelope.ts';
import { type IdAllocator, createIdAllocator } from '../events/id-allocator.ts';
import { type RingBuffer, createRingBuffer } from '../events/ring-buffer.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../platform/lock-contract.ts';
import { type EventSeqRepo, createEventSeqRepo } from '../repo/event-seq-repo.ts';

export interface ContainerJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
}

export interface ContainerRepos {
	readonly eventSeq: EventSeqRepo;
	readonly [key: string]: unknown;
}

export interface ContainerEvents {
	readonly idAllocator: IdAllocator;
	readonly envelopeFactory: EnvelopeFactory;
	readonly ringBuffer: RingBuffer;
	readonly bus: EventBus;
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
	readonly ids: Record<string, never>;
	readonly repos: ContainerRepos;
	readonly logstore: Record<string, never>;
	readonly events: ContainerEvents;
	readonly proc: Record<string, never>;
	readonly adapters: Record<string, never>;
	readonly workspace: Record<string, never>;
	readonly services: Record<string, never>;
	readonly jobs: readonly ContainerJob[];
	readonly instanceLock: LockFileHandle;
}

export function createContainer(input: {
	readonly config: ProcessConfig;
	readonly database: DatabaseConnection;
	readonly hostInputs: PlatformHostInputs;
	readonly lockAdapter: NativeLockAdapter;
	readonly instanceLock: LockFileHandle;
	readonly clock: { readonly now: () => string };
	readonly jobs?: readonly ContainerJob[];
}): AppContainer {
	const empty = Object.freeze({});

	const eventSeq = createEventSeqRepo(input.database);
	const repos: ContainerRepos = Object.freeze({
		eventSeq,
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

	return Object.freeze({
		config: input.config,
		database: input.database,
		platform: Object.freeze({ hostInputs: input.hostInputs, lock: input.lockAdapter }),
		clock: input.clock,
		ids: empty,
		repos,
		logstore: empty,
		events,
		proc: empty,
		adapters: empty,
		workspace: empty,
		services: empty,
		jobs: Object.freeze(input.jobs ? [...input.jobs] : []),
		instanceLock: input.instanceLock,
	});
}
