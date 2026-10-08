import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventEnvelope, EventKind } from '@agent-scheduler/shared/api/events';
import { afterEach, expect, it, vi } from 'vitest';
import type { CodexSessionRegistry } from '../../src/adapters/codex/app-server-session.ts';
import { type ContainerProc, createContainer } from '../../src/boot/container.ts';
import {
	BUILT_IN_AGENT_DEFAULTS,
	GENERIC_LOGIN_PROBE_DEFAULT,
	GENERIC_MODELS_LIVE_DEFAULT,
} from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import * as envelopes from '../../src/events/envelope.ts';
import { MAX_PENDING_EVENT_RESERVATIONS } from '../../src/events/publication-order.ts';
import { createHttpServer } from '../../src/http/server.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { createProcessRegistry } from '../../src/proc/registry.ts';
import { type ManagedProcess, spawnManaged } from '../../src/proc/spawn.ts';
import type { RunInsertRow } from '../../src/repo/runs.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

async function environment(
	codexSessions: CodexSessionRegistry | null = null,
	options: {
		readonly agentDefaults?: boolean;
		readonly availabilityOwner?: 'request' | 'reload';
		readonly proc?: ContainerProc;
	} = {},
) {
	const tempRoot = realpathSync.native(tmpdir());
	const dataDir = realpathSync.native(mkdtempSync(join(tempRoot, 'agsched-completion-')));
	execFileSync('git', ['init', '-q', dataDir]);
	const docsPath = join(dataDir, 'source', 'docs-data.js');
	mkdirSync(dirname(docsPath));
	writeFileSync(docsPath, 'document source fixture');
	const db = openDatabase(':memory:');
	let databaseClosed = false;
	const closeDatabase = () => {
		if (databaseClosed) return;
		db.close();
		databaseClosed = true;
	};
	const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrations)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrations, file), 'utf8'));
	}
	let releaseWrite = () => {};
	let observeWrite = () => {};
	const blocked = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const started = new Promise<void>((resolve) => {
		observeWrite = resolve;
	});
	const fs = createNodeLogFileSystem();
	const admissions: Array<EventKind | 'capacity'> = [];
	const availabilityAdmissions: Array<{ settled: boolean }> = [];
	const operations: Promise<unknown>[] = [];
	let controlReload = false;
	let releaseAvailabilityAttempt = () => {};
	const availabilityAttempt = new Promise<void>((resolve) => {
		releaseAvailabilityAttempt = resolve;
	});
	function isControlledAvailability(input: envelopes.CreateEnvelopeInput) {
		return (
			controlReload &&
			input.kind === 'agent.availability_changed' &&
			'available' in input.payload &&
			input.payload.available === true
		);
	}
	const createFactory = envelopes.createEnvelopeFactory;
	// Observe admission entry; all allocation, capacity and publication behavior stays real.
	vi.spyOn(envelopes, 'createEnvelopeFactory').mockImplementation((deps) => {
		const factory = createFactory(deps);
		return {
			...factory,
			createEnvelope(input) {
				try {
					return factory.createEnvelope(input);
				} finally {
					if (isControlledAvailability(input)) releaseAvailabilityAttempt();
				}
			},
			createEnvelopeAsync(input) {
				admissions.push(input.kind);
				const completion = factory.createEnvelopeAsync(input);
				if (isControlledAvailability(input)) {
					const admission = { settled: false };
					availabilityAdmissions.push(admission);
					void completion.then(
						() => {
							admission.settled = true;
						},
						() => {
							admission.settled = true;
						},
					);
					releaseAvailabilityAttempt();
				}
				return completion;
			},
			waitForCapacity() {
				admissions.push('capacity');
				return factory.waitForCapacity();
			},
		};
	});
	const errors: string[] = [];
	const now = '2026-10-03T10:00:00.000Z';
	const platform =
		process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
	function controlAvailabilityOwner(registry: ReturnType<typeof createAgentRegistry>) {
		return {
			...registry,
			async updateOverrides(...args: Parameters<typeof registry.updateOverrides>) {
				controlReload = options.availabilityOwner !== undefined;
				const result = await registry.updateOverrides(...args);
				// Keep real file writes/probes; choose which real caller observes the new state first.
				if (options.availabilityOwner === 'reload') await availabilityAttempt;
				return result;
			},
			onReload(listener: Parameters<typeof registry.onReload>[0]) {
				return registry.onReload((snapshot) => {
					if (controlReload && options.availabilityOwner === 'request') {
						operations.push(availabilityAttempt.then(() => listener(snapshot)));
					} else {
						listener(snapshot);
					}
				});
			},
		};
	}
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		processRegistry: createProcessRegistry(),
		proc: options.proc,
		codexSessions,
		hostInputs: { platform, homedir: dataDir, pathEnv: process.env.PATH },
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release() {} } as unknown as LockFileHandle,
		clock: { now: () => now },
		bootstrapPairing: false,
		logViolation: (error) => errors.push(String(error)),
		agentRegistry: controlAvailabilityOwner(
			createAgentRegistry({
				dataDir,
				builtInDefaults: options.agentDefaults
					? {
							codex: {
								...BUILT_IN_AGENT_DEFAULTS.codex,
								execPath: join(dataDir, 'missing-agent'),
								versionFingerprint: { args: ['--version'], expectedPattern: '^v[0-9]' },
								loginProbe: GENERIC_LOGIN_PROBE_DEFAULT,
								modelsLive: GENERIC_MODELS_LIVE_DEFAULT,
							},
						}
					: {},
				platform: platform === 'win32' ? 'win32' : 'posix',
				publishWarning() {},
			}),
		),
		logFs: {
			...fs,
			async appendFile(path, bytes) {
				observeWrite();
				await blocked;
				await fs.appendFile(path, bytes);
			},
		},
	});
	if (
		!container.services.bughunt ||
		!container.services.wrapup ||
		!container.services.review.finalizeReview
	) {
		throw new Error('Completion services must be wired by the production container');
	}
	const server = createHttpServer({ container });
	let ingestion: Promise<unknown> = Promise.resolve();
	cleanups.push(async () => {
		releaseAvailabilityAttempt();
		releaseWrite();
		await Promise.allSettled([ingestion, ...operations]);
		await server.close();
		await container.services.agents.stop();
		await container.events.dispose();
		closeDatabase();
		const canonicalDir = realpathSync.native(dataDir);
		expect(dirname(canonicalDir)).toBe(tempRoot);
		expect(basename(canonicalDir)).toMatch(/^agsched-completion-/);
		rmSync(canonicalDir, { recursive: true, force: true });
	});
	await server.instance.ready();
	const claim = await container.services.pairing.claimPairingCode({
		code: container.services.pairing.createPairingCode().code,
		deviceName: 'completion pressure observer',
	});
	container.repos.documents.insert({
		id: 'doc',
		docs_path: docsPath,
		project_name: 'pressure',
		repo_path: dataDir,
		main_branch: 'main',
		branch_prefix: 'task/',
		lane_count: 1,
		content_fingerprint: 'fp',
		is_source_readable: 1,
		is_takeover_notified: 0,
		imported_at: now,
		last_seen_at: now,
	});
	container.repos.batches.insert({ id: 'batch', doc_id: 'doc', batch_no: 1, state: 'wrapping' });
	container.repos.tasks.insert({
		id: 'task',
		doc_id: 'doc',
		task_key: 'M6-T5',
		title: 'pressure',
		module_key: 'M6',
		deps_json: '[]',
		contract_hash: 'contract',
		is_contract_ready: 1,
		contract_reasons_json: '[]',
		lane_no: 1,
		batch_id: 'batch',
	});
	container.repos.dispatchSnapshots?.insert({
		id: 'snapshot',
		task_id: 'task',
		contract_hash: 'contract',
		task_paths_json: '[]',
		launch_spec_json: '{}',
		created_at: now,
	});
	const events: EventEnvelope[] = [];
	container.events.bus.subscribe((event) => events.push(event));
	return {
		bughunt: container.services.bughunt,
		wrapup: container.services.wrapup,
		finalizeReview: container.services.review.finalizeReview.bind(container.services.review),
		dataDir,
		db,
		closeDatabase,
		container,
		server,
		events,
		errors,
		admissions,
		availabilityAdmissions,
		operations,
		headers: { authorization: `Bearer ${claim.token}` },
		seed(id: string, kind: string, state: string, extra: Partial<RunInsertRow> = {}) {
			container.repos.runs.insert({
				id,
				task_id: kind === 'wrapup' ? null : 'task',
				attempt_no: container.repos.runs.listAll().length + 1,
				kind,
				state,
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snapshot',
				lane_no: 1,
				batch_id: 'batch',
				...extra,
			});
		},
		count(kind: EventKind) {
			return events.filter((event) => event.kind === kind).length;
		},
		async pressure() {
			const previousEvents = events.length;
			ingestion = container.services.run.ingestEvent(
				'pressure',
				container.events.envelopeFactory.createEnvelope({
					runId: 'pressure',
					kind: 'agent_message_chunk',
					payload: { chunk: 'disk-pending head' },
				}),
			);
			await started;
			// One real log append is held; ordinary settings events fill the remaining slots.
			for (let i = 1; i < MAX_PENDING_EVENT_RESERVATIONS; i++) {
				container.services.settings.updatePipeline(
					{
						bughunt: 0,
						wrapupMode: 'auto',
						reviewOverride: null,
						wrapupAssignment: { mode: 'follow' },
					},
					null,
				);
			}
			expect(events).toHaveLength(previousEvents);
			events.length = 0;
			admissions.length = 0;
		},
		async release() {
			releaseWrite();
			await ingestion;
		},
	};
}

