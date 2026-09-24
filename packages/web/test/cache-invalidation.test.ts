import { describe, expect, it } from 'vitest';
import {
	EVENT_CACHE_INVALIDATIONS,
	getInvalidationPrefixesForEvent,
} from '../src/api/cache-invalidation.ts';

describe('cache-invalidation (M9-T21 / E-333)', () => {
	it('defines mappings in EVENT_CACHE_INVALIDATIONS table', () => {
		expect(EVENT_CACHE_INVALIDATIONS).toBeDefined();
		expect(EVENT_CACHE_INVALIDATIONS['lane.assigned']).toEqual(['lanes', 'runs']);
	});

	it('E-333: lane.assigned simultaneously invalidates lanes and runs', () => {
		const prefixes = getInvalidationPrefixesForEvent('lane.assigned');
		expect(prefixes).toContain('lanes');
		expect(prefixes).toContain('runs');
	});

	it('lane.released invalidates lanes and tasks', () => {
		const prefixes = getInvalidationPrefixesForEvent('lane.released');
		expect(prefixes).toContain('lanes');
		expect(prefixes).toContain('tasks');
	});

	it('task.sessions_archived invalidates runs, tasks, and lanes', () => {
		const prefixes = getInvalidationPrefixesForEvent('task.sessions_archived');
		expect(prefixes).toContain('runs');
		expect(prefixes).toContain('tasks');
		expect(prefixes).toContain('lanes');
	});

	it('document.settings_changed invalidates lanes and documents', () => {
		const prefixes = getInvalidationPrefixesForEvent('document.settings_changed');
		expect(prefixes).toContain('lanes');
		expect(prefixes).toContain('documents');
	});

	it('returns empty array for unregistered or unknown event kinds', () => {
		expect(getInvalidationPrefixesForEvent('unknown.event')).toEqual([]);
		expect(getInvalidationPrefixesForEvent('')).toEqual([]);
	});
});
