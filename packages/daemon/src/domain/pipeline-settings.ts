import type {
	PipelineSettings,
	ReviewOverride,
	WrapupAssignment,
} from '@agent-scheduler/shared/api/settings';

export const DEFAULT_PIPELINE_SETTINGS: PipelineSettings = Object.freeze({
	bughunt: 0,
	wrapupMode: 'auto',
	reviewOverride: null,
	wrapupAssignment: Object.freeze({ mode: 'follow' }),
});

const ALLOWED_KEYS = new Set(['bughunt', 'wrapupMode', 'reviewOverride', 'wrapupAssignment']);
const EFFORT_TIERS = new Set(['low', 'medium', 'high']);

/**
 * Validates reviewOverride field (AC 5, E-356).
 */
export function isValidReviewOverride(value: unknown): value is ReviewOverride | null {
	if (value === null) return true;
	if (typeof value !== 'object' || Array.isArray(value)) return false;

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	for (const k of keys) {
		if (k !== 'agentId' && k !== 'modelName' && k !== 'effortTier') return false;
	}

	if (typeof record.agentId !== 'string' || record.agentId.trim().length === 0) {
		return false;
	}
	if (
		record.modelName !== undefined &&
		record.modelName !== null &&
		typeof record.modelName !== 'string'
	) {
		return false;
	}
	if (
		record.effortTier !== undefined &&
		record.effortTier !== null &&
		(typeof record.effortTier !== 'string' || !EFFORT_TIERS.has(record.effortTier))
	) {
		return false;
	}

	return true;
}

/**
 * Validates wrapupAssignment field (AC 5, E-356).
 * Follow mode strictly allows only { mode: 'follow' }; fixed mode requires agentId.
 * Mixed shapes (e.g. mode: 'follow' with agentId) are rejected.
 */
export function isValidWrapupAssignment(value: unknown): value is WrapupAssignment {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

	const record = value as Record<string, unknown>;
	if (record.mode === 'follow') {
		return Object.keys(record).length === 1;
	}

	if (record.mode === 'fixed') {
		const keys = Object.keys(record);
		for (const k of keys) {
			if (k !== 'mode' && k !== 'agentId' && k !== 'modelName' && k !== 'effortTier') return false;
		}
		if (typeof record.agentId !== 'string' || record.agentId.trim().length === 0) {
			return false;
		}
		if (
			record.modelName !== undefined &&
			record.modelName !== null &&
			typeof record.modelName !== 'string'
		) {
			return false;
		}
		if (
			record.effortTier !== undefined &&
			record.effortTier !== null &&
			(typeof record.effortTier !== 'string' || !EFFORT_TIERS.has(record.effortTier))
		) {
			return false;
		}
		return true;
	}

	return false;
}

/**
 * Validates whether an unknown value conforms strictly to PipelineSettings (E-318, E-356, AC 5):
 * - bughunt must be 0 | 1
 * - wrapupMode must be 'auto' | 'manual'
 * - reviewOverride must be null or valid ReviewOverride
 * - wrapupAssignment must be valid WrapupAssignment
 * - strictly no additional properties (4 keys required)
 */
export function isValidPipelineSettings(value: unknown): value is PipelineSettings {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== 4) {
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

	if (!isValidReviewOverride(record.reviewOverride)) {
		return false;
	}

	if (!isValidWrapupAssignment(record.wrapupAssignment)) {
		return false;
	}

	return true;
}

/**
 * Parses raw JSON string into PipelineSettings with safe fallbacks (E-318, E-356, AC 5):
 * - Absent row or empty value returns default `{bughunt: 0, wrapupMode: 'auto', reviewOverride: null, wrapupAssignment: {mode: 'follow'}}` without inserting.
 * - Legacy 2-key rows are supplemented with reviewOverride: null and wrapupAssignment: {mode: 'follow'} on read without writing DB.
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
				reviewOverride: parsed.reviewOverride ? Object.freeze({ ...parsed.reviewOverride }) : null,
				wrapupAssignment: Object.freeze({ ...parsed.wrapupAssignment }),
			});
		}

		// Support legacy 2-key rows: bughunt & wrapupMode (E-356)
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			const rec = parsed as Record<string, unknown>;
			const keys = Object.keys(rec);
			if (
				(keys.length === 2 && keys.includes('bughunt') && keys.includes('wrapupMode')) ||
				(rec.bughunt !== undefined &&
					rec.wrapupMode !== undefined &&
					rec.reviewOverride === undefined &&
					rec.wrapupAssignment === undefined)
			) {
				if (
					(rec.bughunt === 0 || rec.bughunt === 1) &&
					(rec.wrapupMode === 'auto' || rec.wrapupMode === 'manual')
				) {
					return Object.freeze({
						bughunt: rec.bughunt,
						wrapupMode: rec.wrapupMode,
						reviewOverride: null,
						wrapupAssignment: Object.freeze({ mode: 'follow' }),
					});
				}
			}
		}

		warn?.(`[settings] Invalid pipeline settings JSON: ${raw}. Falling back to default.`);
		return DEFAULT_PIPELINE_SETTINGS;
	} catch (cause) {
		warn?.('[settings] Corrupted pipeline settings JSON. Falling back to default.', cause);
		return DEFAULT_PIPELINE_SETTINGS;
	}
}
