import { createHash } from 'node:crypto';

export interface TaskContractHashItem {
	readonly id: string;
	readonly contractHash: string;
}

/**
 * 文档级 content_fingerprint：
 * 按任务 ID 排序的 [id, contractHash] 列表的 SHA-256 哈希。
 * 任务 ID 增删、有效范围、边界、相关条款或提示词编译器变化都能被识别；
 * 禁止使用 generated 或 mtime 作为变更依据（E-17、E-79）。
 */
export function computeDocsFingerprint(
	tasks: readonly TaskContractHashItem[] | Iterable<TaskContractHashItem>,
): string {
	const items = Array.from(tasks).map((item) => [item.id, item.contractHash] as const);
	items.sort(([a], [b]) => a.localeCompare(b));
	const payload = JSON.stringify(items);
	return createHash('sha256').update(payload, 'utf8').digest('hex');
}
