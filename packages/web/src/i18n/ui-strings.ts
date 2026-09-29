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
	login: {
		loggedIn: '已登录',
		loggedOut: '未登录',
		unknown: '无法判定',
		expiredSuffix: '· 已过期',
		justNow: '刚刚',
		probedMinutesAgo: (minutes: number) => `${minutes} 分钟前探测`,
		hintLoggedOutWithCommand: (cmd: string) => `未登录：在终端运行 ${cmd} 后点刷新`,
		hintLoggedOutGeneric: (agentName: string) => `未登录：按 ${agentName} 自身文档登录后点刷新`,
		hintUnknown: '登录态未知：确认后点刷新',
		copyCommand: '复制命令',
		copied: '已复制',
		refresh: '刷新清单',
		reprobe: '重新探测',
	},
	modelPicker: {
		sources: {
			live: '实时清单',
			config: '配置文件',
			builtin: '内置推荐',
			history: '近期使用',
			manual: '手动指定',
			other: '其他',
		},
		currentConfigChip: '当前配置',
		unlistedChip: '清单未列',
		manualOption: '手填模型名…',
		incompleteFooter: '清单可能不全，可手填',
		isRefreshing: '实时清单获取中',
		selectPlaceholder: '选择默认模型...',
		manualInputPlaceholder: '输入模型名称...',
		apply: '确定',
		cancel: '取消',
	},
	effortPicker: {
		groups: {
			tiers: '标准档位',
			vendor: '厂商原值',
		},
		follow: '跟随默认',
		low: '低档 (low)',
		medium: '中档 (medium)',
		high: '高档 (high)',
		currentConfigChip: '当前配置',
		unrecognizedChip: '无法识别',
		unsupportedWarning: (val: string) => `该模型不支持 ${val}`,
		unsupportedFallback: '—',
		unsupportedAgentTitle: '该 agent 不支持思考强度',
		selectPlaceholder: '选择思考强度...',
	},
	zeroOutputGate: {
		title: '零产出退出',
		hint: 'agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒',
		stderrEmpty: '无 stderr 输出',
		legacyRun: '无记录（旧运行）',
		eventMissing: '事件缺失',
		redacted: '[已脱敏]',
		actions: {
			rerun: '重跑',
			reassign: '换 agent 重派',
			markFailed: '标失败',
		},
		expandStderr: (count: number) => `展开全部 stderr (共 ${count} 行)`,
		collapseStderr: '收起',
	},
	gateCard: {
		zeroOutputTitle: '零产出退出',
		zeroOutputHint: 'agent 未产出任何内容就退出，常见原因：未登录、模型名不可用、参数被拒',
		stderrTitle: 'stderr 诊断记录',
		noStderr: '无 stderr 输出',
		legacyRun: '无记录（旧运行）',
		eventMissing: '事件缺失',
		redacted: '[已脱敏]',
		loginProbe: '探测登录态',
		rerun: '重跑',
		reassign: '换 agent 重派',
		markFailed: '标失败',
		foldLines: '收起',
		expandLines: '展开全文',
	},
	pipelineAssignment: {
		reviewOverrideTitle: '审查覆盖',
		reviewOverrideFollowNote: '跟随任务指派：使用实施该任务的同一 agent 与配置',
		wrapupAssignmentTitle: '收口指派',
		wrapupAssignmentFollowNote: '跟随最后一项实施任务：使用该批次最后完成的 agent 与配置',
		modeFollow: '跟随任务',
		modeCustom: '自定义指定',
		agentSelectPlaceholder: '选择执行 Agent...',
	},
	agentCard: {
		restoreDefault: '恢复默认',
		noOverrideTitle: '当前没有覆盖',
		effortUnsupported: '该 agent 不支持',
		refreshModels: '刷新清单',
		reprobe: '重新探测',
	},
} as const;