type Environment = Awaited<ReturnType<typeof environment>>;

function finishDuringDrain(env: Environment, runId: string, target: 'aborted' | 'landed') {
	let publications = 0;
	let stoppedState: string | undefined;
	let finish: Promise<unknown> | undefined;
	const unsubscribe = env.container.events.bus.subscribe(() => {
		// The drain has freed five slots, but its capacity waiters have not resumed yet.
		if (++publications !== 5) return;
		finish =
			target === 'aborted'
				? env.container.services.runAbort.abortRun({ runId, graceMs: 50 })
				: env.container.services.gates.decideGate({
						gateId: 'landing',
						decision: 'pass',
						actorDeviceId: null,
					});
		stoppedState = env.container.repos.runs.findById(runId)?.state;
		env.operations.push(finish.catch(() => {}));
	});
	cleanups.push(async () => {
		unsubscribe();
	});
	return async () => {
		expect(finish).toBeDefined();
		expect(await finish).toMatchObject(
			target === 'aborted' ? { accepted: true, currentState: 'aborted' } : { applied: true },
		);
		expect(stoppedState).toBe(target);
		expect(env.container.repos.runs.findById(runId)).toMatchObject({
			state: target,
			session_archived_at: '2026-10-03T10:00:00.000Z',
		});
		expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
		expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(0);
		expect(env.count(target === 'aborted' ? 'run.aborted' : 'task.landed')).toBe(1);
		expect(env.count('task.sessions_archived')).toBe(1);
	};
}

