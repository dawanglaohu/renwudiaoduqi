/**
 * packages/web/src/i18n/ui-strings.ts
 *
 * 客户端通用 UI 文案字典（M9-T21 / 07 节前端架构：文案唯一来源 src/i18n/）
 */

export const UI_STRINGS = {
	lanes: {
		unavailable: '泳道数据不可用',
		overLimitChip: '超出窗口数',
		sessionArchivedChip: '会话已归档',
		idlePrefix: '空闲',
		allDispatched: '空闲 · 本批已全部派出',
		nextTaskPrefix: '队列下一个是',
		waitingPredecessors: '落地',
		wrapupTitle: '批次收口',
		laneTitle: (laneNo: number) => `泳道 ${laneNo}`,
		roundLabel: (round: number) => `第 ${round} 轮`,
		stageFallback: '—',
	},
	stages: {
		implement: '实施',
		queued: '排队',
		rework: '返工实施',
		review: '审查',
		bughunt: '查 bug',
		landing: '落地',
		unknown: '—',
	},
} as const;
