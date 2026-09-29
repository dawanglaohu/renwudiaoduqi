/**
 * packages/web/test/login-badge.test.tsx
 *
 * login-badge 组件单元测试（AC 1, E-335, E-355）
 */

// @vitest-environment jsdom

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoginBadge } from '../src/components/login-badge.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LoginBadge (AC 1, E-335, E-355)', () => {
	let container: HTMLDivElement | null = null;
	const baseNow = new Date('2026-09-30T12:00:00.000Z').getTime();

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		if (container) {
			container.remove();
			container = null;
		}
	});

	it('renders nothing when login is null or undefined (AC 1)', () => {
		const root = createRoot(container!);
		act(() => {
			root.render(createElement(LoginBadge, { login: null }));
		});
		expect(container?.innerHTML).toBe('');

		act(() => {
			root.render(createElement(LoginBadge, { login: undefined }));
		});
		expect(container?.innerHTML).toBe('');

		act(() => {
			root.unmount();
		});
	});

	it('renders logged_in with neutral style and title with probe minutes', () => {
		const login: LoginState = {
			state: 'logged_in',
			reason: null,
			checkedAt: new Date(baseNow - 5 * 60_000).toISOString(),
			loginCommand: null,
			warningCode: null,
		};

		const root = createRoot(container!);
		act(() => {
			root.render(createElement(LoginBadge, { login, now: baseNow }));
		});

		const el = container?.querySelector('[data-testid="login-badge"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toBe('已登录');
		expect(el?.getAttribute('data-login-variant')).toBe('neutral');
		expect(el?.getAttribute('title')).toBe('5 分钟前探测');

		act(() => {
			root.unmount();
		});
	});

	it('renders logged_out with warm style (AC 1)', () => {
		const login: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: new Date(baseNow - 2 * 60_000).toISOString(),
			loginCommand: 'codex login',
			warningCode: null,
		};

		const root = createRoot(container!);
		act(() => {
			root.render(createElement(LoginBadge, { login, now: baseNow }));
		});

		const el = container?.querySelector('[data-testid="login-badge"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toBe('未登录');
		expect(el?.getAttribute('data-login-variant')).toBe('warm');

		act(() => {
			root.unmount();
		});
	});

	it('renders unknown as 无法判定 with neutral style (AC 1)', () => {
		const login: LoginState = {
			state: 'unknown',
			reason: 'timeout',
			checkedAt: new Date(baseNow - 10 * 60_000).toISOString(),
			loginCommand: null,
			warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
		};

		const root = createRoot(container!);
		act(() => {
			root.render(createElement(LoginBadge, { login, now: baseNow }));
		});

		const el = container?.querySelector('[data-testid="login-badge"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toBe('无法判定');
		expect(el?.getAttribute('data-login-variant')).toBe('neutral');

		act(() => {
			root.unmount();
		});
	});

	it('renders dashed expired variant without opacity when checkedAt > 24 hours (AC 1, AC 9)', () => {
		const expiredLogin: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: new Date(baseNow - 26 * 3600_000).toISOString(),
			loginCommand: 'codex login',
			warningCode: null,
		};

		const root = createRoot(container!);
		act(() => {
			root.render(createElement(LoginBadge, { login: expiredLogin, now: baseNow }));
		});

		const el = container?.querySelector('[data-testid="login-badge"]');
		expect(el).not.toBeNull();
		expect(el?.textContent).toBe('未登录 · 已过期');
		expect(el?.getAttribute('data-login-variant')).toBe('expired');
		// Must use dashed border
		expect(el?.className).toContain('border-dashed');
		// Must not use opacity
		expect(el?.className).not.toContain('opacity-');

		act(() => {
			root.unmount();
		});
	});
});
