/**
 * packages/web/src/i18n/ui-strings.ts
 *
 * 客户端通用 UI 文案字典（M9-T21, M9-T22 / 07 节前端架构：文案唯一来源 src/i18n/）
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
	pipeline: {
		/** 查 bug 开关开启时的常驻说明（AC 3, E-306） */
		bughuntAutoNote: '审查 pass 后自动派查 bug 运行，只影响尚未到达该阶段的任务',
		/** 收口开关切为手动时的常驻说明（AC 3, E-312） */
		wrapupManualNote: '本批全部任务落地后不自动收口，需手动点击收口',
		/** 流水线设置页数据来源声明（AC 4） */
		daemonManagedNotice: '当前值来自 daemon',
		/** 收口模式标签 */
		wrapupModeLabel: '收口模式',
		/** 别名与展示辅助 */
		daemonNotice: '当前值来自 daemon',
		bughuntLabel: '查 bug',
		fallback: '—',
	},
} as const;
