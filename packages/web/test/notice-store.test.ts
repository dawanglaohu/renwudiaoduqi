/**
 * packages/web/test/notice-store.test.ts
 *
 * M9-T11: Notice store unit tests (07-前端架构 / AC 1, E-157, 07:89, 07:252).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useNoticeStore } from '../src/store/notice-store.ts';

describe('M9-T11: Notice store slice (07:89, 07:252)', () => {
	beforeEach(() => {
		useNoticeStore.getState().reset();
	});

	afterEach(() => {
		useNoticeStore.getState().reset();
	});

	it('initializes with null rollbackNotice and empty banners', () => {
		const state = useNoticeStore.getState();
		expect(state.rollbackNotice).toBeNull();
		expect(state.banner).toBeNull();
		expect(state.banners).toEqual([]);
	});

	it('writes and clears rollback notice for failed optimistic stop (AC 1, E-157)', () => {
		useNoticeStore.getState().setRollbackNotice({
			runId: 'run-rollback-1',
			message: '你在第 3/5 步停止失败，已恢复原状态',
		});

		const state = useNoticeStore.getState();
		expect(state.rollbackNotice).not.toBeNull();
		expect(state.rollbackNotice?.runId).toBe('run-rollback-1');
		expect(state.rollbackNotice?.message).toBe('你在第 3/5 步停止失败，已恢复原状态');
		expect(typeof state.rollbackNotice?.timestamp).toBe('number');

		// Also reflected on active banner and banners list
		expect(state.banner).not.toBeNull();
		expect(state.banner?.kind).toBe('rollback');
		expect(state.banner?.runId).toBe('run-rollback-1');
		expect(state.banners.length).toBe(1);

		// Clear rollback notice
		useNoticeStore.getState().clearRollbackNotice();
		const cleared = useNoticeStore.getState();
		expect(cleared.rollbackNotice).toBeNull();
		expect(cleared.banner).toBeNull();
		expect(cleared.banners.length).toBe(0);
	});

	it('uses fallback message when message is omitted in setRollbackNotice', () => {
		useNoticeStore.getState().setRollbackNotice({
			runId: 'run-default-msg',
		});

		const state = useNoticeStore.getState();
		expect(state.rollbackNotice?.message).toBe('中止任务失败，已恢复原状态');
	});

	it('clears rollbackNotice when passing null to setRollbackNotice', () => {
		useNoticeStore.getState().setRollbackNotice({
			runId: 'run-1',
			message: 'msg',
		});
		expect(useNoticeStore.getState().rollbackNotice).not.toBeNull();

		useNoticeStore.getState().setRollbackNotice(null);
		expect(useNoticeStore.getState().rollbackNotice).toBeNull();
	});

	it('manages generic banners (setBanner, addBanner, removeBanner, clearBanner)', () => {
		useNoticeStore.getState().setBanner({
			id: 'banner-info-1',
			kind: 'info',
			message: '系统通知',
			timestamp: Date.now(),
		});

		let state = useNoticeStore.getState();
		expect(state.banner?.id).toBe('banner-info-1');
		expect(state.banner?.kind).toBe('info');

		// Add second banner
		useNoticeStore.getState().addBanner({
			id: 'banner-warn-2',
			kind: 'warning',
			message: '磁盘空间不足',
			timestamp: Date.now(),
		});

		state = useNoticeStore.getState();
		expect(state.banners.length).toBe(2);

		// Remove first banner
		useNoticeStore.getState().removeBanner('banner-info-1');
		state = useNoticeStore.getState();
		expect(state.banners.length).toBe(1);
		expect(state.banners[0]?.id).toBe('banner-warn-2');

		// Clear banner
		useNoticeStore.getState().clearBanner();
		expect(useNoticeStore.getState().banner).toBeNull();
	});

	it('resets all state to initial with reset()', () => {
		useNoticeStore.getState().setRollbackNotice({
			runId: 'run-reset',
			message: 'error',
		});
		expect(useNoticeStore.getState().rollbackNotice).not.toBeNull();

		useNoticeStore.getState().reset();
		const state = useNoticeStore.getState();
		expect(state.rollbackNotice).toBeNull();
		expect(state.banner).toBeNull();
		expect(state.banners).toEqual([]);
	});
});
