import type { DensityTier } from '../hooks/use-breakpoint.ts';

/** 完整档按泳道数分配宽度，紧凑档换行，窄窗和手机单列。 */
export function getDeckGridTemplate(tier: DensityTier, laneCount: number): string {
	if (tier === 'compact') {
		return 'repeat(auto-fill, minmax(var(--stream-min-dense), 1fr))';
	}

	if (tier === 'narrow' || tier === 'phone' || tier === 'phone-xs') {
		return '1fr';
	}

	// 首屏尚无泳道时仍需合法的网格模板。
	const normalizedCount = Math.max(1, Math.floor(laneCount));
	return `repeat(${normalizedCount}, minmax(var(--stream-min), 1fr))`;
}
