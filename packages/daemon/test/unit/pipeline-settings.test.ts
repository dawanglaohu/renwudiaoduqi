import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import {
	DEFAULT_PIPELINE_SETTINGS,
	isValidPipelineSettings,
	isValidWrapupAssignment,
	parsePipelineSettings,
} from '../../src/domain/pipeline-settings.ts';
import type { EventBus } from '../../src/events/bus.ts';
import type { EnvelopeFactory } from '../../src/events/envelope.ts';
import { createSettingsRepo } from '../../src/repo/settings.ts';
import { createSettingsService } from '../../src/service/settings.ts';

describe('M8-T8 & M8-T9 Pipeline Settings Unit Tests (AC 5, E-318, E-356)', () => {
	it('isValidPipelineSettings validates strict 4-field shape and rejects unknown or missing fields', () => {
		const validFull = {
			bughunt: 0,
			wrapupMode: 'auto',
			reviewOverride: null,
			wrapupAssignment: { mode: 'follow' },
		};
		expect(isValidPipelineSettings(validFull)).toBe(true);

		// Four keys missing one -> false
		expect(
			isValidPipelineSettings({
				bughunt: 0,
				wrapupMode: 'auto',
				reviewOverride: null,
			}),
		).toBe(false);

		// Invalid bughunt value
		expect(isValidPipelineSettings({ ...validFull, bughunt: 2 })).toBe(false);
		expect(isValidPipelineSettings({ ...validFull, bughunt: '0' })).toBe(false);

		// Invalid wrapupMode
		expect(isValidPipelineSettings({ ...validFull, wrapupMode: 'disabled' })).toBe(false);

		// Additional properties (E-356, additionalProperties: false)
		expect(isValidPipelineSettings({ ...validFull, extra: true })).toBe(false);

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

	it('legacy 2-key row supplements default reviewOverride and wrapupAssignment on read without modifying database', () => {
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
		} as unknown as EventBus;
		const envelopeFactory = {
			createEnvelope: vi.fn(),
		} as unknown as EnvelopeFactory;

		settingsRepo.set(
			'pipeline',
			JSON.stringify({ bughunt: 1, wrapupMode: 'manual' }),
			'2026-09-01T00:00:00.000Z',
		);

		const service = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
		});

		const pipeline = service.getPipeline();
		expect(pipeline).toEqual({
			bughunt: 1,
			wrapupMode: 'manual',
			reviewOverride: null,
			wrapupAssignment: { mode: 'follow' },
		});

		// Ensure raw DB row is untouched
		const rawRow = settingsRepo.get('pipeline');
		expect(JSON.parse(rawRow?.value_json ?? '{}')).toEqual({ bughunt: 1, wrapupMode: 'manual' });
	});

	it('rejects a legacy-looking row with unknown keys instead of keeping its non-default switches', () => {
		const warn = vi.fn();
		const malformed = JSON.stringify({ bughunt: 1, wrapupMode: 'manual', unexpected: true });

		expect(parsePipelineSettings(malformed, warn)).toEqual(DEFAULT_PIPELINE_SETTINGS);
		expect(warn).toHaveBeenCalledOnce();
	});

	it('wrapupAssignment validates follow mode and fixed mode, rejecting mixed shapes', () => {
		// Shape 1: follow mode
		expect(isValidWrapupAssignment({ mode: 'follow' })).toBe(true);

		// Shape 2: fixed mode
		expect(isValidWrapupAssignment({ mode: 'fixed', agentId: 'codex' })).toBe(true);
		expect(
			isValidWrapupAssignment({
				mode: 'fixed',
				agentId: 'claude',
				modelName: 'claude-3-7-sonnet',
				effortTier: 'high',
			}),
		).toBe(true);

		// Mixed shape: follow mode with agentId -> rejected
		expect(isValidWrapupAssignment({ mode: 'follow', agentId: 'codex' })).toBe(false);

		// Missing agentId in fixed mode -> rejected
		expect(isValidWrapupAssignment({ mode: 'fixed' })).toBe(false);
		expect(isValidWrapupAssignment({ mode: 'fixed', agentId: '' })).toBe(false);
	});

	it('SettingsService.updatePipeline enforces registry checks: missing agentId throws 400 with details.field', () => {
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
		const bus = { publish: vi.fn() } as unknown as EventBus;
		const envelopeFactory = { createEnvelope: vi.fn() } as unknown as EnvelopeFactory;

		const mockRegistry = {
			getSnapshot: () => ({
				agents: {
					codex: { effortVendorMap: { low: 'low', medium: 'medium', high: 'high' } },
					dsh: { effortVendorMap: null }, // no effort support
				},
			}),
		};

		const service = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			agentRegistry: mockRegistry,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
		});

		// 1. reviewOverride.agentId not in registry -> E_VALIDATION with field 'reviewOverride.agentId'
		expect(() =>
			service.updatePipeline(
				{
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: { agentId: 'nonexistent' },
					wrapupAssignment: { mode: 'follow' },
				},
				null,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'E_VALIDATION',
				details: expect.objectContaining({ field: 'reviewOverride.agentId' }),
			}),
		);

		// 2. wrapupAssignment.agentId not in registry -> E_VALIDATION with field 'wrapupAssignment.agentId'
		expect(() =>
			service.updatePipeline(
				{
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: null,
					wrapupAssignment: { mode: 'fixed', agentId: 'nonexistent' },
				},
				null,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'E_VALIDATION',
				details: expect.objectContaining({ field: 'wrapupAssignment.agentId' }),
			}),
		);

		// 3. dsh configured with effortTier -> effort_unsupported
		expect(() =>
			service.updatePipeline(
				{
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: { agentId: 'dsh', effortTier: 'high' },
					wrapupAssignment: { mode: 'follow' },
				},
				null,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'E_VALIDATION',
				details: expect.objectContaining({
					field: 'reviewOverride.effortTier',
					reason: 'effort_unsupported',
				}),
			}),
		);

		// 4. Missing required key -> E_VALIDATION
		expect(() =>
			service.updatePipeline(
				{
					bughunt: 0,
					wrapupMode: 'auto',
					reviewOverride: null,
				},
				null,
			),
		).toThrowError(
			expect.objectContaining({
				code: 'E_VALIDATION',
			}),
		);
	});

	it('SettingsService.updatePipeline persists valid 4-key settings, emits event and triggers nudge', () => {
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

		const mockRegistry = {
			getSnapshot: () => ({
				agents: {
					codex: { effortVendorMap: { low: 'low', medium: 'medium', high: 'high' } },
				},
			}),
		};

		const service = createSettingsService({
			settingsRepo,
			unitOfWork,
			bus,
			envelopeFactory,
			nudgeTick,
			agentRegistry: mockRegistry,
			clock: { now: () => '2026-09-17T12:00:00.000Z' },
		});

		const fullValid = {
			bughunt: 1 as const,
			wrapupMode: 'manual' as const,
			reviewOverride: { agentId: 'codex', modelName: null, effortTier: 'high' as const },
			wrapupAssignment: { mode: 'follow' as const },
		};

		const updated = service.updatePipeline(fullValid, 'dev-1');
		expect(updated).toEqual(fullValid);
		expect(nudgeTick).toHaveBeenCalledTimes(1);

		expect(published).toHaveLength(1);
		expect(published[0]?.kind).toBe('settings.pipeline_changed');
		expect(published[0]?.payload).toEqual({ pipeline: fullValid });

		expect(service.getPipeline()).toEqual(fullValid);
	});
});
