/**
 * packages/web/test/connection-store.test.ts
 *
 * M9-T11: Connection store unit tests (07-前端架构 / 07:249, 07:298, AC 2, E-12).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	registerResyncHandler,
	selectCanDispatch,
	triggerResync,
	useConnectionStore,
} from '../src/store/connection-store.ts';

describe('M9-T11: Connection store slice (07:249, 07:298, AC 2, E-12)', () => {
	beforeEach(() => {
		useConnectionStore.getState().reset();
		vi.clearAllMocks();
	});

	afterEach(() => {
		useConnectionStore.getState().reset();
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Architectural & Boundary checks: 4 fields + 4 setters + reset, no api imports
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Store shape and architectural boundaries', () => {
		it('strictly contains only the 4 fields + 4 setters + reset in state', () => {
			const state = useConnectionStore.getState();
			const keys = Object.keys(state).sort();

			const expectedKeys = [
				'status',
				'lastSyncedAt',
				'lastEventId',
				'needsPairing',
				'setStatus',
				'setLastSyncedAt',
				'setLastEventId',
				'setNeedsPairing',
				'reset',
			].sort();

			expect(keys).toEqual(expectedKeys);
		});

		it('has no imports of src/api or ../api in packages/web/src/store/ (07:72)', () => {
			const storeDir = path.resolve(__dirname, '../src/store');
			const files = fs.readdirSync(storeDir).filter((f) => f.endsWith('.ts'));

			expect(files.length).toBeGreaterThanOrEqual(2); // connection-store.ts, notice-store.ts

			for (const file of files) {
				const fullPath = path.join(storeDir, file);
				const content = fs.readFileSync(fullPath, 'utf8');

				// Strictly forbidden: import ... from '../api' or 'src/api' or '@/api'
				expect(content).not.toMatch(/from\s+['"][^'"]*\/api(\/|\.ts)?['"]/);
				expect(content).not.toMatch(/from\s+['"]\.\.\/api/);
				expect(content).not.toMatch(/from\s+['"]src\/api/);
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// Setters and state transitions
	// ─────────────────────────────────────────────────────────────────────────────
	describe('State setters', () => {
		it('initializes to offline state with null timestamps and event IDs', () => {
			const state = useConnectionStore.getState();
			expect(state.status).toBe('offline');
			expect(state.lastSyncedAt).toBeNull();
			expect(state.lastEventId).toBeNull();
			expect(state.needsPairing).toBe(false);
		});

		it('updates status with setStatus', () => {
			useConnectionStore.getState().setStatus('online');
			expect(useConnectionStore.getState().status).toBe('online');

			useConnectionStore.getState().setStatus('reconnecting');
			expect(useConnectionStore.getState().status).toBe('reconnecting');

			useConnectionStore.getState().setStatus('offline');
			expect(useConnectionStore.getState().status).toBe('offline');
		});

		it('updates lastSyncedAt with Date, string, number, or null', () => {
			const now = new Date('2026-09-16T12:00:00.000Z');
			useConnectionStore.getState().setLastSyncedAt(now);
			expect(useConnectionStore.getState().lastSyncedAt).toBe(now.toISOString());

			useConnectionStore.getState().setLastSyncedAt(now.getTime());
			expect(useConnectionStore.getState().lastSyncedAt).toBe(now.toISOString());

			useConnectionStore.getState().setLastSyncedAt('2026-09-16T15:00:00.000Z');
			expect(useConnectionStore.getState().lastSyncedAt).toBe('2026-09-16T15:00:00.000Z');

			useConnectionStore.getState().setLastSyncedAt(null);
			expect(useConnectionStore.getState().lastSyncedAt).toBeNull();
		});

		it('updates lastEventId with setLastEventId', () => {
			useConnectionStore.getState().setLastEventId(999);
			expect(useConnectionStore.getState().lastEventId).toBe(999);

			useConnectionStore.getState().setLastEventId(null);
			expect(useConnectionStore.getState().lastEventId).toBeNull();
		});

		it('updates needsPairing with setNeedsPairing', () => {
			useConnectionStore.getState().setNeedsPairing(true);
			expect(useConnectionStore.getState().needsPairing).toBe(true);

			useConnectionStore.getState().setNeedsPairing(false);
			expect(useConnectionStore.getState().needsPairing).toBe(false);
		});

		it('resets all fields with reset()', () => {
			useConnectionStore.getState().setStatus('online');
			useConnectionStore.getState().setLastEventId(12);
			useConnectionStore.getState().setLastSyncedAt(new Date());
			useConnectionStore.getState().setNeedsPairing(true);

			useConnectionStore.getState().reset();

			const state = useConnectionStore.getState();
			expect(state.status).toBe('offline');
			expect(state.lastSyncedAt).toBeNull();
			expect(state.lastEventId).toBeNull();
			expect(state.needsPairing).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-12: selectCanDispatch selector
	// ─────────────────────────────────────────────────────────────────────────────
	describe('selectCanDispatch selector (AC 2, E-12, 07:298)', () => {
		it('permits dispatch strictly when online and needsPairing is false', () => {
			expect(selectCanDispatch({ status: 'online', needsPairing: false })).toBe(true);
		});

		it('disables dispatch when status is offline or reconnecting', () => {
			expect(selectCanDispatch({ status: 'offline', needsPairing: false })).toBe(false);
			expect(selectCanDispatch({ status: 'reconnecting', needsPairing: false })).toBe(false);
		});

		it('disables dispatch when needsPairing is true even if online', () => {
			expect(selectCanDispatch({ status: 'online', needsPairing: true })).toBe(false);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-12: Resync recovery triggers
	// ─────────────────────────────────────────────────────────────────────────────
	describe('Resync handler registration and trigger (E-12)', () => {
		it('triggers registered resync handlers on offline -> online transition', () => {
			const resyncMock = vi.fn();
			const unbind = registerResyncHandler(resyncMock);

			useConnectionStore.getState().setStatus('offline');
			useConnectionStore.getState().setStatus('online');
			expect(resyncMock).toHaveBeenCalledTimes(1);

			// Online -> Online does not re-trigger
			useConnectionStore.getState().setStatus('online');
			expect(resyncMock).toHaveBeenCalledTimes(1);

			// Reconnecting -> Online triggers again
			useConnectionStore.getState().setStatus('reconnecting');
			useConnectionStore.getState().setStatus('online');
			expect(resyncMock).toHaveBeenCalledTimes(2);

			unbind();
		});

		it('supports manual triggerResync invocation', async () => {
			const resyncMock = vi.fn();
			const unbind = registerResyncHandler(resyncMock);

			await triggerResync();
			expect(resyncMock).toHaveBeenCalledTimes(1);

			unbind();
		});
	});
});
