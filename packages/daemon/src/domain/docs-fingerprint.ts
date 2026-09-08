export interface TaskContractHashItem {
	readonly id: string;
	readonly contractHash: string;
}

export type DocsFingerprintHasher = (canonicalPayload: string) => string;

/**
 * 对任务列表进行跨平台确定性规范化（canonicalization）。
 * 按任务 ID 的二进制 UTF-16 序升序排序，输出唯一的 JSON 规范串。
 * 绝不包含 generated、mtime 或其他非契约元数据（E-17、E-79）。
 */
export function canonicalizeDocsFingerprintPayload(
	tasks: readonly TaskContractHashItem[] | Iterable<TaskContractHashItem>,
): string {
	const items = Array.from(tasks).map((item) => [item.id, item.contractHash] as const);
	items.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return JSON.stringify(items);
}

/**
 * 使用注入的哈希函数对规范化载荷计算指纹。
 * 调用方拥有具体哈希实现，domain 只负责确定性规范化。
 */
export function computeDocsFingerprint(
	tasks: readonly TaskContractHashItem[] | Iterable<TaskContractHashItem>,
	hasher: DocsFingerprintHasher,
): string {
	const payload = canonicalizeDocsFingerprintPayload(tasks);
	return hasher(payload);
}
