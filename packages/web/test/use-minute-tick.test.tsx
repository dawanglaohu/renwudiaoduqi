/**
 * packages/web/test/use-minute-tick.test.tsx
 *
 * use-minute-tick hook 单元测试（AC 5, E-335, E-357）
 */

// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
