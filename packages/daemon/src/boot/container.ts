import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ProcessConfig } from '../config/env.ts';
import { type AgentRegistry, createAgentRegistry } from '../config/registry.ts';
import type { DatabaseConnection } from '../db/open-database.ts';
import { createUnitOfWork } from '../db/unit-of-work.ts';
import { type EventBus, createEventBus } from '../events/bus.ts';
import { type EnvelopeFactory, createEnvelopeFactory } from '../events/envelope.ts';
import { type IdAllocator, createIdAllocator } from '../events/id-allocator.ts';
import { type RingBuffer, createRingBuffer } from '../events/ring-buffer.ts';
import { createSchedulerTickJob } from '../jobs/scheduler-tick.ts';
import { createAppendQueue } from '../logstore/append-queue.ts';
import type { LogFileSystem } from '../logstore/contract.ts';
import { createNodeLogFileSystem } from '../logstore/node-log-file-system.ts';
import { type LogstorePaths, createLogstorePaths } from '../logstore/paths.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../platform/lock-contract.ts';
import { type ProcessRegistry, createProcessRegistry } from '../proc/registry.ts';
import { createDefaultProcessOps } from '../proc/spawn.ts';
import { type BatchWrapupsRepo, createBatchWrapupsRepo } from '../repo/batch-wrapups.ts';
import { type BatchesRepo, createBatchesRepo } from '../repo/batches.ts';
import { type DevicesRepo, createDevicesRepo } from '../repo/devices.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../repo/dispatch-snapshots.ts';
import { type DocumentsRepo, createDocumentsRepo } from '../repo/documents.ts';
import { type EventSeqRepo, createEventSeqRepo } from '../repo/event-seq-repo.ts';
import { createEventsIndexRepo } from '../repo/events-index-repo.ts';
import { type GatesRepo, createGatesRepo } from '../repo/gates.ts';
import { type LogSegmentsRepo, createLogSegmentsRepo } from '../repo/log-segments-repo.ts';
import { type RunMessagesRepo, createSqliteRunMessagesRepo } from '../repo/run-messages-repo.ts';
import { type RunsAbortRepo, createSqliteRunsAbortRepo } from '../repo/runs-abort-repo.ts';
import { type RunsLogRepo, createSqliteRunsLogRepo } from '../repo/runs-log-repo.ts';
import { type RunsRepo, createRunsRepo } from '../repo/runs.ts';
import { type SettingsRepo, createSettingsRepo } from '../repo/settings.ts';
import { type TasksRepo, createTasksRepo } from '../repo/tasks.ts';
import { type AgentService, createAgentService } from '../service/agents.ts';
import { type BatchService, createBatchService } from '../service/batch.ts';
import { type DispatchService, createDispatchService } from '../service/dispatch.ts';
import { type DocsService, createDocsService } from '../service/docs.ts';
import { type GateService, createGateService } from '../service/gates.ts';
import { type LandingService, createLandingService } from '../service/landing.ts';
import { createLogstoreService } from '../service/logstore.ts';
import { type MessageService, createMessageService } from '../service/message.ts';
import { type PairingService, createPairingService } from '../service/pairing.ts';
import { type RetentionService, createRetentionService } from '../service/retention.ts';
import { type ReworkService, createReworkService } from '../service/rework.ts';
import { type RunAbortService, createRunAbortService } from '../service/run-abort.ts';
import { type RunLogService, createRunLogService } from '../service/run-log.ts';
import {
	type RunsRepo as RunLifecycleRepo,
	type RunRecord,
	type RunService,
	createRunService,
} from '../service/run.ts';
import { createSessionArchiveService } from '../service/session-archive.ts';
import { type SettingsService, createSettingsService } from '../service/settings.ts';
import { type SystemService, createSystemService } from '../service/system.ts';
import { type WrapupService, createWrapupService } from '../service/wrapup.ts';
import { getDiffStat } from '../workspace/diff.ts';
import { type WorktreeManager, createWorktreeManager } from '../workspace/worktree.ts';

