/**
 * packages/web/src/store/notice-store.ts
 *
 * Notice store slice (07-前端架构: 横幅列表、回滚横幅与通知呈现 / 07:252).
 * Minimal implementation for optimistic stop rollback banners and system notices.
 * Counter fields are populated from server snapshots when available.
 */

import { create } from 'zustand';

export interface RollbackNotice {
	readonly runId: string;
	readonly message: string;
	readonly timestamp: number;
}

export interface NoticeBanner {
	readonly id: string;
	readonly kind: 'rollback' | 'info' | 'warning' | 'error';
	readonly message: string;
	readonly runId?: string;
	readonly timestamp: number;
}

export interface NoticeState {
	/** Active rollback notice from failed optimistic stop (AC 1, E-157) */
	readonly rollbackNotice: RollbackNotice | null;
	/** Active generic top-level banner */
	readonly banner: NoticeBanner | null;
	/** List of active banners */
	readonly banners: readonly NoticeBanner[];
}

export interface NoticeActions {
	/** Set rollback notice on optimistic stop API rejection */
	setRollbackNotice(notice: { runId: string; message?: string; timestamp?: number } | null): void;
	/** Clear active rollback notice */
	clearRollbackNotice(): void;
	/** Set or clear active top-level banner */
	setBanner(banner: NoticeBanner | null): void;
	/** Clear top-level banner */
	clearBanner(): void;
	/** Add a banner to active banners list */
	addBanner(banner: NoticeBanner): void;
	/** Remove a banner by ID */
	removeBanner(id: string): void;
	/** Reset notice store */
	reset(): void;
}

export type NoticeStore = NoticeState & NoticeActions;

const INITIAL_STATE: NoticeState = {
	rollbackNotice: null,
	banner: null,
	banners: [],
};

export const useNoticeStore = create<NoticeStore>((set) => ({
	...INITIAL_STATE,

	setRollbackNotice: (notice) => {
		if (!notice) {
			set({ rollbackNotice: null });
			return;
		}
		const rollback: RollbackNotice = {
			runId: notice.runId,
			message: notice.message ?? '中止任务失败，已恢复原状态',
			timestamp: notice.timestamp ?? Date.now(),
		};
		const banner: NoticeBanner = {
			id: `rollback-${notice.runId}`,
			kind: 'rollback',
			message: rollback.message,
			runId: notice.runId,
			timestamp: rollback.timestamp,
		};
		set((state) => ({
			rollbackNotice: rollback,
			banner,
			banners: [banner, ...state.banners.filter((b) => b.id !== banner.id)],
		}));
	},

	clearRollbackNotice: () => {
		set((state) => ({
			rollbackNotice: null,
			banner: state.banner?.kind === 'rollback' ? null : state.banner,
			banners: state.banners.filter((b) => b.kind !== 'rollback'),
		}));
	},

	setBanner: (banner) => {
		if (!banner) {
			set({ banner: null });
			return;
		}
		set((state) => ({
			banner,
			rollbackNotice:
				banner.kind === 'rollback' && banner.runId
					? { runId: banner.runId, message: banner.message, timestamp: banner.timestamp }
					: state.rollbackNotice,
			banners: [banner, ...state.banners.filter((b) => b.id !== banner.id)],
		}));
	},

	clearBanner: () => {
		set({ banner: null });
	},

	addBanner: (banner) => {
		set((state) => ({
			banner,
			rollbackNotice:
				banner.kind === 'rollback' && banner.runId
					? { runId: banner.runId, message: banner.message, timestamp: banner.timestamp }
					: state.rollbackNotice,
			banners: [banner, ...state.banners.filter((b) => b.id !== banner.id)],
		}));
	},

	removeBanner: (id) => {
		set((state) => {
			const nextBanners = state.banners.filter((b) => b.id !== id);
			const isCurrent = state.banner?.id === id;
			const isRollback = state.rollbackNotice && `rollback-${state.rollbackNotice.runId}` === id;
			return {
				banners: nextBanners,
				banner: isCurrent ? (nextBanners[0] ?? null) : state.banner,
				rollbackNotice: isRollback ? null : state.rollbackNotice,
			};
		});
	},

	reset: () => {
		set(INITIAL_STATE);
	},
}));
