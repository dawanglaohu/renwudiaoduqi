/**
 * packages/web/test/use-minute-tick.test.tsx
 *
 * use-minute-tick hook 单元测试（AC 5, E-335, E-357）
 */

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginBadge } from '../src/components/login-badge.tsx';
import {
	_advanceTickForTesting,
	_getTimerStatusForTesting,
	useMinuteTick,
} from '../src/hooks/use-minute-tick.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('use-minute-tick (AC 5, E-335, E-357)', () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		vi.useFakeTimers();
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
		vi.useRealTimers();
	});

	it('does not start timer when there are no subscribers', () => {
		const status = _getTimerStatusForTesting();
		expect(status.listenerCount).toBe(0);
		expect(status.isTimerRunning).toBe(false);
	});

	it('starts timer when component mounts, and stops when unmounted', () => {
		function TestComponent() {
			const tick = useMinuteTick();
			return createElement('div', { 'data-testid': 'tick-display' }, String(tick));
		}

		const root = createRoot(container);
		act(() => {
			root.render(createElement(TestComponent));
		});

		expect(_getTimerStatusForTesting().isTimerRunning).toBe(true);
		expect(_getTimerStatusForTesting().listenerCount).toBe(1);

		act(() => {
			root.unmount();
		});

		expect(_getTimerStatusForTesting().listenerCount).toBe(0);
		expect(_getTimerStatusForTesting().isTimerRunning).toBe(false);
	});

	it('updates snapshot on timer tick or manual advance', () => {
		let renderedTick = 0;
		function TestComponent() {
			const tick = useMinuteTick();
			renderedTick = tick;
			return createElement('div', null, String(tick));
		}

		const root = createRoot(container);
		act(() => {
			root.render(createElement(TestComponent));
		});

		const initial = renderedTick;
		const nextTime = initial + 60_000;

		act(() => {
			_advanceTickForTesting(nextTime);
		});

		expect(renderedTick).toBe(nextTime);

		act(() => {
			root.unmount();
		});
	});

	it.each(['first subscription', 'resubscription'])(
		'%s shows an expired probe immediately after idle time',
		(mode) => {
			const checkedAt = Date.parse('2026-10-09T00:00:00Z');
			vi.setSystemTime(checkedAt);
			_advanceTickForTesting(checkedAt);
			const login = {
				state: 'logged_in' as const,
				reason: null,
				checkedAt: new Date(checkedAt).toISOString(),
				loginCommand: null,
				warningCode: null,
			};
			if (mode === 'resubscription') {
				const initialRoot = createRoot(container);
				act(() => initialRoot.render(createElement(LoginBadge, { login })));
				act(() => initialRoot.unmount());
			}
			expect(_getTimerStatusForTesting().listenerCount).toBe(0);
			vi.advanceTimersByTime(25 * 60 * 60 * 1000);
			const root = createRoot(container);
			try {
				act(() => root.render(createElement(LoginBadge, { login })));
				const badge = container.querySelector('[data-testid="login-badge"]');
				expect(badge?.textContent).toBe('已登录 · 已过期');
				expect(badge?.getAttribute('data-login-variant')).toBe('expired');
				expect(badge?.getAttribute('title')).toBe('1500 分钟前探测');
			} finally {
				act(() => root.unmount());
			}
		},
	);

	it('uses the current clock immediately when an idle clock moves backwards', () => {
		const previous = Date.parse('2026-10-09T00:00:00Z');
		vi.setSystemTime(previous);
		_advanceTickForTesting(previous);
		vi.setSystemTime(previous - 10 * 60_000);
		const root = createRoot(container);
		try {
			act(() =>
				root.render(
					createElement(LoginBadge, {
						login: {
							state: 'logged_in',
							reason: null,
							checkedAt: new Date(previous - 20 * 60_000).toISOString(),
							loginCommand: null,
							warningCode: null,
						},
					}),
				),
			);
			expect(container.querySelector('[data-testid="login-badge"]')?.getAttribute('title')).toBe(
				'10 分钟前探测',
			);
		} finally {
			act(() => root.unmount());
		}
	});
});
