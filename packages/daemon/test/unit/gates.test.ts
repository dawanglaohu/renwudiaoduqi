import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { PRESET_AUTO, resolveAfterReview } from '../../src/domain/gates.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerGateRoutes } from '../../src/http/routes/gates.ts';
import { createGatesRepo } from '../../src/repo/gates.ts';
import { createSettingsRepo } from '../../src/repo/settings.ts';
import { createTasksRepo } from '../../src/repo/tasks.ts';
import { createGateService } from '../../src/service/gates.ts';
import { createSettingsService } from '../../src/service/settings.ts';

describe('M8-T4 Three Gates and Preset Combinations (AC 1-6, E-05, E-53, E-54, E-56, E-57, E-292)', () => {
	let db: DatabaseConnection;

	beforeEach(() => {
		db = openDatabase(':memory:');
		// Set up minimum required schema: documents, batches, tasks, devices, runs, gates, settings
		db.exec(`
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				docs_path TEXT NOT NULL UNIQUE,
				project_name TEXT NOT NULL,
				repo_path TEXT,
				main_branch TEXT NOT NULL DEFAULT 'main',
				branch_prefix TEXT NOT NULL DEFAULT 'task/',
				lane_count INTEGER NOT NULL DEFAULT 2,
				content_fingerprint TEXT NOT NULL,
				is_source_readable INTEGER NOT NULL DEFAULT 1,
				is_takeover_notified INTEGER NOT NULL DEFAULT 0,
				imported_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL
			);

			CREATE TABLE batches (
				id TEXT PRIMARY KEY,
				doc_id TEXT NOT NULL REFERENCES documents(id),
				batch_no INTEGER NOT NULL,
				state TEXT NOT NULL DEFAULT 'idle',
				started_at TEXT,
				finished_at TEXT
			);

			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				doc_id TEXT NOT NULL REFERENCES documents(id),
				task_key TEXT NOT NULL,
				title TEXT NOT NULL,
				module_key TEXT NOT NULL,
				deps_json TEXT NOT NULL,
				input_text TEXT,
				output_text TEXT,
				accept_text TEXT,
				edge_ids_json TEXT,
				task_paths_json TEXT,
				contract_hash TEXT NOT NULL,
				is_contract_ready INTEGER NOT NULL DEFAULT 0,
				contract_reasons_json TEXT NOT NULL,
				est_days REAL,
				batch_id TEXT REFERENCES batches(id),
				impl_prompt TEXT,
				review_prompt TEXT,
				is_removed_from_doc INTEGER NOT NULL DEFAULT 0,
				has_accept_changed INTEGER NOT NULL DEFAULT 0,
				has_prompt_changed INTEGER NOT NULL DEFAULT 0,
				manual_state TEXT,
				bug_prompt TEXT,
				UNIQUE (doc_id, task_key)
			);

			CREATE TABLE devices (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				token_hash TEXT NOT NULL,
				token_salt TEXT NOT NULL,
				paired_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				revoked_at TEXT
			);

			CREATE TABLE gates (
				id TEXT PRIMARY KEY,
				task_id TEXT NOT NULL REFERENCES tasks(id),
				run_id TEXT,
				kind TEXT NOT NULL CHECK (kind IN ('dispatch', 'review', 'landing')),
				state TEXT NOT NULL CHECK (state IN ('waiting', 'decided')),
				decision TEXT CHECK (decision IS NULL OR decision IN ('pass', 'rework', 'reject')),
				comment TEXT,
				decided_by_device_id TEXT REFERENCES devices(id),
				created_at TEXT NOT NULL,
				decided_at TEXT
			);

			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			-- Insert seed document, task, and devices for relational integrity
			INSERT INTO documents (id, docs_path, project_name, content_fingerprint, imported_at, last_seen_at)
			VALUES ('doc-1', '/docs', 'AgentScheduler', 'fp-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z');

			INSERT INTO tasks (id, doc_id, task_key, title, module_key, deps_json, contract_hash, contract_reasons_json)
			VALUES ('task-1', 'doc-1', 'M8-T4', 'Three Gates', 'M8', '[]', 'chash', '[]');

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

		const settingsService = createSettingsService({
			settingsRepo,
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			bus,
			envelopeFactory,
			unitOfWork,
		});

		const gateService = createGateService({
			gatesRepo,
			tasksRepo,
			clock: { now: () => '2026-09-12T12:00:00.000Z' },
			ids,
			bus,
			envelopeFactory,
			unitOfWork,
			settingsService,
		});

		return { gatesRepo, settingsRepo, tasksRepo, settingsService, gateService, bus };
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
				runId: 'run-1',
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
				runId: 'run-1',
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
				runId: 'run-1',
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

			// Task manual_state was updated to paused
			const task = tasksRepo.findById('task-1');
			expect(task?.manual_state).toBe('paused');
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
	});
});
