/**
 * packages/web/src/api/cache-keys.ts
 *
 * 服务端态缓存 Key 与前缀集中定义（M9-T19 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构）：
 * - 服务端态缓存 resource-cache 的 key 由 cache-keys.ts 集中生成
 * - 失效由事件驱动，前缀粒度批量失效
 */

export type CachePrefix =
	| 'batches'
	| 'tasks'
	| 'runs'
	| 'settings'
	| 'lanes'
	| 'agents'
	| 'agentModels'
	| 'documents'
	| 'wrapups';

export const CACHE_PREFIXES: readonly CachePrefix[] = [
	'batches',
	'tasks',
	'runs',
	'settings',
	'lanes',
	'agents',
	'agentModels',
	'documents',
	'wrapups',
] as const;

/**
 * 缓存 Key 构造函数字典。
 */
export const CACHE_KEYS = {
	batches: (docId?: string) => (docId ? `batches:${docId}` : 'batches'),
	tasks: (batchId?: string) => (batchId ? `tasks:${batchId}` : 'tasks'),
	runs: (taskId?: string) => (taskId ? `runs:${taskId}` : 'runs'),
	settings: {
		gates: 'settings:gates',
		pipeline: 'settings:pipeline',
		all: 'settings',
	},
	lanes: (docId?: string) => (docId ? `lanes:${docId}` : 'lanes'),
	agents: () => 'agents',
	agentModels: (agentId?: string) => (agentId ? `agentModels:${agentId}` : 'agentModels'),
	documents: () => 'documents',
	/** 每批次的收口报告集合（GET /batches/:id/wrapups，M9-T20）。 */
	wrapups: (batchId?: string) => (batchId ? `wrapups:${batchId}` : 'wrapups'),
} as const;

export function settingsGates(): string {
	return CACHE_KEYS.settings.gates;
}

export function settingsPipeline(): string {
	return CACHE_KEYS.settings.pipeline;
}
