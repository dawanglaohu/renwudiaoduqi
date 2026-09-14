import type { ReactNode } from 'react';

export interface InlineNoticeProps {
	readonly tone: 'muted' | 'down';
	readonly message: ReactNode;
	readonly technical?: string;
	readonly testId?: string;
}

/**
 * 就地提示条（加载中 / 就地错误）——纯 props，颜色字号圆角都在这一层，
 * 容器只负责摆位置，不再写颜色/字号/圆角（07 节 features 分层规则）。
 * daemon 的英文开发者 message 只进可展开的技术详情。
 */
export function InlineNotice({ tone, message, technical, testId }: InlineNoticeProps) {
	return (
		<div
			data-testid={testId}
			className={
				tone === 'down'
					? 'flex flex-col gap-1 rounded border border-down bg-down-soft p-3 font-ui text-meta text-down'
					: 'font-ui text-dense text-ink-3'
			}
		>
			<span>{message}</span>
			{technical && (
				<details className="text-micro text-ink-3">
					<summary className="cursor-pointer hover:text-ink-2">技术详情</summary>
					<div className="font-mono text-micro break-all">{technical}</div>
				</details>
			)}
		</div>
	);
}
