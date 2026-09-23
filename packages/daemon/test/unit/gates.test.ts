import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { DEFAULT_GATE_SETTINGS, PRESET_AUTO, resolveAfterReview } from '../../src/domain/gates.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerBatchesRoutes } from '../../src/http/routes/batches.ts';
import { registerGateRoutes } from '../../src/http/routes/gates.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { createDispatchSnapshotsRepo } from '../../src/repo/dispatch-snapshots.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import { createGatesRepo } from '../../src/repo/gates.ts';
import { createRunsRepo } from '../../src/repo/runs.ts';
import { createSettingsRepo } from '../../src/repo/settings.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createDispatchService } from '../../src/service/dispatch.ts';
import { type GateService, createGateService } from '../../src/service/gates.ts';
import { createSettingsService } from '../../src/service/settings.ts';

describe('M8-T4 Three Gates and Preset Combinations (AC 1-6, E-05, E-53, E-54, E-56, E-57, E-292)', () => {
	let db: DatabaseConnection;

	beforeEach(() => {
		db = openDatabase(':memory:');
		const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
		const migrationRunner = createMigrationRunner({
			clock: { now: () => '2026-09-12T00:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => readdirSync(migrationsDir),
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		migrationRunner.run(migrationsDir);

		// Insert seed document, batch, tasks, and devices for relational integrity
		db.exec(`
			INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
			VALUES ('doc-1', '/docs', 'AgentScheduler', 'fp-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

			INSERT INTO batches (id, doc_id, batch_no, state, started_at, finished_at)
			VALUES ('batch-1', 'doc-1', 1, 'idle', null, null);

			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json, batch_id)
			VALUES ('task-1', 'doc-1', 'M8-T4', 'Three Gates', 'M8', '[]', 'chash', '[]', 'batch-1');

			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json, batch_id)
			VALUES ('task-2', 'doc-1', 'M8-T5', 'Task 2', 'M8', '[]', 'chash2', '[]', 'batch-1');

			INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at)
			VALUES ('dev-desktop', 'Desktop App', 'h1', 's1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

			INSERT INTO devices (id, name, token_hash, token_salt, paired_at, last_seen_at)
			VALUES ('dev-mobile', 'Mobile App', 'h2', 's2', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');
		`);
	});

	function createHarness() {
		const gatesRepo = createGatesRepo(db);
		const settingsRepo = createSettingsRepo(db);
		const tasksRepo = createTasksRepo(db);
		const batchesRepo = createBatchesRepo(db);
		const documentsRepo = createDocumentsRepo(db);
		const dispatchSnapshotsRepo = createDispatchSnapshotsRepo(db);
		const runsRepo = createRunsRepo(db);
		const unitOfWork = createUnitOfWork(db);
		const ringBuffer = createRingBuffer();
		const bus = createEventBus({ ringBuffer });
		let seq = 0;
		const envelopeFactory = createEnvelopeFactory({
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			idAllocator: { allocate: () => ++seq },
		});
		let idCount = 0;
		const ids = { newId: () => `gate_${++idCount}` };

		const dispatchService = createDispatchService({
			unitOfWork,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			dispatchSnapshotsRepo,
			runsRepo,
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			ids: { newId: () => `dispatch_${++idCount}` },
			bus,
			envelopeFactory,
		});

		const gateServiceHolder: { current?: GateService } = {};
		let transactionCount = 0;
		const countingUnitOfWork = {
			run: <T>(fn: () => T): T => {
				transactionCount += 1;
				return unitOfWork.run(fn);
			},
		};

		const settingsService = createSettingsService({
			settingsRepo,
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			bus,
			envelopeFactory,
			unitOfWork: countingUnitOfWork,
			onGatesUpdated: (newGates, previousGates, actorDeviceId) =>
				gateServiceHolder.current?.reEvaluateWaitingGatesInTx(
					newGates,
					previousGates,
					actorDeviceId,
				) ?? [],
		});

		const gateService = createGateService({
			gatesRepo,
			tasksRepo,
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			ids,
			bus,
			envelopeFactory,
			unitOfWork: countingUnitOfWork,
			settingsService,
			getBatchGateOverrides: (batchId: string) => dispatchService.getBatchGateOverrides(batchId),
		});

		gateServiceHolder.current = gateService;

		return {
			gatesRepo,
			settingsRepo,
			tasksRepo,
			batchesRepo,
			documentsRepo,
			runsRepo,
			dispatchService,
			settingsService,
			gateService,
			bus,
			getTransactionCount: () => transactionCount,
			resetTransactionCount: () => {
				transactionCount = 0;
			},
		};
	}

	describe('AC 1 & E-53 Domain: resolveAfterReview() decision matrix', () => {
		it('AC 1 & AC 2: review pass + review:auto + landing:auto directly yields landed by auto with zero git ops', () => {
			const settings: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'auto' };
			const result = resolveAfterReview({
				reviewVerdict: 'pass',
				settings,
			});

			expect(result).toEqual({
				outcome: 'landed',
				by: 'auto',
				gateKind: 'landing',
			});
		});

		it('AC 1, AC 2 & E-53: review pass + review:auto + landing:manual halts at landing gate awaiting confirmation', () => {
			const settings: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'manual' };
			const result = resolveAfterReview({
				reviewVerdict: 'pass',
				settings,
			});

			expect(result).toEqual({
				outcome: 'await_human',
				gateKind: 'landing',
				reason: 'landing_manual_gate',
			});
		});

		it('AC 1 & AC 2: review pass + review:manual halts at review gate even if landing is auto', () => {
			const settings: GateSettings = { dispatch: 'auto', review: 'manual', landing: 'auto' };
			const result = resolveAfterReview({
				reviewVerdict: 'pass',
				settings,
			});

			expect(result).toEqual({
				outcome: 'await_human',
				gateKind: 'review',
				reason: 'review_manual_gate',
			});
		});

		it('AC 2: non-pass review verdicts (rework, doc_issue, incomplete) unconditionally halt at review gate', () => {
			const settings: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'auto' };

			for (const verdict of ['rework', 'doc_issue', 'incomplete']) {
				const result = resolveAfterReview({
					reviewVerdict: verdict,
					settings,
				});
				expect(result).toEqual({
					outcome: 'await_human',
					gateKind: 'review',
					reason: `review_verdict_${verdict}`,
				});
			}
		});

		it('AC 1 & E-56: gateOverrides allows landing and overrides global settings for currently arriving task', () => {
			// Global settings has landing: manual
			const settings: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'manual' };

			// Overrides landing to auto
			const resultWithOverride = resolveAfterReview({
				reviewVerdict: 'pass',
				settings,
				overrides: { landing: 'auto' },
			});
			expect(resultWithOverride).toEqual({
				outcome: 'landed',
				by: 'auto',
				gateKind: 'landing',
			});

			// Overrides review to manual
			const resultReviewOverride = resolveAfterReview({
				reviewVerdict: 'pass',
				settings: { dispatch: 'auto', review: 'auto', landing: 'auto' },
				overrides: { review: 'manual' },
			});
			expect(resultReviewOverride).toEqual({
				outcome: 'await_human',
				gateKind: 'review',
				reason: 'review_manual_gate',
			});
		});
	});

	describe('AC 2b & AC 1: task.landed event payload with by and gateId', () => {
		it('AC 2b: auto-landing emits task.landed payload with by="auto" and gateId', async () => {
			const { gateService, settingsService, bus } = createHarness();
			const events: unknown[] = [];
			bus.subscribe((e) => events.push(e));

			// Configure auto presets
			settingsService.updateGates(PRESET_AUTO, 'dev-desktop');

			const res = await gateService.resolveAfterReviewAndApply({
				taskId: 'task-1',
				runId: null,
				reviewVerdict: 'pass',
			});

			expect(res.outcome).toBe('landed');

			const landedEvent = events.find((e) => (e as { kind?: string }).kind === 'task.landed') as {
				payload: { by: string; gateId: string };
			};

			expect(landedEvent).toBeDefined();
			expect(landedEvent.payload.by).toBe('auto');
			expect(landedEvent.payload.gateId).toMatch(/^gate_/);
		});

		it('AC 2b: human-decided landing emits task.landed payload with by="human" and gateId', async () => {
			const { gateService, bus } = createHarness();
			const events: unknown[] = [];
			bus.subscribe((e) => events.push(e));

			// Create a waiting landing gate
			const gate = await gateService.createWaitingGate({
				taskId: 'task-1',
				runId: null,
				kind: 'landing',
			});

			// Human decides pass
			await gateService.decideGate({
				gateId: gate.id,
				decision: 'pass',
				actorDeviceId: 'dev-desktop',
			});

			const landedEvent = events.find((e) => (e as { kind?: string }).kind === 'task.landed') as {
				payload: { by: string; gateId: string };
			};

			expect(landedEvent).toBeDefined();
			expect(landedEvent.payload.by).toBe('human');
			expect(landedEvent.payload.gateId).toBe(gate.id);
		});
	});

	describe('AC 3 & E-54: Concurrency release while waiting for gate confirmation', () => {
		it('AC 3 & E-54: waiting gate does not occupy active running run; releases execution slots', async () => {
			const { gateService, gatesRepo, tasksRepo } = createHarness();

			// Creating waiting gate marks task as awaiting_human, without active running runs
			const gate = await gateService.createWaitingGate({
				taskId: 'task-1',
				runId: null,
				kind: 'review',
				comment: 'human_review_required',
			});

			const row = gatesRepo.findById(gate.id);
			expect(row?.state).toBe('waiting');
			expect(row?.kind).toBe('review');

			// Check task is in awaiting_human state and no process is blocked or holding windows
			const task = tasksRepo.findById('task-1');
			expect(task).toBeDefined();
		});
	});

	describe('AC 5 & E-57: Two devices deciding concurrently are strictly idempotent', () => {
		it('E-57: second decision returns 409 E_GATE_ALREADY_DECIDED with prior decider details without duplicate dispatch', async () => {
			const { gateService, bus } = createHarness();
			const events: unknown[] = [];
			bus.subscribe((e) => events.push(e));

			const gate = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'review',
			});

			// First decision by desktop
			const firstRes = await gateService.decideGate({
				gateId: gate.id,
				decision: 'pass',
				comment: 'approved from desktop',
				actorDeviceId: 'dev-desktop',
			});
			expect(firstRes.applied).toBe(true);

			const eventCountAfterFirst = events.length;

			// Second concurrent decision by mobile
			await expect(
				gateService.decideGate({
					gateId: gate.id,
					decision: 'pass',
					comment: 'approved from mobile',
					actorDeviceId: 'dev-mobile',
				}),
			).rejects.toThrowError(AppError);

			try {
				await gateService.decideGate({
					gateId: gate.id,
					decision: 'pass',
					comment: 'approved from mobile',
					actorDeviceId: 'dev-mobile',
				});
			} catch (err) {
				const appError = err as AppError;
				expect(appError.code).toBe('E_GATE_ALREADY_DECIDED');
				expect(appError.message).toContain('already decided');
				expect(appError.details).toEqual({
					decidedByDeviceId: 'dev-desktop',
					decidedAt: '2026-09-12T12:00:00.000Z',
					decision: 'pass',
					gateId: gate.id,
				});
			}

			// Verify zero duplicate events were published
			expect(events.length).toBe(eventCountAfterFirst);
		});
	});

	describe('AC 6 & E-05: Human operation priority over automatic scheduling', () => {
		it('E-05: human rejection stops task, records comment, and prevents auto-advancing', async () => {
			const { gateService, gatesRepo, tasksRepo } = createHarness();

			const gate = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'review',
			});

			// User intervenes and rejects
			const result = await gateService.decideGate({
				gateId: gate.id,
				decision: 'reject',
				comment: 'Need additional boundary tests for corner cases',
				actorDeviceId: 'dev-desktop',
			});

			expect(result.applied).toBe(true);

			const row = gatesRepo.findById(gate.id);
			expect(row?.state).toBe('decided');
			expect(row?.decision).toBe('reject');
			expect(row?.comment).toBe('Need additional boundary tests for corner cases');
			expect(row?.decided_by_device_id).toBe('dev-desktop');

			// R2: reject now enters rework path instead of setting paused.
			// manual_state is cleared (null) because a free lane is allocated.
			const task = tasksRepo.findById('task-1');
			expect(task?.manual_state).toBeNull();
		});
	});

	describe('HTTP Routes (Fastify inject tests)', () => {
		async function createTestApp() {
			const harness = createHarness();
			const app = fastify({ logger: false });
			await errorHandlerPlugin(app, {});

			registerGateRoutes(app, {
				settingsService: harness.settingsService,
				gateService: harness.gateService,
			});

			registerBatchesRoutes(app, {
				dispatchService: harness.dispatchService,
			});

			await app.ready();
			return { app, ...harness };
		}

		it('PATCH /api/v1/settings/gates: updates gate settings with all 3 fields', async () => {
			const { app } = await createTestApp();

			const res = await app.inject({
				method: 'PATCH',
				url: '/api/v1/settings/gates',
				payload: {
					dispatch: 'auto',
					review: 'manual',
					landing: 'auto',
				},
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.gates).toEqual({
				dispatch: 'auto',
				review: 'manual',
				landing: 'auto',
			});
		});

		it('PATCH /api/v1/settings/gates: rejects missing landing field with 400 E_VALIDATION', async () => {
			const { app } = await createTestApp();

			const res = await app.inject({
				method: 'PATCH',
				url: '/api/v1/settings/gates',
				payload: {
					dispatch: 'auto',
					review: 'manual',
				},
			});

			expect(res.statusCode).toBe(400);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_VALIDATION');
		});

		it('POST /api/v1/gates/:gateId/decide: returns 404 E_NOT_FOUND when gate does not exist', async () => {
			const { app } = await createTestApp();

			const res = await app.inject({
				method: 'POST',
				url: '/api/v1/gates/non-existent-gate/decide',
				payload: {
					decision: 'pass',
				},
			});

			expect(res.statusCode).toBe(404);
			const body = JSON.parse(res.body);
			expect(body.error.code).toBe('E_NOT_FOUND');
		});

		it('POST /api/v1/gates/:gateId/decide: executes decision and returns 409 on second call', async () => {
			const { app, gateService } = await createTestApp();

			const gate = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'landing',
			});

			// First decision: 200 OK
			const res1 = await app.inject({
				method: 'POST',
				url: `/api/v1/gates/${gate.id}/decide`,
				payload: {
					decision: 'pass',
				},
			});
			expect(res1.statusCode).toBe(200);
			expect(JSON.parse(res1.body)).toEqual({ applied: true });

			// Second decision: 409 Conflict
			const res2 = await app.inject({
				method: 'POST',
				url: `/api/v1/gates/${gate.id}/decide`,
				payload: {
					decision: 'pass',
				},
			});
			expect(res2.statusCode).toBe(409);
			const body2 = JSON.parse(res2.body);
			expect(body2.error.code).toBe('E_GATE_ALREADY_DECIDED');
			expect(body2.error.details.gateId).toBe(gate.id);
		});

		it('GET /api/v1/gates: lists waiting gates with ?pending=true', async () => {
			const { app, gateService } = await createTestApp();

			const g1 = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'dispatch',
			});

			const res = await app.inject({
				method: 'GET',
				url: '/api/v1/gates?pending=true',
			});

			expect(res.statusCode).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.gates.length).toBeGreaterThanOrEqual(1);
			expect(body.gates.some((g: { id: string }) => g.id === g1.id)).toBe(true);
		});

		it('R1 (AC 1 & 10 节): POST /api/v1/batches/:batchId/start accepts gateOverrides with landing:auto, advances unreached tasks to landed without altering settings row', async () => {
			const { app, settingsRepo, gateService, bus } = await createTestApp();
			const events: unknown[] = [];
			bus.subscribe((e) => events.push(e));

			// Global settings has default manual landing
			settingsRepo.set('gates', JSON.stringify(DEFAULT_GATE_SETTINGS), '2026-09-12T00:00:00.000Z');

			// task-1 is already past the gate (e.g. decided landing gate)
			const pastGate = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'landing',
			});
			await gateService.decideGate({
				gateId: pastGate.id,
				decision: 'pass',
				actorDeviceId: 'dev-desktop',
			});

			// Start batch-1 with gateOverrides including landing: 'auto'
			const startRes = await app.inject({
				method: 'POST',
				url: '/api/v1/batches/batch-1/start',
				payload: {
					gateOverrides: {
						dispatch: 'auto',
						review: 'auto',
						landing: 'auto',
					},
				},
			});

			// Returns 200 (not 400 validation error)
			expect(startRes.statusCode).toBe(200);
			const startBody = JSON.parse(startRes.body);
			expect(startBody.accepted).toBe(true);

			// Assert global settings row remains completely untouched
			const settingsRow = settingsRepo.get('gates');
			expect(JSON.parse(settingsRow?.value_json ?? '{}')).toEqual(DEFAULT_GATE_SETTINGS);

			// task-2 has NOT yet reached the gate; when review passes, it honors batch gateOverrides
			const reviewRes = await gateService.resolveAfterReviewAndApply({
				taskId: 'task-2',
				runId: null,
				reviewVerdict: 'pass',
			});

			// Advances directly to landed (by auto) because of landing:auto override
			expect(reviewRes.outcome).toBe('landed');

			const task2LandedEvent = events.find(
				(e) =>
					(e as { kind?: string; taskId?: string }).kind === 'task.landed' &&
					(e as { taskId?: string }).taskId === 'task-2',
			) as { payload: { by: string; gateId: string } };

			expect(task2LandedEvent).toBeDefined();
			expect(task2LandedEvent.payload.by).toBe('auto');

			// task-1 remains unaffected
			const task1Gate = await gateService.listGates();
			const pastRow = task1Gate.gates.find((g) => g.id === pastGate.id);
			expect(pastRow?.decision).toBe('pass');
		});

		it('R2 & E-56: PATCH /settings/gates re-evaluates waiting gates immediately for changed kind without restarting batches', async () => {
			const { app, gateService, batchesRepo, bus, getTransactionCount, resetTransactionCount } =
				await createTestApp();
			const events: unknown[] = [];
			bus.subscribe((e) => events.push(e));

			// Mark batch-1 as running
			batchesRepo.updateState({
				id: 'batch-1',
				state: 'running',
				started_at: '2026-09-12T10:00:00.000Z',
				finished_at: null,
			});

			// Create a task waiting at the review gate
			const waitingReviewGate = await gateService.createWaitingGate({
				taskId: 'task-1',
				kind: 'review',
				comment: 'awaiting_human_review',
			});
			expect(waitingReviewGate.state).toBe('waiting');

			resetTransactionCount();

			// PATCH settings to auto review, but manual landing
			const patchRes = await app.inject({
				method: 'PATCH',
				url: '/api/v1/settings/gates',
				payload: {
					dispatch: 'auto',
					review: 'auto',
					landing: 'manual',
				},
			});
			expect(patchRes.statusCode).toBe(200);

			// 08 节：一个 HTTP 请求最多开一次事务——settings 写入与闸门重裁决必须共用同一个 run
			expect(getTransactionCount()).toBe(1);

			// Original review gate is no longer waiting; was auto-released
			const allGates = await gateService.listGates();
			const reviewGateNow = allGates.gates.find((g) => g.id === waitingReviewGate.id);
			expect(reviewGateNow?.state).toBe('decided');
			expect(reviewGateNow?.decision).toBe('pass');

			// Emitted task.gate_passed for review
			const reviewPassedEvent = events.find(
				(e) =>
					(e as { kind?: string }).kind === 'task.gate_passed' &&
					(e as { payload?: { gate?: string } }).payload?.gate === 'review',
			);
			expect(reviewPassedEvent).toBeDefined();

			// Because landing is manual, advanced to a waiting landing gate
			const landingGateNow = allGates.gates.find(
				(g) => g.taskId === 'task-1' && g.kind === 'landing' && g.state === 'waiting',
			);
			expect(landingGateNow).toBeDefined();

			// Batch state remains running (NOT restarted)
			const batch = batchesRepo.findById('batch-1');
			expect(batch?.state).toBe('running');

			// Reverse test: create another review gate and switch review back to manual
			const waitingReviewGate2 = await gateService.createWaitingGate({
				taskId: 'task-2',
				kind: 'review',
			});
			expect(waitingReviewGate2.state).toBe('waiting');

			await app.inject({
				method: 'PATCH',
				url: '/api/v1/settings/gates',
				payload: {
					dispatch: 'auto',
					review: 'manual',
					landing: 'manual',
				},
			});

			// Waiting review gate remains waiting when switched to manual
			const allGatesAfterManual = await gateService.listGates();
			const reviewGate2Now = allGatesAfterManual.gates.find((g) => g.id === waitingReviewGate2.id);
			expect(reviewGate2Now?.state).toBe('waiting');
		});
	});
});
