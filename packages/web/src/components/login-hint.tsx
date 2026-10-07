/**
 * packages/web/src/components/login-hint.tsx
 *
 * 登录引导提示与命令复制组件（M9-T23 / AC 1, E-336, E-355）
 *
 * 规范依据：
 * - 纯展示层组件：纯 props in / callback out
 * - state !== 'logged_in' 时渲染（isLoggedIn 时不渲染）
 * - logged_out 且 loginCommand 非空：显示「未登录：在终端运行 〈命令〉 后点刷新」+ 复制键
 * - logged_out 且 loginCommand 为空：显示「未登录：按 〈agent〉 自身文档登录后点刷新」且无复制键
 * - unknown：显示「登录态未知：确认后点刷新」（绝不说「未登录」）
 * - 组件严禁出现 'logged_*' 状态字面量，统一使用 lib/login-freshness.ts
 */

import type { LoginState } from '@agent-scheduler/shared/api/agents';
import { type HTMLAttributes, useState } from 'react';
import { UI_STRINGS } from '../i18n/ui-strings.ts';
import { isLoggedIn, isLoggedOut, isLoginUnknown } from '../lib/login-freshness.ts';

export interface LoginHintProps extends HTMLAttributes<HTMLDivElement> {
	readonly login?: LoginState | null;
	readonly agentName?: string;
}

export function LoginHint({ login, agentName = 'Agent', className = '', ...rest }: LoginHintProps) {
	const [copied, setCopied] = useState(false);

	if (!login || isLoggedIn(login)) {
		return null;
	}

	const command = login.loginCommand?.trim();

	const handleCopy = async () => {
		if (!command) return;
		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard) {
				await navigator.clipboard.writeText(command);
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			}
		} catch {
			// 剪贴板不可用时静默忽略
		}
	};

	let hintContent: React.ReactNode = null;

	if (isLoggedOut(login)) {
		if (command) {
			hintContent = (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="font-ui text-micro text-needs">
						{UI_STRINGS.login.commandPrefix}{' '}
						<code className="px-1 py-0.5 rounded bg-bg border border-border font-mono text-[11px] text-ink-1 select-all">
							{command}
						</code>{' '}
						{UI_STRINGS.login.commandSuffix}
					</span>
					<button
						type="button"
						onClick={handleCopy}
						data-testid="copy-login-command-btn"
						className="px-2 py-0.5 rounded-[4px] border border-border bg-bg hover:border-needs text-micro font-ui text-ink-2 hover:text-ink-1 transition-colors select-none"
					>
						{copied ? UI_STRINGS.login.copied : UI_STRINGS.login.copyCommand}
					</button>
				</div>
			);
		} else {
			hintContent = (
				<span className="font-ui text-micro text-needs">
					{UI_STRINGS.login.hintLoggedOutGeneric(agentName)}
				</span>
			);
		}
	} else if (isLoginUnknown(login)) {
		hintContent = (
			<span className="font-ui text-micro text-ink-2">{UI_STRINGS.login.hintUnknown}</span>
		);
	}

	return (
		<div
			data-testid="login-hint"
			className={`flex flex-col gap-1 p-2 rounded-[4px] border border-[var(--border)] bg-[var(--panel-2)] ${className}`}
			{...rest}
		>
			{hintContent}
		</div>
	);
}
