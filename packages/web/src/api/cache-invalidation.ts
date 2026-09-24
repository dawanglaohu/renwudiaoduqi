/**
 * packages/web/src/api/cache-invalidation.ts
 *
 * 事件驱动的服务端态缓存失效常量表（M9-T19 / 07 节前端架构）
 *
 * 规范依据（07 节前端架构）：
 * - 缓存失效完全由事件驱动，禁止客户端轮询、禁止时间型 stale 窗口
 * - 一张常量表把事件 kind 映射到要失效的 key 前缀集合
 */

import type { EventKind } from '@agent-scheduler/shared/api/events';
import type { CachePrefix } from './cache-keys.ts';

/**
 * 事件种类与受影响缓存前缀的静态映射表。
 */
export const EVENT_CACHE_INVALIDATIONS: Partial<Record<EventKind, readonly CachePrefix[]>> = {
	'run.started': ['runs', 'batches'],
	'run.exited': ['runs'],
	'run.state_changed': ['runs'],
	'run.rework_dispatched': ['runs', 'tasks'],
	'task.gate_waiting': ['tasks'],
	'task.gate_passed': ['tasks'],
	'task.review_verdict': ['tasks', 'runs'],
	'task.landed': ['tasks', 'batches'],
	'task.sessions_archived': ['runs', 'tasks', 'lanes'],
	'lane.assigned': ['lanes', 'runs'],
	'lane.released': ['lanes', 'tasks'],
	'batch.advanced': ['batches'],
	'settings.gates_changed': ['settings'],
	'document.settings_changed': ['lanes', 'documents'],
	'agent.availability_changed': ['agents', 'agentModels'],
	'system.docs_changed': ['documents', 'batches', 'tasks'],
};

/**
 * 获取指定事件类型需要失效的缓存前缀列表。
 */
export function getInvalidationPrefixesForEvent(kind: string): readonly CachePrefix[] {
	return (EVENT_CACHE_INVALIDATIONS as Record<string, readonly CachePrefix[]>)[kind] ?? [];
}
