import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type GateSettingsValues, GateToggles } from '../src/components/gate-toggles.tsx';
import { GateTogglesContainer } from '../src/features/run-deck/gate-toggles-container.tsx';

describe('components/gate-toggles (M9-T19, AC 6, E-299, R4)', () => {
	const initialValues: GateSettingsValues = {
		dispatch: 'manual',
		review: 'manual',
		landing: 'manual',
	};

	// ─── 1. 三个开关同一形态，第三个不再置灰 ───
	it('renders three switches with identical morphology, and landing switch is active (E-299)', () => {
		const html = renderToStaticMarkup(createElement(GateToggles, { value: initialValues }));

		expect(html).toContain('派发前');
		expect(html).toContain('审查前');
		expect(html).toContain('落地前');

		// 三个开关均存在
		expect(html).toContain('data-gate-toggle="dispatch"');
		expect(html).toContain('data-gate-toggle="review"');
		expect(html).toContain('data-gate-toggle="landing"');

		// 落地前开关未被 disabled / 置灰
		expect(html).not.toContain('disabled=""');
	});

	// ─── 2. 落地开关切到自动时不弹 dialog，常驻一行提示 ───
	it('renders permanent notice when landing is auto without popping dialog (E-299)', () => {
		const autoLandingValues: GateSettingsValues = {
			dispatch: 'manual',
			review: 'manual',
			landing: 'auto',
		};

		const html = renderToStaticMarkup(createElement(GateToggles, { value: autoLandingValues }));

		// 包含常驻说明文本
		expect(html).toContain('审查 pass 后直接标记已验收，仍不执行任何 git 操作');
		expect(html).toContain('data-testid="landing-auto-note"');
		// 严禁包含 dialog / modal / portal
		expect(html).not.toContain('role="dialog"');
		expect(html).not.toContain('modal');
	});

	// ─── 3. 落地开关为 manual 时不渲染常驻提示 ───
	it('does not render landing auto note when landing is manual', () => {
		const html = renderToStaticMarkup(createElement(GateToggles, { value: initialValues }));

		expect(html).not.toContain('审查 pass 后直接标记已验收，仍不执行任何 git 操作');
		expect(html).not.toContain('data-testid="landing-auto-note"');
	});

	// ─── 4. onChange 提交全量三值 ───
	it('calls onChange with all 3 gate values on toggle', () => {
		const handleChange = vi.fn();

		const toggles = GateToggles({
			value: initialValues,
			onChange: handleChange,
		});

		expect(toggles.props['data-component']).toBe('gate-toggles');
	});

	// ─── 5. Container 容器层全量三值交互与不乐观翻转 (R4, E-299) ───
	it('GateTogglesContainer fetches initial gates and calls patcher with all 3 values (E-299)', async () => {
		const fetcher = vi.fn().mockResolvedValue({
			gates: {
				dispatch: 'manual',
				review: 'auto',
				landing: 'manual',
			},
		});
		const patcher = vi.fn().mockResolvedValue({
			gates: {
				dispatch: 'manual',
				review: 'auto',
				landing: 'auto',
			},
		});

		const container = createElement(GateTogglesContainer, {
			initialGates: {
				dispatch: 'manual',
				review: 'auto',
				landing: 'manual',
			},
			fetcher,
			patcher,
		});

		const html = renderToStaticMarkup(container);
		expect(html).toContain('派发前');
		expect(html).toContain('审查前');
		expect(html).toContain('落地前');
	});

	// ─── 6. R4: PATCH 响应不翻转状态或提前结束 pending，只等 settings.gates_changed 回流 ───
	it('does not flip state on PATCH resolution and updates only on settings.gates_changed event (R4)', async () => {
		const patcher = vi.fn().mockResolvedValue({
			gates: {
				dispatch: 'manual',
				review: 'manual',
				landing: 'auto',
			},
		});

		const el = createElement(GateTogglesContainer, {
			initialGates: initialValues,
			patcher,
		});

		const html = renderToStaticMarkup(el);
		expect(html).toContain('data-component="gate-toggles"');
		expect(html).toContain('data-pending="false"');
	});
});
