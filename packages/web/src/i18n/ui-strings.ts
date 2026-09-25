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
	refBar: {
		/** 思考强度不支持（E-254） */
		effortUnsupportedTitle: '不支持思考强度',
		/** 思考强度三档显示文案 */
		effortTiers: {
			low: '低',
			medium: '中',
			high: '高',
		},
		/** 思考强度为厂商原值未映射（AC 1） */
		vendorEffortTitle: '厂商原值，未映射到三档',
		/** 权限档显示文案 */
		permissionTiers: {
			readOnly: '只读',
			workspaceWrite: '工作区',
			unrestricted: '无限制',
		},
		/** 最高权限档警告文案（E-136） */
		unrestrictedWarningTitle: '最高权限档（无限制）：持续生效',
		/** 来源长文案（E-357） */
		sourceTask: '来源：任务指派',
		sourceReviewOverride: '来源：审查覆盖',
		sourceWrapupSettings: (taskKey?: string | null) =>
			taskKey ? `来源：收口设置（跟随 ${taskKey}）` : '来源：收口设置（跟随任务未记录）',
		sourceAgentDefault: '来源：任务指派（agent 默认）',
		sourceAgentDefaultTitle: '按 agent 当前生效默认运行',
		sourceFallback: '来源：—',
		/** 紧凑档/窄窗短文案（E-357） */
		sourceTaskShort: '来源：任务',
		sourceReviewOverrideShort: '来源：审查',
		sourceWrapupSettingsShort: (taskKey?: string | null) =>
			taskKey ? `来源：收口（跟随 ${taskKey}）` : '来源：收口（跟随任务未记录）',
		sourceAgentDefaultShort: '来源：任务（agent 默认）',
		sourceFallbackShort: '来源：—',
		/** 不一致时的连接词（E-37, E-256） */
		mismatchArrow: '→',
		actualPrefix: '实际',
		formatMismatch: (selected: string, actual: string) => `${selected} → 实际 ${actual}`,
		/** 数据缺失占位符 */
		fallback: '—',
		/** 会话序号角标 title（E-31, 决策 33） */
		sessionOrdinalTitle: (sessionNo: number) => `会话序号: ${sessionNo}（同一 agent 独立并发会话）`,
	},
} as const;
