import type { GateSettings } from '@agent-scheduler/shared/api/settings';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { DEFAULT_GATE_SETTINGS, isValidGateSettings } from '../domain/gates.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { SettingsRepo } from '../repo/settings.ts';

export interface SettingsServiceDeps {
	readonly settingsRepo: SettingsRepo;
	readonly clock: { readonly now: () => string };
	readonly bus: EventBus;
	readonly envelopeFactory: EnvelopeFactory;
	readonly unitOfWork: UnitOfWork;
	readonly warn?: (message: string, ...args: unknown[]) => void;
	readonly onGatesUpdated?: (
		newGates: GateSettings,
		previousGates: GateSettings,
		actorDeviceId: string | null,
	) => void;
}

export interface PipelineSettingsSummary {
	readonly bughunt: number;
	readonly wrapupMode: 'auto' | 'manual';
}

const DEFAULT_PIPELINE_SETTINGS: PipelineSettingsSummary = Object.freeze({
	bughunt: 0,
	wrapupMode: 'auto',
});

export interface SettingsService {
	readonly getGates: () => GateSettings;
	readonly updateGates: (input: unknown, actorDeviceId: string | null) => GateSettings;
	readonly getPipeline: () => PipelineSettingsSummary;
}

export function createSettingsService(deps: SettingsServiceDeps): SettingsService {
	const logWarn =
		deps.warn ??
		((message: string, ...args: unknown[]) => {
			console.warn(`[settings] ${message}`, ...args);
		});

	return Object.freeze({
		/**
		 * Retrieves gate settings (E-292):
		 * - If row missing: returns built-in default `{dispatch: 'auto', review: 'manual', landing: 'manual'}` without inserting.
		 * - If value_json is invalid/corrupted: logs warning and falls back to default without overwriting corrupted row.
		 */
		getGates(): GateSettings {
			const row = deps.settingsRepo.get('gates');
			if (!row) {
				return DEFAULT_GATE_SETTINGS;
			}

			try {
				const parsed = JSON.parse(row.value_json);
				if (isValidGateSettings(parsed)) {
					return Object.freeze({
						dispatch: parsed.dispatch,
						review: parsed.review,
						landing: parsed.landing,
					});
				}
				logWarn(
					`Settings row for key='gates' contains invalid fields: ${row.value_json}. Falling back to default.`,
				);
				return DEFAULT_GATE_SETTINGS;
			} catch (cause) {
				logWarn(
					`Settings row for key='gates' has corrupted JSON: ${row.value_json}. Falling back to default.`,
					cause,
				);
				return DEFAULT_GATE_SETTINGS;
			}
		},

		/**
		 * Updates gate settings (E-292, AC 1, AC 2, E-56):
		 * - Requires all three fields ('dispatch', 'review', 'landing') present and strictly 'auto' | 'manual'.
		 * - Rejects missing fields or invalid values with E_VALIDATION.
		 * - Persists atomically in a transaction.
		 * - Emits `settings.gates_changed` event after transaction commits.
		 * - Triggers re-evaluation of waiting gates for changed kinds without restarting batches (E-56).
		 */
		updateGates(input: unknown, actorDeviceId: string | null): GateSettings {
			if (!isValidGateSettings(input)) {
				throw new AppError(
					'E_VALIDATION',
					'Invalid gate settings: all three fields (dispatch, review, landing) must be provided with value "auto" or "manual".',
				);
			}

			const previous = this.getGates();
			const updated: GateSettings = Object.freeze({
				dispatch: input.dispatch,
				review: input.review,
				landing: input.landing,
			});

			const valueJson = JSON.stringify(updated);
			const now = deps.clock.now();

			// Strictly respect transaction boundary: DB write inside transaction, event publish outside
			deps.unitOfWork.run(() => {
				deps.settingsRepo.set('gates', valueJson, now);
			});

			const envelope = deps.envelopeFactory.createEnvelope({
				kind: 'settings.gates_changed',
				actorDeviceId,
				payload: {
					gates: updated,
				},
			});

			deps.bus.publish(envelope);

			// R2 & E-56: Re-evaluate waiting gates for changed kinds without restarting batches
			deps.onGatesUpdated?.(updated, previous, actorDeviceId);

			return updated;
		},

		/**
		 * Safe reader for pipeline settings (M7-T8, M8-T8, E-356):
		 * - Returns built-in default `{bughunt: 0, wrapupMode: 'auto'}` when row is absent or invalid.
		 */
		getPipeline(): PipelineSettingsSummary {
			const row = deps.settingsRepo.get('pipeline');
			if (!row) {
				return DEFAULT_PIPELINE_SETTINGS;
			}

			try {
				const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
				const bughunt = parsed.bughunt === 1 ? 1 : 0;
				const wrapupMode = parsed.wrapupMode === 'manual' ? 'manual' : 'auto';
				return Object.freeze({ bughunt, wrapupMode });
			} catch (cause) {
				logWarn(
					`Settings row for key='pipeline' has corrupted JSON. Falling back to default.`,
					cause,
				);
				return DEFAULT_PIPELINE_SETTINGS;
			}
		},
	});
}
