/**
 * 对应上游 build_docs.py / 阅读器的 layerOf：
 * 按依赖算层级：层号 = 最长前驱链长度，无前驱为 0，成环就地截断为 0，显示号（batch_no）= 层号 + 1。
 * 规则与阅读器逐字一致且收敛在唯一适配器模块内。上游日后若真导出 batchNo，只改这一个分层函数（E-246）。
 */

export type TaskDepsLookup = (taskId: string) => readonly string[] | undefined;

export function layerOf(
	ids: readonly string[],
	depsOf: TaskDepsLookup | Record<string, readonly string[] | undefined>,
): Record<string, number> {
	const resolveDeps: TaskDepsLookup =
		typeof depsOf === 'function' ? depsOf : (id) => depsOf[id] ?? [];
	const idSet = new Set(ids);
	const lv: Record<string, number> = {};

	function walk(id: string, stack: readonly string[]): number {
		const cached = lv[id];
		if (cached !== undefined) return cached;
		if (stack.includes(id)) return 0;

		let m = 0;
		const deps = resolveDeps(id) ?? [];
		for (const p of deps) {
			if (idSet.has(p)) {
				m = Math.max(m, walk(p, [...stack, id]) + 1);
			}
		}
		lv[id] = m;
		return m;
	}

	for (const id of ids) {
		walk(id, []);
	}
	return lv;
}

/**
 * 将层号转换为显示号 / 批次号（层号 + 1）。
 * 无前驱的任务层号为 0，显示号为 1。
 */
export function batchNoOf(layer: number): number {
	return layer + 1;
}
