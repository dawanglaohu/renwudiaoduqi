import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import { beforeEach, describe, expect, it } from 'vitest';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { DEFAULT_GATE_SETTINGS, PRESET_AUTO, PRESET_SEMI_AUTO } from '../../src/domain/gates.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createEventBus } from '../../src/events/bus.ts';
import { createEnvelopeFactory } from '../../src/events/envelope.ts';
import { createRingBuffer } from '../../src/events/ring-buffer.ts';
import { createSettingsRepo } from '../../src/repo/settings.ts';
import { createSettingsService } from '../../src/service/settings.ts';

describe('M8-T4 Settings & Gates Configuration (AC 1, AC 2, E-53, E-56, E-292)', () => {
	let db: DatabaseConnection;

	beforeEach(() => {
		db = openDatabase(':memory:');
		// Ensure settings table exists
		db.exec(`
			CREATE TABLE IF NOT EXISTS settings (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);
	});

	describe('SettingsRepo', () => {
		it('supports basic CRUD and upsert operations in WAL mode', () => {
			const repo = createSettingsRepo(db);

			expect(repo.get('gates')).toBeNull();

			repo.set('gates', JSON.stringify(DEFAULT_GATE_SETTINGS), '2026-09-12T10:00:00.000Z');
			const row = repo.get('gates');
			expect(row).not.toBeNull();
			expect(row?.key).toBe('gates');
			expect(JSON.parse(row?.value_json ?? '{}')).toEqual(DEFAULT_GATE_SETTINGS);
			expect(row?.updated_at).toBe('2026-09-12T10:00:00.000Z');

			// Upsert overwrite
			const updated: GateSettings = { dispatch: 'auto', review: 'auto', landing: 'auto' };
			repo.set('gates', JSON.stringify(updated), '2026-09-12T11:00:00.000Z');
			const updatedRow = repo.get('gates');
			expect(JSON.parse(updatedRow?.value_json ?? '{}')).toEqual(updated);
			expect(updatedRow?.updated_at).toBe('2026-09-12T11:00:00.000Z');

			// Delete
			repo.delete('gates');
			expect(repo.get('gates')).toBeNull();
		});
	});

	describe('SettingsService (E-292, AC 1, AC 2, E-53)', () => {
		function createTestSettingsService(opts?: {
			readonly warnFn?: (msg: string, ...args: unknown[]) => void;
		}) {
			const repo = createSettingsRepo(db);
			const unitOfWork = createUnitOfWork(db);
			const ringBuffer = createRingBuffer();
			const bus = createEventBus({ ringBuffer });
			let seq = 0;
			const envelopeFactory = createEnvelopeFactory({
				clock: { now: () => '2026-09-12T12:00:00.000Z' },
				idAllocator: {
					allocate: () => ++seq,
				},
			});

			const service = createSettingsService({
				settingsRepo: repo,
				clock: { now: () => '2026-09-12T12:00:00.000Z' },
				bus,
				envelopeFactory,
				unitOfWork,
				logger: opts?.warnFn ? { warn: opts.warnFn } : undefined,
			});

			return { service, repo, bus };
		}

		it('AC 2 & E-292: missing row returns built-in default without inserting a row', () => {
			const { service, repo } = createTestSettingsService();

			const gates = service.getGates();
			expect(gates).toEqual({
				dispatch: 'auto',
				review: 'manual',
				landing: 'manual',
			});

			// Assert no row was inserted into SQLite
			expect(repo.get('gates')).toBeNull();
		});

		it('E-292: invalid or corrupted JSON value falls back to default and logs warning without exiting or overwriting', () => {
			const warnCalls: string[] = [];
			const { service, repo } = createTestSettingsService({
				warnFn: (msg) => warnCalls.push(msg),
			});

			// Insert corrupted JSON string
			db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
				'gates',
				'{ corrupted-json !!!',
				'2026-09-12T08:00:00.000Z',
			);

			const gates = service.getGates();
			expect(gates).toEqual(DEFAULT_GATE_SETTINGS);
			expect(warnCalls.length).toBeGreaterThan(0);
			expect(warnCalls[0]).toContain("key='gates' has corrupted JSON");

			// Ensure the bad row is NOT overwritten in DB
			const row = repo.get('gates');
			expect(row?.value_json).toBe('{ corrupted-json !!!');
		});

		it('E-292: invalid field values fall back to default and log warning without overwriting', () => {
			const warnCalls: string[] = [];
			const { service, repo } = createTestSettingsService({
				warnFn: (msg) => warnCalls.push(msg),
			});

			// Insert invalid gate values (e.g. unknown mode)
			db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)').run(
				'gates',
				JSON.stringify({ dispatch: 'invalid_mode', review: 'manual', landing: 'manual' }),
				'2026-09-12T08:00:00.000Z',
			);

			const gates = service.getGates();
			expect(gates).toEqual(DEFAULT_GATE_SETTINGS);
			expect(warnCalls.length).toBeGreaterThan(0);
			expect(warnCalls[0]).toContain("key='gates' contains invalid fields");

			// Ensure raw value is retained until next PATCH
			const row = repo.get('gates');
			expect(row?.value_json).toContain('invalid_mode');
		});

		it('AC 1, AC 2 & E-292: updateGates requires all three fields and returns E_VALIDATION on missing or invalid fields', () => {
			const { service } = createTestSettingsService();

			// Missing 'landing'
			expect(() =>
				service.updateGates({ dispatch: 'auto', review: 'manual' }, 'dev-1'),
			).toThrowError(AppError);
			try {
				service.updateGates({ dispatch: 'auto', review: 'manual' }, 'dev-1');
			} catch (e) {
				expect((e as AppError).code).toBe('E_VALIDATION');
			}

			// Invalid value
			expect(() =>
				service.updateGates({ dispatch: 'auto', review: 'manual', landing: 'sometimes' }, 'dev-1'),
			).toThrowError(AppError);
			try {
				service.updateGates({ dispatch: 'auto', review: 'manual', landing: 'sometimes' }, 'dev-1');
			} catch (e) {
				expect((e as AppError).code).toBe('E_VALIDATION');
			}
		});

		it('AC 1, AC 2, E-53 & E-292: updateGates writes all three fields, supports auto landing, and emits settings.gates_changed', () => {
			const { service, repo, bus } = createTestSettingsService();
			const publishedEnvelopes: unknown[] = [];
			bus.subscribe((env) => {
				publishedEnvelopes.push(env);
			});

			const newGates: GateSettings = {
				dispatch: 'auto',
				review: 'auto',
				landing: 'auto',
			};

			const result = service.updateGates(newGates, 'dev-desktop-1');
			expect(result).toEqual(newGates);

			// Check DB row
			const row = repo.get('gates');
			expect(row).not.toBeNull();
			expect(JSON.parse(row?.value_json ?? '{}')).toEqual(newGates);

			// Check emitted event
			expect(publishedEnvelopes.length).toBe(1);
			const event = publishedEnvelopes[0] as {
				scope: string;
				kind: string;
				actorDeviceId: string;
				payload: { gates: GateSettings };
			};
			expect(event.scope).toBe('settings');
			expect(event.kind).toBe('settings.gates_changed');
			expect(event.actorDeviceId).toBe('dev-desktop-1');
			expect(event.payload.gates).toEqual(newGates);
		});

		it('AC 2: validates presets semi-auto and auto constants match expected values', () => {
			expect(PRESET_SEMI_AUTO).toEqual({
				dispatch: 'auto',
				review: 'manual',
				landing: 'manual',
			});
			expect(PRESET_AUTO).toEqual({
				dispatch: 'auto',
				review: 'auto',
				landing: 'auto',
			});
		});

		it('E-56: mid-flight updates take effect immediately for subsequent getGates() calls', () => {
			const { service } = createTestSettingsService();

			expect(service.getGates()).toEqual(DEFAULT_GATE_SETTINGS);

			service.updateGates({ dispatch: 'manual', review: 'manual', landing: 'manual' }, null);
			expect(service.getGates()).toEqual({
				dispatch: 'manual',
				review: 'manual',
				landing: 'manual',
			});
		});

		it('pipeline summary safe fallback reader (M7-T8, E-356)', () => {
			const { service, repo } = createTestSettingsService();

			// Missing row -> default
			expect(service.getPipeline()).toEqual({ bughunt: 0, wrapupMode: 'auto' });

			// Valid row
			repo.set(
				'pipeline',
				JSON.stringify({ bughunt: 1, wrapupMode: 'manual' }),
				'2026-09-12T12:00:00.000Z',
			);
			expect(service.getPipeline()).toEqual({ bughunt: 1, wrapupMode: 'manual' });
		});
	});
});
