/**
 * packages/web/test/login-hint.test.tsx
 *
 * login-hint 组件单元测试（AC 1, E-336, E-355）
 */

// @vitest-environment jsdom

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginHint } from '../src/components/login-hint.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('LoginHint (AC 1, E-336, E-355)', () => {
	let container: HTMLDivElement;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
		vi.restoreAllMocks();
	});

	it('renders nothing when login is missing or state is logged_in (AC 1)', () => {
		const root = createRoot(container);
		act(() => {
			root.render(createElement(LoginHint, { login: null }));
		});
		expect(container.innerHTML).toBe('');

		const loggedInLogin: LoginState = {
			state: 'logged_in',
			reason: null,
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: null,
			warningCode: null,
		};
		act(() => {
			root.render(createElement(LoginHint, { login: loggedInLogin }));
		});
		expect(container?.innerHTML).toBe('');

		act(() => {
			root.unmount();
		});
	});

	it('renders command prompt with copy button when logged_out and command is non-empty (AC 1)', async () => {
		const writeTextMock = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: writeTextMock },
			configurable: true,
		});

		const loggedOutWithCmd: LoginState = {
			state: 'logged_out',
			reason: 'exit_nonzero',
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: 'codex auth login',
			warningCode: null,
		};

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LoginHint, { login: loggedOutWithCmd, agentName: 'Codex' }));
		});

		const hint = container.querySelector('[data-testid="login-hint"]');
		expect(hint).not.toBeNull();
		expect(hint?.textContent).toContain('未登录：在终端运行');
		expect(hint?.textContent).toContain('codex auth login');
		expect(hint?.textContent).toContain('后点刷新');

		const copyBtn = container.querySelector(
			'[data-testid="copy-login-command-btn"]',
		) as HTMLButtonElement | null;
		expect(copyBtn).not.toBeNull();
		expect(copyBtn?.textContent).toBe('复制命令');

		// Click copy
		await act(async () => {
			copyBtn?.click();
		});

		expect(writeTextMock).toHaveBeenCalledWith('codex auth login');
		expect(copyBtn?.textContent).toBe('已复制');

		act(() => {
			root.unmount();
		});
	});

	it('renders generic fallback without copy button when logged_out and command is empty (AC 1, E-355)', () => {
		const loggedOutNoCmd: LoginState = {
			state: 'logged_out',
			reason: 'no_provider',
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: null,
			warningCode: null,
		};

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LoginHint, { login: loggedOutNoCmd, agentName: 'Pi' }));
		});

		const hint = container.querySelector('[data-testid="login-hint"]');
		expect(hint).not.toBeNull();
		expect(hint?.textContent).toContain('未登录：按 Pi 自身文档登录后点刷新');

		const copyBtn = container.querySelector('[data-testid="copy-login-command-btn"]');
		expect(copyBtn).toBeNull();

		act(() => {
			root.unmount();
		});
	});

	it('renders unknown hint without saying "未登录" when state is unknown (AC 1, E-335)', () => {
		const unknownLogin: LoginState = {
			state: 'unknown',
			reason: 'timeout',
			checkedAt: '2026-09-30T00:00:00.000Z',
			loginCommand: null,
			warningCode: 'E_AGENT_LOGIN_PROBE_FAILED',
		};

		const root = createRoot(container);
		act(() => {
			root.render(createElement(LoginHint, { login: unknownLogin, agentName: 'Grok' }));
		});

		const hint = container.querySelector('[data-testid="login-hint"]');
		expect(hint).not.toBeNull();
		expect(hint?.textContent).toContain('登录态未知：确认后点刷新');
		// Must not say "未登录"
		expect(hint?.textContent).not.toContain('未登录');

		const copyBtn = container?.querySelector('[data-testid="copy-login-command-btn"]');
		expect(copyBtn).toBeNull();

		act(() => {
			root.unmount();
		});
	});
});
