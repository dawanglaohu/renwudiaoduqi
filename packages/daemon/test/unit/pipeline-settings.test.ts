import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import {
	DEFAULT_PIPELINE_SETTINGS,
	isValidPipelineSettings,
	parsePipelineSettings,
} from '../../src/domain/pipeline-settings.ts';
import { AppError } from '../../src/errors/app-error.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import { createSettingsRepo } from '../../src/repo/settings.ts';
import { createSettingsService } from '../../src/service/settings.ts';

describe('M8-T8 Pipeline Settings Unit Tests (AC 5, E-318)', () => {
	it('isValidPipelineSettings validates strict 2-field shape and rejects unknown or missing fields', () => {
		expect(isValidPipelineSettings({ bughunt: 0, wrapupMode: 'auto' })).toBe(true);
		expect(isValidPipelineSettings({ bughunt: 1, wrapupMode: 'manual' })).toBe(true);

		// Invalid bughunt value
		expect(isValidPipelineSettings({ bughunt: 2, wrapupMode: 'auto' })).toBe(false);
		expect(isValidPipelineSettings({ bughunt: '0', wrapupMode: 'auto' })).toBe(false);

		// Invalid wrapupMode
		expect(isValidPipelineSettings({ bughunt: 0, wrapupMode: 'disabled' })).toBe(false);

		// Missing field
		expect(isValidPipelineSettings({ bughunt: 0 })).toBe(false);
		expect(isValidPipelineSettings({ wrapupMode: 'auto' })).toBe(false);

		// Additional properties (E-318, additionalProperties: false)
		expect(isValidPipelineSettings({ bughunt: 0, wrapupMode: 'auto', extra: true })).toBe(false);

		// Non-object
		expect(isValidPipelineSettings(null)).toBe(false);
		expect(isValidPipelineSettings([])).toBe(false);
		expect(isValidPipelineSettings('settings')).toBe(false);
	});

	it('parsePipelineSettings returns default on missing or corrupted row without throwing', () => {
		const warnings: string[] = [];
		const logWarn = (msg: string) => warnings.push(msg);

		// Missing or empty row
		expect(parsePipelineSettings(null, logWarn)).toEqual(DEFAULT_PIPELINE_SETTINGS);
		expect(parsePipelineSettings(undefined, logWarn)).toEqual(DEFAULT_PIPELINE_SETTINGS);
		expect(parsePipelineSettings('', logWarn)).toEqual(DEFAULT_PIPELINE_SETTINGS);
		expect(warnings).toHaveLength(0);

		// Corrupted JSON
		const badJsonResult = parsePipelineSettings('{bad json', logWarn);
		expect(badJsonResult).toEqual(DEFAULT_PIPELINE_SETTINGS);
		expect(warnings.length).toBeGreaterThan(0);

		// Invalid values in JSON
		const invalidResult = parsePipelineSettings('{"bughunt": 99, "wrapupMode": "auto"}', logWarn);
		expect(invalidResult).toEqual(DEFAULT_PIPELINE_SETTINGS);
	});

	it('SettingsService.getPipeline returns default without inserting row into DB when absent', () => {
		const db = openDatabase(':memory:');
		db.exec(`
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);

		const settingsRepo = createSettingsRepo(db);
		const unitOfWork = createUnitOfWork(db);
		const bus = {
			publish: vi.fn(),
			subscribe: vi.fn(),
			subscribeWithFilter: vi.fn(),
			listenerCount: vi.fn(),
		} as unknown as EventBus;
		const envelopeFactory = {
			createEnvelope: vi.fn(),
		} as unknown as EnvelopeFactory;

		const service = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
		});

		const result = service.getPipeline();
		expect(result).toEqual({ bughunt: 0, wrapupMode: 'auto' });

		// DB row must not be inserted on read
		expect(settingsRepo.get('pipeline')).toBeNull();
	});

	it('SettingsService.updatePipeline persists valid settings, emits event and triggers nudge', () => {
		const db = openDatabase(':memory:');
		db.exec(`
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
		`);

		const settingsRepo = createSettingsRepo(db);
		const unitOfWork = createUnitOfWork(db);
		const published: EventEnvelope[] = [];
		const bus = {
			publish: vi.fn((env: EventEnvelope) => published.push(env)),
			subscribe: vi.fn(),
			subscribeWithFilter: vi.fn(),
			listenerCount: vi.fn(),
		} as unknown as EventBus;
		const envelopeFactory = {
			createEnvelope: vi.fn(
				(opts: { kind: string; actorDeviceId?: string | null; payload?: unknown }) => ({
					id: 1,
					ts: '2026-09-17T12:00:00.000Z',
					runId: null,
					taskId: null,
					scope: 'settings',
					kind: opts.kind,
					seq: 0,
					actorDeviceId: opts.actorDeviceId ?? null,
					payload: opts.payload,
				}),
			),
		} as unknown as EnvelopeFactory;
		const nudgeTick = vi.fn();

		const service = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			nudgeTick,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
		});

		// Valid update
		const updated = service.updatePipeline({ bughunt: 1, wrapupMode: 'manual' }, 'dev-1');
		expect(updated).toEqual({ bughunt: 1, wrapupMode: 'manual' });
		expect(nudgeTick).toHaveBeenCalledTimes(1);

		// Event check
		expect(published).toHaveLength(1);
		expect(published[0]?.kind).toBe('settings.pipeline_changed');
		expect(published[0]?.scope).toBe('settings');
		expect(published[0]?.payload).toEqual({ pipeline: { bughunt: 1, wrapupMode: 'manual' } });

		// DB check
		const row = settingsRepo.get('pipeline');
		expect(row).not.toBeNull();
		expect(JSON.parse(row?.value_json ?? '{}')).toEqual({ bughunt: 1, wrapupMode: 'manual' });

		// Re-read via getPipeline
		expect(service.getPipeline()).toEqual({ bughunt: 1, wrapupMode: 'manual' });

		// Rejects invalid update with E_VALIDATION
		expect(() => service.updatePipeline({ bughunt: 2, wrapupMode: 'auto' }, null)).toThrowError(
			AppError,
		);
		expect(() => service.updatePipeline({ bughunt: 0 }, null)).toThrowError(AppError);
	});
});
