import { AppError } from '../errors/app-error.ts';
import { type EffortValue, isEffortTier } from './effort-tier.ts';

export interface EffortColumns {
	readonly effort_tier: string | null;
	readonly effort_vendor: string | null;
}

/**
 * Converts an EffortValue into the database columns runs.effort_tier and runs.effort_vendor.
 * The two columns are guaranteed never to be non-null at the same time.
 */
export function toEffortColumns(value: EffortValue): EffortColumns {
	if (value === null) {
		return Object.freeze({ effort_tier: null, effort_vendor: null });
	}
	if ('tier' in value && value.tier) {
		return Object.freeze({ effort_tier: value.tier, effort_vendor: null });
	}
	if ('vendor' in value && value.vendor) {
		return Object.freeze({ effort_tier: null, effort_vendor: value.vendor });
	}
	return Object.freeze({ effort_tier: null, effort_vendor: null });
}

/**
 * Reconstructs an EffortValue from runs.effort_tier and runs.effort_vendor.
 * Throws E_INTERNAL if both columns are non-null simultaneously.
 */
export function fromEffortColumns(
	effortTier: string | null,
	effortVendor: string | null,
): EffortValue {
	if (effortTier !== null && effortVendor !== null) {
		throw new AppError(
			'E_INTERNAL',
			'Invariant violation: runs.effort_tier and runs.effort_vendor cannot both be non-null.',
			{
				details: {
					effortTier,
					effortVendor,
				},
			},
		);
	}

	if (effortTier !== null) {
		if (!isEffortTier(effortTier)) {
			throw new AppError(
				'E_INTERNAL',
				`Unknown effort tier stored in runs.effort_tier: '${effortTier}'.`,
				{ details: { effortTier } },
			);
		}
		return Object.freeze({ tier: effortTier });
	}

	if (effortVendor !== null) {
		return Object.freeze({ vendor: effortVendor });
	}

	return null;
}

/**
 * Asserts that a vendor effort value is in the allowed domain (config current or live options).
 * Throws E_VALIDATION with details.field='effort' and allowed=[...] if not in domain.
 */
export function assertVendorEffortInDomain(
	vendorValue: string,
	allowedDomain: readonly string[],
	field = 'effort',
): void {
	if (!allowedDomain.includes(vendorValue)) {
		throw new AppError(
			'E_VALIDATION',
			`Vendor reasoning effort '${vendorValue}' is not in allowed domain (${allowedDomain.join(', ')}).`,
			{
				details: {
					field,
					allowed: Object.freeze([...allowedDomain]),
				},
			},
		);
	}
}
