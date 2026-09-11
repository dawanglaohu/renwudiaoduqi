import { describe, expect, it } from 'vitest';
import { STATUS_BADGE_THEMES, StatusBadge, StatusIcon } from '../src/components/status-badge.tsx';
import { STATUS_STATES } from '../src/lib/spine-shape.ts';

describe('status-badge (M9-T2 / AC 6, E-110, E-170, E-231)', () => {
	// ─── AC 6: 徽标色彩与边框配置（零颜色字面量，全量 CSS 变量） ───
	it('all 12 status badge themes use CSS variables and zero color literals', () => {
		const COLOR_LITERAL_REGEX =
			/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgb|rgba|hsl|hsla)\(/i;

		for (const state of STATUS_STATES) {
			const theme = STATUS_BADGE_THEMES[state];
			expect(theme).toBeDefined();

			expect(theme.bg.startsWith('var('), `${state} bg must be CSS variable`).toBe(true);
			expect(theme.text.startsWith('var('), `${state} text must be CSS variable`).toBe(true);
			expect(theme.border.startsWith('var('), `${state} border must be CSS variable`).toBe(true);

			expect(COLOR_LITERAL_REGEX.test(theme.bg)).toBe(false);
			expect(COLOR_LITERAL_REGEX.test(theme.text)).toBe(false);
			expect(COLOR_LITERAL_REGEX.test(theme.border)).toBe(false);
		}
	});

	// ─── AC 6 & 11 节: stopped 状态使用虚线边框 ───
	it('stopped state uses dashed border (borderStyle: dashed)', () => {
		const stoppedTheme = STATUS_BADGE_THEMES.stopped;
		expect(stoppedTheme.borderStyle).toBe('dashed');
		expect(stoppedTheme.border).toBe('var(--border-strong)');
		expect(stoppedTheme.text).toBe('var(--stopped)');

		// 其余状态为 solid 边框
		for (const state of STATUS_STATES) {
			if (state !== 'stopped') {
				expect(STATUS_BADGE_THEMES[state].borderStyle ?? 'solid').toBe('solid');
			}
		}
	});

	// ─── AC 6 & 11 节: partial 并入暖色，绝不绿 ───
	it('partial state uses warm needs/warn tokens and NEVER green/auto', () => {
		const partialTheme = STATUS_BADGE_THEMES.partial;
		expect(partialTheme.border).toBe('var(--needs)');
		expect(partialTheme.text).toBe('var(--needs-ink)');
		expect(partialTheme.bg).toBe('var(--needs-soft)');

		// 绝不包含 auto
		expect(partialTheme.border).not.toContain('auto');
		expect(partialTheme.text).not.toContain('auto');
		expect(partialTheme.bg).not.toContain('auto');
	});

	// ─── succeeded 使用冷绿 auto ───
	it('succeeded state uses auto tokens', () => {
		const succeededTheme = STATUS_BADGE_THEMES.succeeded;
		expect(succeededTheme.border).toBe('var(--auto)');
		expect(succeededTheme.text).toBe('var(--auto-ink)');
		expect(succeededTheme.bg).toBe('var(--auto-soft)');
	});

	// ─── failed 使用 down 红色 ───
	it('failed state uses down tokens', () => {
		const failedTheme = STATUS_BADGE_THEMES.failed;
		expect(failedTheme.border).toBe('var(--down)');
		expect(failedTheme.text).toBe('var(--down-ink)');
		expect(failedTheme.bg).toBe('var(--down-soft)');
	});

	// ─── 组件渲染输出（React createElement / JSX 函数测试） ───
	it('StatusBadge renders rectangular badge element with icon and text', () => {
		const vnode = StatusBadge({ state: 'succeeded', text: '已落地' });
		expect(vnode).toBeDefined();
		expect(vnode.type).toBe('span');
		expect(vnode.props.role).toBe('status');
		expect(vnode.props['aria-label']).toContain('完成 · 已落地');
		expect(vnode.props['data-state']).toBe('succeeded');
		expect(vnode.props['data-shape']).toBe('succeeded');

		// 矩形非药丸：包含 h-[20px] 和 rounded-[6px]，不含 rounded-full
		const className = vnode.props.className ?? '';
		expect(className).toContain('h-[20px]');
		expect(className).toContain('rounded-[6px]');
		expect(className).toContain('px-[7px]');
		expect(className).toContain('font-semibold');
		expect(className).not.toContain('rounded-full');
		expect(className).not.toContain('rounded-pill');

		// 包含子元素：图标与文字
		const children = vnode.props.children;
		expect(Array.isArray(children)).toBe(true);
		expect(children).toHaveLength(2);
	});

	it('StatusBadge stopped state applies border-dashed class', () => {
		const vnode = StatusBadge({ state: 'stopped' });
		const className = vnode.props.className ?? '';
		expect(className).toContain('border-dashed');
		expect(vnode.props.style.borderStyle).toBe('dashed');
	});

	it('StatusIcon renders SVG with unified viewBox and vector-effect', () => {
		const iconVnode = StatusIcon({ state: 'thinking', size: 14 });
		expect(iconVnode.type).toBe('svg');
		expect(iconVnode.props.viewBox).toBe('0 0 16 16');
		expect(iconVnode.props.width).toBe(14);
		expect(iconVnode.props.height).toBe(14);
		expect(iconVnode.props['aria-label']).toBe('思考中');
		expect(iconVnode.props.fill).toBe('none');
		expect(iconVnode.props.stroke).toBe('currentColor');
		expect(iconVnode.props.style.vectorEffect).toBe('non-scaling-stroke');
	});
});
