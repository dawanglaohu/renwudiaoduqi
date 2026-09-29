/**
 * packages/web/src/lib/effort-options.test.ts
 *
 * 思考强度档位与厂商原值单测（AC 3, E-254, E-351）
 */

import type { EffortVendorMap } from '@agent-scheduler/shared/api/agents';
import { describe, expect, it } from 'vitest';
import {
	buildEffortOptionGroups,
	decodeEffortValue,
	effortSupportWarning,
	encodeEffortValue,
} from './effort-options.ts';

describe('effort-options: encode & decode', () => {
	it('roundtrips null, tier, and vendor values', () => {
		expect(encodeEffortValue(null)).toBe('');
		expect(decodeEffortValue('')).toBeNull();

		expect(encodeEffortValue({ tier: 'low' })).toBe('tier:low');
		expect(decodeEffortValue('tier:low')).toEqual({ tier: 'low' });

		expect(encodeEffortValue({ tier: 'high' })).toBe('tier:high');
		expect(decodeEffortValue('tier:high')).toEqual({ tier: 'high' });

		expect(encodeEffortValue({ vendor: 'xhigh' })).toBe('vendor:xhigh');
		expect(decodeEffortValue('vendor:xhigh')).toEqual({ vendor: 'xhigh' });
	});
});

describe('effort-options: buildEffortOptionGroups', () => {
	const sampleVendorMap: EffortVendorMap = {
		low: 'low_vendor',
		medium: 'medium_vendor',
		high: 'high_vendor',
	};

	it('returns empty array when vendorMap is null or undefined (E-254)', () => {
		expect(buildEffortOptionGroups({ vendorMap: null })).toEqual([]);
		expect(buildEffortOptionGroups({ vendorMap: undefined })).toEqual([]);
	});

	it('builds tier group and vendor group with current config chip', () => {
		const groups = buildEffortOptionGroups({
			vendorMap: sampleVendorMap,
			currentConfigEffort: { tier: 'medium' },
			selectedModelEffortOptions: ['low_vendor', 'medium_vendor', 'high_vendor', 'custom_max'],
			allowVendor: true,
		});

		expect(groups).toHaveLength(2);
		const tierGroup = groups[0];
		expect(tierGroup?.id).toBe('tier');
		expect(tierGroup?.items).toHaveLength(4);
		const mediumItem = tierGroup?.items.find((i) => i.encodedValue === 'tier:medium');
		expect(mediumItem?.isCurrentConfig).toBe(true);

		const vendorGroup = groups[1];
		expect(vendorGroup?.id).toBe('vendor');
		expect(vendorGroup?.items).toHaveLength(1);
		expect(vendorGroup?.items[0]?.encodedValue).toBe('vendor:custom_max');
	});

	it('does not render vendor group when allowVendor is false', () => {
		const groups = buildEffortOptionGroups({
			vendorMap: sampleVendorMap,
			currentConfigEffort: { vendor: 'custom_max' },
			selectedModelEffortOptions: ['custom_max'],
			allowVendor: false,
		});

		expect(groups).toHaveLength(1);
		expect(groups[0]?.id).toBe('tier');
	});

	it('adds unrecognized chip when current config vendor is unrecognized (effortRecognized === false)', () => {
		const groups = buildEffortOptionGroups({
			vendorMap: sampleVendorMap,
			currentConfigEffort: { vendor: 'misspelled_val' },
			effortRecognized: false,
			allowVendor: true,
		});

		const vendorGroup = groups.find((g) => g.id === 'vendor');
		expect(vendorGroup).toBeDefined();
		const currentItem = vendorGroup?.items.find((i) => i.encodedValue === 'vendor:misspelled_val');
		expect(currentItem?.isCurrentConfig).toBe(true);
		expect(currentItem?.isUnrecognized).toBe(true);
	});
});

describe('effort-options: effortSupportWarning (E-351)', () => {
	const sampleVendorMap: EffortVendorMap = {
		low: 'low_v',
		medium: 'medium_v',
		high: 'high_v',
	};

	it('returns null when effort is null or effortOptions is empty', () => {
		expect(effortSupportWarning({ effort: null, effortOptions: ['low_v'], vendorMap: sampleVendorMap })).toBeNull();
		expect(effortSupportWarning({ effort: { tier: 'low' }, effortOptions: [], vendorMap: sampleVendorMap })).toBeNull();
	});

	it('warns when tier mapped vendor value is not in effortOptions', () => {
		// Model only supports low_v and medium_v, but high_v is not supported
		const warning = effortSupportWarning({
			effort: { tier: 'high' },
			effortOptions: ['low_v', 'medium_v'],
			vendorMap: sampleVendorMap,
		});
		expect(warning).toBe('该模型不支持 high');
	});

	it('warns when vendor value is not in effortOptions', () => {
		const warning = effortSupportWarning({
			effort: { vendor: 'unsupported_vendor' },
			effortOptions: ['low_v', 'medium_v'],
			vendorMap: sampleVendorMap,
		});
		expect(warning).toBe('该模型不支持 unsupported_vendor');
	});

	it('returns null when effort is fully supported', () => {
		expect(
			effortSupportWarning({
				effort: { tier: 'low' },
				effortOptions: ['low_v', 'medium_v'],
				vendorMap: sampleVendorMap,
			}),
		).toBeNull();
		expect(
			effortSupportWarning({
				effort: { vendor: 'low_v' },
				effortOptions: ['low_v', 'medium_v'],
				vendorMap: sampleVendorMap,
			}),
		).toBeNull();
	});
});