async function completesAfterRelease<T>(
	env: Environment,
	operation: PromiseLike<T>,
	checkHeldBoundary: () => void | Promise<void>,
): Promise<T> {
	let settled = false;
	const completion = Promise.resolve(operation).finally(() => {
		settled = true;
	});
	// Keep rejection handled while assertions inspect the held operation, including on failure.
	env.operations.push(completion.catch(() => {}));
	await vi.waitFor(
		async () => {
			expect(env.admissions.length).toBeGreaterThan(0);
			expect(settled).toBe(false);
			await checkHeldBoundary();
		},
		{ timeout: 10_000, interval: 10 },
	);
	expect(env.events).toHaveLength(0);
	await env.release();
	const result = await completion;
	expect(env.errors).toEqual([]);
	return result;
}

// Real child exit results enter container-owned finalizers.
async function actualExit(exitCode: number, cwd: string) {
	const child = spawn(process.execPath, ['-e', `process.exit(${exitCode})`], {
		cwd,
		stdio: 'ignore',
		windowsHide: true,
	});
	const closed = once(child, 'close');
	cleanups.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await closed;
	});
	await closed;
	expect(child.exitCode).toBe(exitCode);
	expect(child.signalCode).toBeNull();
	return { exitCode: child.exitCode, exitSignal: child.signalCode };
}