export interface ContainerJob {
	readonly name: string;
	start(): void;
	stop(): Promise<void>;
}

export interface ContainerRepos {
	readonly eventSeq: EventSeqRepo;
	readonly runsAbort: RunsAbortRepo;
	readonly runsLog?: RunsLogRepo;
	readonly dispatchSnapshots?: DispatchSnapshotsRepo;
	readonly logSegments?: LogSegmentsRepo;
	readonly devices: DevicesRepo;
	readonly documents: DocumentsRepo;
	readonly runMessages: RunMessagesRepo;
	readonly tasks: TasksRepo;
	readonly runs: RunsRepo;
	readonly batches: BatchesRepo;
	readonly batchWrapups?: BatchWrapupsRepo;
	readonly gates?: GatesRepo;
	readonly settings?: SettingsRepo;
	readonly [key: string]: unknown;
}

export interface ContainerEvents {
	readonly idAllocator: IdAllocator;
	readonly envelopeFactory: EnvelopeFactory;
	readonly ringBuffer: RingBuffer;
	readonly bus: EventBus;
}

export interface ContainerWorkspace {
	readonly worktrees: WorktreeManager;
}

export interface ContainerServices {
	readonly system: SystemService;
	readonly runAbort: RunAbortService;
	readonly runLog: RunLogService;
	readonly pairing: PairingService;
	readonly docs: DocsService;
	readonly agents: AgentService;
	readonly landing: LandingService;
	readonly message: MessageService;
	readonly retention: RetentionService;
	readonly dispatch: DispatchService;
	readonly rework: ReworkService;
	readonly settings: SettingsService;
	readonly gates: GateService;
	readonly batch?: BatchService;
	readonly wrapup?: WrapupService;
	readonly run: RunService;
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
	readonly workspace: ContainerWorkspace;
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
	readonly runsLogRepo?: RunsLogRepo;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly logSegmentsRepo?: LogSegmentsRepo;
	readonly runLogService?: RunLogService;
	readonly retentionService?: RetentionService;
	readonly pairingService?: PairingService;
	readonly docsService?: DocsService;
	readonly documentsRepo?: DocumentsRepo;
	readonly runMessagesRepo?: RunMessagesRepo;
	readonly messageService?: MessageService;
	readonly processRegistry?: ProcessRegistry;
	readonly agentRegistry?: AgentRegistry;
	readonly agentService?: AgentService;
	readonly tasksRepo?: TasksRepo;
	readonly landingService?: LandingService;
	readonly runsRepo?: RunsRepo;
	readonly batchesRepo?: BatchesRepo;
	readonly batchWrapupsRepo?: BatchWrapupsRepo;
	readonly gatesRepo?: GatesRepo;
	readonly settingsRepo?: SettingsRepo;
	readonly settingsService?: SettingsService;
	readonly gateService?: GateService;
	readonly dispatchService?: DispatchService;
	readonly reworkService?: ReworkService;
	readonly batchService?: BatchService;
	readonly wrapupService?: WrapupService;
	readonly runService?: RunService;
	readonly worktreeManager?: WorktreeManager;
	readonly schedulerTickJob?: ContainerJob;
	/** Sink for E-206 violation lines; main.ts hands in the daemon run log. */
	readonly logViolation?: (message: string) => void;
}): AppContainer {
	const empty = Object.freeze({});

	const eventSeq = createEventSeqRepo(input.database);
	const eventsIndex = createEventsIndexRepo(input.database);
	const runsAbort = input.runsAbortRepo ?? createSqliteRunsAbortRepo(input.database);
	const runsLog = input.runsLogRepo ?? createSqliteRunsLogRepo(input.database);
	const dispatchSnapshots =
		input.dispatchSnapshotsRepo ?? createDispatchSnapshotsRepo(input.database);
	const logSegments = input.logSegmentsRepo ?? createLogSegmentsRepo(input.database);
	const devices = createDevicesRepo(input.database);
	const documents = input.documentsRepo ?? createDocumentsRepo(input.database);
	const runMessages = input.runMessagesRepo ?? createSqliteRunMessagesRepo(input.database);
	const tasks = input.tasksRepo ?? createTasksRepo(input.database);
	const runs = input.runsRepo ?? createRunsRepo(input.database);
	const batches = input.batchesRepo ?? createBatchesRepo(input.database);
	const batchWrapups = input.batchWrapupsRepo ?? createBatchWrapupsRepo(input.database);
	const gates = input.gatesRepo ?? createGatesRepo(input.database);
	const settings = input.settingsRepo ?? createSettingsRepo(input.database);
	const repos: ContainerRepos = Object.freeze({
		eventSeq,
		runsAbort,
		runsLog,
		dispatchSnapshots,
		logSegments,
		devices,
		documents,
		runMessages,
		tasks,
		runs,
		batches,
		batchWrapups,
		gates,
		settings,
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

	const ids = Object.freeze({
		newId: () => `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
	});
	const logstorePaths =
		input.logstorePaths ?? createLogstorePaths(join(input.config.dataDir, 'runs'));
	const logFs = input.logFs ?? createNodeLogFileSystem();
	const unitOfWork = createUnitOfWork(input.database);
	const appendQueue = createAppendQueue({
		appendFile: (path, data) => logFs.appendFile(path, data),
	});
	const logstoreService = createLogstoreService({
		fs: logFs,
		paths: logstorePaths,
		queue: appendQueue,
		ids,
		unitOfWork,
		eventsIndexRepo: eventsIndex,
		segmentsRepo: logSegments,
	});
	const systemService =
		input.systemService ??
		createSystemService({
			paths: logstorePaths,
			fs: logFs,
			bus,
			envelopeFactory,
			logViolation: input.logViolation,
		});

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

	const worktreeDeps = Object.freeze({
		platform: input.hostInputs.platform,
		hostInputs: input.hostInputs,
		ids,
	});
	const worktreeManager = input.worktreeManager ?? createWorktreeManager(worktreeDeps);
	const workspace: ContainerWorkspace = Object.freeze({ worktrees: worktreeManager });

	const pairingService =
		input.pairingService ??
		createPairingService({
			devicesRepo: devices,
			clock: input.clock,
			ids,
			dataDir: input.config.dataDir,
			platform: input.hostInputs.platform,
		});

	pairingService.bootstrapIfNeeded();

	const docsService =
		input.docsService ??
		createDocsService({
			documentsRepo: documents,
			clock: input.clock,
			ids,
			bus,
			envelopeFactory,
			hostInputs: input.hostInputs,
		});

	const agentRegistry =
		input.agentRegistry ??
		createAgentRegistry({
			dataDir: input.config.dataDir,
			platform: input.hostInputs.platform === 'win32' ? 'win32' : 'posix',
			publishWarning: (warning) => {
				const envelope = envelopeFactory.createEnvelope({
					kind: 'agent.availability_changed',
					payload: {
						agentId: warning.agentId ?? 'system',
						available: false,
						reason: warning.message,
						vendor: {
							severity: warning.severity,
							reason: warning.reason,
							configPath: warning.configPath,
						},
					},
				});
				bus.publish(envelope);
			},
		});

	const agentService =
		input.agentService ??
		createAgentService({
			registry: agentRegistry,
			hostInputs: input.hostInputs,
			bus,
			envelopeFactory,
			clock: input.clock,
		});

	void agentService.start();

	const landingService =
		input.landingService ??
		createLandingService({
			tasksRepo: tasks,
			documentsRepo: documents,
			platform: input.hostInputs.platform,
			hostInputs: input.hostInputs,
			ids,
		});

	const processRegistry = input.processRegistry ?? createProcessRegistry();
	const sessionArchiveService = createSessionArchiveService({
		runsRepo: runs,
		tasksRepo: tasks,
		processRegistry,
		clock: input.clock,
		envelopeFactory,
		bus,
		processOps,
		platform: input.hostInputs.platform,
	});
	const messageService =
		input.messageService ??
		createMessageService({
			runMessagesRepo: runMessages,
			processRegistry,
			clock: input.clock,
			ids: Object.freeze({
				newId: () => `msg_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
			}),
			bus,
			envelopeFactory,
			unitOfWork,
		});

	const reworkService =
		input.reworkService ??
		createReworkService({
			runsRepo: runs,
			snapshotsRepo: dispatchSnapshots,
			processRegistry,
			messageService,
			unitOfWork,
			bus,
			envelopeFactory,
			clock: input.clock,
			ids,
		});

	const runLogService =
		input.runLogService ??
		createRunLogService({
			runsRepo: runsLog,
			snapshotsRepo: dispatchSnapshots,
			logSegmentsRepo: logSegments,
			logstorePaths,
			platform: input.hostInputs.platform,
		});

	const retentionService =
		input.retentionService ??
		createRetentionService({
			runsRepo: runsLog,
			logstorePaths,
			systemService,
			logSegmentsRepo: logSegments,
			clock: input.clock,
		});

	const batchService =
		input.batchService ??
		createBatchService({
			batchesRepo: batches,
			tasksRepo: tasks,
			runsRepo: runs,
			unitOfWork,
			clock: input.clock,
			bus,
			envelopeFactory,
		});

	const wrapupService =
		input.wrapupService ??
		createWrapupService({
			batchesRepo: batches,
			tasksRepo: tasks,
			runsRepo: runs,
			dispatchSnapshotsRepo: dispatchSnapshots,
			batchWrapupsRepo: batchWrapups,
			gatesRepo: gates,
			documentsRepo: documents,
			batchService,
			docsService,
			unitOfWork,
			clock: input.clock,
			ids,
			bus,
			envelopeFactory,
			agentRegistry,
			agentService,
			workspace: {
				prepareWrapupWorktree: async (params) => {
					const prepared = await worktreeManager.prepareWrapupWorktree(params);
					return {
						worktreePath: prepared.worktreePath,
						branchName: prepared.branchName,
						baseSha: prepared.baseRef,
					};
				},
				getDiffStat: async (worktreePath) => {
					const stat = await getDiffStat(worktreePath, { deps: worktreeDeps });
					const files = stat.files.map(
						(file) => `${file.path} | +${file.insertions} -${file.deletions} | ${file.status}`,
					);
					return [
						...files,
						`Total: ${stat.filesChanged} files, +${stat.insertions} -${stat.deletions}`,
					].join('\n');
				},
			},
			logstorePaths,
			logFs,
		});

	const runLifecycleRepo: RunLifecycleRepo = Object.freeze({
		findById(id: string): RunRecord | null {
			const row = runs.findById(id);
			return row
				? {
						id: row.id,
						taskId: row.task_id,
						state: row.state as RunRecord['state'],
						pid: row.pid,
						kind: row.kind,
						session_archived_at: row.session_archived_at ?? null,
						lane_no: row.lane_no ?? null,
						lastEventAt: row.last_event_at,
						unmappedEventCount: row.unmapped_event_count,
						exitCode: row.exit_code,
						exitSignal: row.exit_signal,
						endedAt: row.ended_at,
						actorDeviceId: row.actor_device_id,
					}
				: null;
		},
		updateState(input: Parameters<RunLifecycleRepo['updateState']>[0]) {
			runs.updateState(input);
		},
		updateLastEventAt(id: string, lastEventAt: string) {
			runs.updateLastEventAt?.(id, lastEventAt);
		},
		incrementUnmappedEventCount(id: string) {
			runs.incrementUnmappedEventCount?.(id);
		},
		findInFlight() {
			return (runs.findInFlight?.() ?? runs.listActive()).map((row) => ({
				id: row.id,
				taskId: row.task_id,
				state: row.state as RunRecord['state'],
				pid: row.pid,
				kind: row.kind,
			}));
		},
	});
	const runService =
		input.runService ??
		createRunService({
			logstore: logstoreService,
			clock: input.clock,
			envelopeFactory,
			bus,
			unitOfWork,
			runsRepo: runLifecycleRepo,
			tasksRepo: tasks,
			sessionArchiveService,
			finalizeWrapup: (params) => wrapupService.recordWrapupResult(params),
			logFailure: (error) =>
				input.logViolation?.(error instanceof Error ? error.message : String(error)),
		});

	const dispatchService =
		input.dispatchService ??
		createDispatchService({
			unitOfWork,
			tasksRepo: tasks,
			batchesRepo: batches,
			documentsRepo: documents,
			dispatchSnapshotsRepo: dispatchSnapshots,
			runsRepo: runs,
			batchWrapupsRepo: batchWrapups,
			batchService,
			wrapupService,
			clock: input.clock,
			ids,
			bus,
			envelopeFactory,
			eventSeqRepo: eventSeq,
			getDispatchHalt: () => systemService.isDispatchHalted(),
			listAgents: () => agentService.listAgents(),
			listDispatchableAgents: () => {
				const snapshot = agentRegistry.getSnapshot();
				return Object.keys(snapshot.agents).map((agentId) => {
					const availability = agentService.getAvailability(agentId);
					return {
						agentId,
						canDispatch: availability?.canDispatch === true,
					};
				});
			},
		});

	const schedulerTickJob =
		input.schedulerTickJob ??
		createSchedulerTickJob({
			dispatchService,
			logFailure: (error) => {
				input.logViolation?.(error instanceof Error ? error.message : String(error));
			},
		});

	const gateServiceHolder: { current?: GateService } = {};

	const settingsService =
		input.settingsService ??
		createSettingsService({
			settingsRepo: settings,
			clock: input.clock,
			bus,
			envelopeFactory,
			unitOfWork,
			warn: (message: string) => {
				input.logViolation?.(`[WARN] ${message}`);
				console.warn(`[daemon] ${message}`);
			},
			// Shares the settings write's single transaction; returns events to publish afterwards.
			onGatesUpdated: (newGates, previousGates, actorDeviceId) =>
				gateServiceHolder.current?.reEvaluateWaitingGatesInTx(
					newGates,
					previousGates,
					actorDeviceId,
				) ?? [],
		});

	const gateService =
		input.gateService ??
		createGateService({
			gatesRepo: gates,
			tasksRepo: tasks,
			runsRepo: runs,
			batchesRepo: batches,
			batchWrapupsRepo: batchWrapups,
			batchService,
			clock: input.clock,
			ids,
			bus,
			envelopeFactory,
			unitOfWork,
			settingsService,
			getBatchGateOverrides: (batchId: string) => dispatchService.getBatchGateOverrides(batchId),
		});

	gateServiceHolder.current = gateService;

	const services: ContainerServices = Object.freeze({
		system: systemService,
		runAbort: runAbortService,
		runLog: runLogService,
		retention: retentionService,
		pairing: pairingService,
		docs: docsService,
		agents: agentService,
		landing: landingService,
		message: messageService,
		dispatch: dispatchService,
		rework: reworkService,
		settings: settingsService,
		gates: gateService,
		batch: batchService,
		wrapup: wrapupService,
		run: runService,
	});

	const jobs: readonly ContainerJob[] = Object.freeze([schedulerTickJob]);
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
		workspace,
		services,
		jobs,
		instanceLock: input.instanceLock,
		startedAtMs,
	});
}
