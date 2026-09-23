import type { PipelineSettings } from '@agent-scheduler/shared/api/settings';

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = Object.freeze({
	bughunt: 0,
	wrapupMode: 'auto',
});

const ALLOWED_KEYS = new Set(['bughunt', 'wrapupMode']);

/**
 * Validates whether an unknown value conforms strictly to PipelineSettings (E-318, AC 5):
 * - bughunt must be 0 | 1
 * - wrapupMode must be 'auto' | 'manual'
 * - strictly no additional properties
 */
export function isValidPipelineSettings(value: unknown): value is PipelineSettings {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 2) {
		return false;
	}
	for (const k of keys) {
		if (!ALLOWED_KEYS.has(k)) {
			return false;
		}
	}

	if (record.bughunt !== 0 && record.bughunt !== 1) {
		return false;
	}

	if (record.wrapupMode !== 'auto' && record.wrapupMode !== 'manual') {
		return false;
	}

	return true;
}

/**
 * Parses raw JSON string into PipelineSettings with safe fallbacks (E-318, AC 5):
 * - Absent row or empty value returns default `{bughunt: 0, wrapupMode: 'auto'}` without inserting.
 * - Corrupted JSON or invalid/unknown fields logs warning and falls back to default.
 */
export function parsePipelineSettings(
	raw: string | null | undefined,
	warn?: (message: string, cause?: unknown) => void,
): PipelineSettings {
	if (raw === null || raw === undefined || raw.trim().length === 0) {
		return DEFAULT_PIPELINE_SETTINGS;
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (isValidPipelineSettings(parsed)) {
			return Object.freeze({
				bughunt: parsed.bughunt,
				wrapupMode: parsed.wrapupMode,
			});
		}
		warn?.(`[settings] Invalid pipeline settings JSON: ${raw}. Falling back to default.`);
		return DEFAULT_PIPELINE_SETTINGS;
	} catch (cause) {
		warn?.('[settings] Corrupted pipeline settings JSON. Falling back to default.', cause);
		return DEFAULT_PIPELINE_SETTINGS;
	}
}