it.each([false, true])(
	'completes one authenticated real stdin reply without resending (abort during wait: %s)',
	async (abortWhileWaiting) => {
		const env = await environment();
		env.seed('implementation', 'implement', 'awaiting_reply');
		const received = join(env.dataDir, 'received.txt');
		const managed = env.container.proc.spawnManaged({
			runId: 'implementation',
			file: process.execPath,
			args: [
				'-e',
				`const fs=require('node:fs');process.stdout.write('{}\\n');process.stdin.on('data',b=>fs.appendFileSync(${JSON.stringify(received)},b));`,
			],
			cwd: env.dataDir,
			stdinMode: 'pipe',
			timeouts: { startupTimeoutMs: 10_000, idleTimeoutMs: 60_000, hardWallClockMs: 60_000 },
		});
		const closed = once(managed.child, 'close');
		cleanups.push(async () => {
			if (!managed.isExited) await managed.kill({ graceMs: 50 });
			await closed;
			await managed.finalize();
		});
		await once(managed.child, 'spawn');
		env.container.repos.runs.updateState({
			id: 'implementation',
			toState: 'awaiting_reply',
			pid: managed.pid,
		});
		await env.pressure();
		const checkAbort = abortWhileWaiting
			? finishDuringDrain(env, 'implementation', 'aborted')
			: null;
		const refreshed: Promise<{ state: string }>[] = [];
		if (abortWhileWaiting) {
			env.container.events.bus.subscribe((event) => {
				if (event.kind !== 'run.state_changed') return;
				// The Web invalidates and reloads runs for these notifications, including delayed facts.
				refreshed.push(
					env.server.instance
						.inject({
							method: 'GET',
							url: '/api/v1/runs/implementation',
							headers: env.headers,
						})
						.then((response) => {
							expect(response.statusCode).toBe(200);
							return response.json().run;
						}),
				);
			});
		}
		const response = await completesAfterRelease(
			env,
			env.server.instance.inject({
				method: 'POST',
				url: '/api/v1/runs/implementation/messages',
				headers: env.headers,
				payload: { kind: 'reply', text: 'one actual delivery' },
			}),
			async () => {
				expect(existsSync(received) && readFileSync(received, 'utf8')).toBe(
					'one actual delivery\n',
				);
				expect(await env.container.services.message.getRunMessages('implementation')).toHaveLength(
					1,
				);
			},
		);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ delivered: true });
		expect(readFileSync(received, 'utf8')).toBe('one actual delivery\n');
		expect(await env.container.services.message.getRunMessages('implementation')).toHaveLength(1);
		if (checkAbort) await checkAbort();
		for (const run of await Promise.all(refreshed)) expect(run.state).toBe('aborted');
		if (abortWhileWaiting) expect(refreshed).toHaveLength(2);
		expect(env.events.map((event) => event.id)).toEqual(
			env.events.map((event) => event.id).sort((a, b) => a - b),
		);
		expect(env.container.repos.runs.findById('implementation')?.state).toBe(
			abortWhileWaiting ? 'aborted' : 'running',
		);
		expect(env.count('run.message_delivered')).toBe(1);
		expect(env.count('run.state_changed')).toBe(abortWhileWaiting ? 2 : 1);
	},
);

it('does not repeat an accepted approval or elevation under pressure (provider boundary mocked)', async () => {
	let approved = 0;
	let elevated = 0;
	let cleared = 0;
	const session = {
		hasPendingApproval: () => approved === 0,
		approveOnce: async () => {
			approved++;
		},
	};
	const env = await environment({
		get: (id: string) => (id === 'implementation' ? session : undefined),
	} as unknown as CodexSessionRegistry);
	env.seed('implementation', 'implement', 'awaiting_reply');
	await env.pressure();
	const delivered = await completesAfterRelease(
		env,
		env.container.services.message.sendMessage({
			runId: 'implementation',
			kind: 'elevate_once',
			elevateRunOnce: async () => {
				elevated++;
			},
			clearTemporaryElevation: () => {
				cleared++;
			},
		}),
		() => {
			expect({ approved, elevated, cleared }).toEqual({ approved: 1, elevated: 1, cleared: 0 });
		},
	);
	expect(delivered.delivered).toBe(true);
	expect({ approved, elevated, cleared }).toEqual({ approved: 1, elevated: 1, cleared: 0 });
	expect(await env.container.services.message.getRunMessages('implementation')).toHaveLength(1);
	expect(env.count('run.message_delivered')).toBe(1);
});

it('finishes a failed bughunt exactly once after a real child exit and event pressure', async () => {
	const env = await environment();
	env.seed('implementation', 'implement', 'reviewing');
	env.seed('bughunt', 'bughunt', 'exited', { parent_run_id: 'implementation' });
	const exit = await actualExit(1, env.dataDir);
	await env.pressure();
	const result = await completesAfterRelease(
		env,
		env.bughunt.finalizeBughuntRun({
			bughuntRunId: 'bughunt',
			...exit,
		}),
		() => {
			expect(env.container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
			expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(1);
		},
	);
	expect(result.action).toBe('failed');
	expect(env.container.repos.runs.findById('bughunt')).toMatchObject({
		state: 'failed',
		exit_code: 1,
	});
	expect(env.container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
	expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(1);
	expect(env.count('run.state_changed')).toBe(1);
	expect(env.count('lane.released')).toBe(1);
});

it('retries only the wrapup completion transaction after a real failed child exit', async () => {
	const env = await environment();
	env.seed('wrapup', 'wrapup', 'exited');
	const exit = await actualExit(1, env.dataDir);
	await env.pressure();
	await completesAfterRelease(
		env,
		env.wrapup.recordWrapupResult({
			runId: 'wrapup',
			exitCode: exit.exitCode,
			rawText: 'failed external process',
		}),
		() => {
			expect(env.admissions).toContain('capacity');
			expect(env.container.repos.runs.findById('wrapup')?.state).toBe('exited');
			expect(env.container.repos.batches.findById('batch')?.state).toBe('wrapping');
			expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(0);
		},
	);
	expect(env.container.repos.runs.findById('wrapup')?.state).toBe('awaiting_human');
	expect(env.container.repos.batches.findById('batch')?.state).toBe('needs_attention');
	expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(1);
	expect(env.count('batch.wrapup_finished')).toBe(1);
	expect(env.count('run.state_changed')).toBe(1);
	expect(env.count('lane.released')).toBe(1);
});

it.each([false, true])(
	'does not revive a review awaiting verdict admission after real exit (archive during wait: %s)',
	async (archiveWhileWaiting) => {
		const env = await environment();
		env.seed('implementation', 'implement', 'reviewing');
		env.seed('review', 'review', 'exited', { parent_run_id: 'implementation' });
		if (archiveWhileWaiting)
			env.container.repos.gates?.create({
				id: 'landing',
				task_id: 'task',
				run_id: 'implementation',
				kind: 'landing',
				state: 'waiting',
				created_at: '2026-10-03T10:00:00.000Z',
			});
		const exit = await actualExit(0, env.dataDir);
		await env.pressure();
		const checkArchive = archiveWhileWaiting
			? finishDuringDrain(env, 'implementation', 'landed')
			: null;
		const result = await completesAfterRelease(
			env,
			env.finalizeReview({
				runId: 'review',
				exitCode: exit.exitCode,
			}),
			() => {
				expect(env.admissions).toContain('task.review_verdict');
				expect(env.container.repos.runs.findById('implementation')?.state).toBe('reviewing');
				expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(
					archiveWhileWaiting ? 1 : 0,
				);
			},
		);
		expect(result.action).toBe('awaiting_human');
		if (checkArchive) await checkArchive();
		expect(env.container.repos.runs.findById('implementation')?.state).toBe(
			archiveWhileWaiting ? 'landed' : 'awaiting_human',
		);
		expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(
			archiveWhileWaiting ? 0 : 1,
		);
		expect(env.count('task.review_verdict')).toBe(1);
	},
);

function gitWorktree(env: Environment) {
	const workspace = join(env.dataDir, 'workspace');
	mkdirSync(workspace);
	const git = (args: string[]) =>
		execFileSync('git', args, { cwd: workspace, stdio: 'pipe', windowsHide: true });
	git(['init', '-b', 'main']);
	writeFileSync(join(workspace, 'source.txt'), 'original\n');
	git(['add', 'source.txt']);
	git([
		'-c',
		'user.name=Verifier',
		'-c',
		'user.email=verifier@example.test',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-m',
		'baseline',
	]);
	writeFileSync(join(workspace, 'source.txt'), 'actual implementation change\n');
	return workspace;
}

it('preserves one mechanical-check handoff with a real Git diff and failed child exit', async () => {
	const env = await environment();
	const workspace = gitWorktree(env);
	env.seed('implementation', 'implement', 'exited');
	const exit = await actualExit(1, workspace);
	await env.pressure();
	const result = await completesAfterRelease(
		env,
		env.container.services.review.evaluateMechanicalCheck({
			runId: 'implementation',
			exitCode: exit.exitCode,
			worktreePath: workspace,
			projectCommands: [],
		}),
		() => {
			expect(env.container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
			expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
			expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(1);
		},
	);
	expect(result.result).toMatchObject({
		passed: false,
		reason: 'mechanical_check_failed',
		diffStat: { hasChanges: true, filesChanged: 1 },
		zeroConfigLayer: { exitCodeCheck: { passed: false, exitCode: 1 } },
	});
	expect(env.container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
	expect(env.container.repos.tasks.findById('task')?.lane_no).toBeNull();
	expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(1);
	expect(env.count('run.state_changed')).toBe(1);
	expect(env.count('task.gate_waiting')).toBe(1);
	expect(env.count('lane.released')).toBe(1);
});

it.each([false, true])(
	'waits to dispatch one review after a real successful exit (archive during wait: %s)',
	async (archiveWhileWaiting) => {
		const spawned: ManagedProcess[] = [];
		const env = await environment(null, {
			proc: {
				spawnManaged(spec, options) {
					// Replace only the provider executable; process registration, pipes and exit stay real.
					const managed = spawnManaged(
						{
							...spec,
							file: process.execPath,
							args: ['-e', "process.stdout.write('{}\\n');process.stdin.resume();"],
							stdinMode: 'pipe',
						},
						{
							...options,
							platform:
								process.platform === 'win32' || process.platform === 'darwin'
									? process.platform
									: 'linux',
						},
					);
					spawned.push(managed);
					return managed;
				},
			},
		});
		cleanups.push(async () => {
			for (const managed of spawned) {
				if (!managed.isExited) await managed.kill({ graceMs: 50 });
				await managed.finalize();
			}
			if (spawned.length > 0) {
				// The attached review exit finalizer must finish before closing its database.
				await vi.waitFor(
					() =>
						expect(
							env.events.some(
								(event) =>
									event.kind === 'run.state_changed' &&
									event.runId === 'implementation' &&
									'to' in event.payload &&
									event.payload.to === 'awaiting_human',
							),
						).toBe(true),
					{ timeout: 10_000, interval: 10 },
				);
			}
		});
		const workspace = gitWorktree(env);
		env.seed('implementation', 'implement', 'exited');
		env.db
			.prepare(
				"UPDATE dispatch_snapshots SET review_prompt=?, accept_text=?, task_paths_json=? WHERE id='snapshot'",
			)
			.run('Review source.txt', 'Check source.txt', '["source.txt"]');
		if (archiveWhileWaiting)
			env.container.repos.gates?.create({
				id: 'landing',
				task_id: 'task',
				run_id: 'implementation',
				kind: 'landing',
				state: 'waiting',
				created_at: '2026-10-03T10:00:00.000Z',
			});
		const exit = await actualExit(0, workspace);
		await env.pressure();
		const checkArchive = archiveWhileWaiting
			? finishDuringDrain(env, 'implementation', 'landed')
			: null;
		const result = await completesAfterRelease(
			env,
			env.container.services.review.evaluateMechanicalCheck({
				runId: 'implementation',
				exitCode: exit.exitCode,
				worktreePath: workspace,
				projectCommands: [],
			}),
			() => {
				expect(env.admissions).toContain('capacity');
				expect(env.container.repos.runs.findById('implementation')?.state).toBe('reviewing');
				expect(env.container.repos.runs.listAll().filter((run) => run.kind === 'review')).toEqual(
					[],
				);
				expect(spawned).toHaveLength(0);
				expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(
					archiveWhileWaiting ? 1 : 0,
				);
			},
		);
		expect(result.result.passed).toBe(true);
		expect(result.gateCreated).toBe(false);
		if (checkArchive) await checkArchive();
		expect(result.currentState).toBe(archiveWhileWaiting ? 'landed' : 'reviewing');
		expect(env.container.repos.runs.findById('implementation')?.state).toBe(
			archiveWhileWaiting ? 'landed' : 'reviewing',
		);
		const reviews = env.container.repos.runs.listAll().filter((run) => run.kind === 'review');
		expect(reviews).toHaveLength(archiveWhileWaiting ? 0 : 1);
		expect(spawned).toHaveLength(archiveWhileWaiting ? 0 : 1);
		expect(env.count('run.started')).toBe(archiveWhileWaiting ? 0 : 1);
		expect(env.count('task.gate_waiting')).toBe(0);
		expect(env.container.repos.gates?.list({ pendingOnly: true })).toHaveLength(0);
		if (!archiveWhileWaiting) expect(reviews[0]?.state).toBe('running');
	},
);

it.each([
	{ owner: 'request', stopWhileWaiting: false },
	{ owner: 'request', stopWhileWaiting: true },
	{ owner: 'reload', stopWhileWaiting: false },
	{ owner: 'reload', stopWhileWaiting: true },
] as const)(
	'preserves a committed agent config PATCH with $owner owning admission (stop during wait: $stopWhileWaiting)',
	async ({ owner, stopWhileWaiting }) => {
		const env = await environment(null, { agentDefaults: true, availabilityOwner: owner });
		const agents = env.container.services.agents;
		await agents.start();
		expect((await agents.getAgent('codex'))?.isAvailable).toBe(false);
		await env.pressure();
		const closeDatabase = vi.fn(env.closeDatabase);
		let stopped = false;
		let stopping: Promise<void> | undefined;
		let requestSettled = false;
		const request = Promise.resolve(
			env.server.instance.inject({
				method: 'PATCH',
				url: '/api/v1/agents/codex',
				headers: env.headers,
				payload: { execPath: process.execPath },
			}),
		).finally(() => {
			requestSettled = true;
		});
		env.operations.push(request.catch(() => {}));
		await vi.waitFor(
			() => expect(env.availabilityAdmissions.length > 0 || requestSettled).toBe(true),
			{ timeout: 10_000, interval: 10 },
		);
		// A real rejected write is always a failure, even when the HTTP request finished first.
		if (requestSettled || owner === 'reload') expect((await request).statusCode).toBe(200);
		expect(requestSettled).toBe(owner === 'reload');
		expect(env.availabilityAdmissions).toEqual([{ settled: false }]);
		expect(env.admissions).toContain('agent.availability_changed');
		expect(JSON.parse(readFileSync(join(env.dataDir, 'agents.json'), 'utf8'))).toMatchObject({
			overrides: { codex: { execPath: process.execPath } },
		});
		expect(agents.registry.getSnapshot().agents.codex?.execPath).toBe(process.execPath);
		expect(agents.getAvailability('codex')?.isAvailable).toBe(true);
		if (stopWhileWaiting) {
			stopping = agents.stop().then(() => {
				stopped = true;
				closeDatabase();
			});
			env.operations.push(stopping.catch(() => {}));
			await agents.registry.stop();
			await expect(agents.getAgent('codex')).rejects.toThrow('Agent service has stopped.');
		}
		expect(stopped).toBe(false);
		expect(closeDatabase).not.toHaveBeenCalled();
		expect(env.events).toHaveLength(0);
		await env.release();
		const response = await request;
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			agent: { execPath: process.execPath, isAvailable: true },
		});
		await vi.waitFor(() => expect(env.count('agent.availability_changed')).toBe(1), {
			timeout: 10_000,
			interval: 10,
		});
		expect(env.availabilityAdmissions).toEqual([{ settled: true }]);
		expect(env.errors).toEqual([]);
		if (stopWhileWaiting) {
			await stopping;
			expect(stopped).toBe(true);
			expect(closeDatabase).toHaveBeenCalledOnce();
			const completedEventCount = env.events.length;
			await expect(agents.updateAgent('codex', { execPath: 'after-stop' })).rejects.toThrow(
				'Agent service has stopped.',
			);
			expect(env.events).toHaveLength(completedEventCount);
			expect(env.errors).toEqual([]);
		} else {
			expect((await agents.getAgent('codex'))?.isAvailable).toBe(true);
		}
	},
);
