/**
 * packages/web/src/features/run-deck/gate-toggles-container.tsx
 *
 * 闸门开关容器组件（M9-T19 / AC 6, E-299）
 *
 * 规范依据（07 节前端架构与边界 E-299）：
 * - features 容器层：负责调用 api（http-client）、订阅 event-bus（milestone 事件）
 * - 容器里只写 grid/flex/gap 布局结构，禁止写颜色字号圆角
 * - 值走 GET/PATCH /settings/gates 全量三值（dispatch, review, landing）
 * - 状态等 settings.gates_changed 事件回流，不进行乐观翻转（E-299）
 */

import { useCallback, useEffect, useState } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import {
	SESSION_STORAGE_TOKEN_KEY,
	getCachedToken,
	httpClient,
	setCachedToken,
} from '../../api/http-client.ts';
import { type GateSettingsValues, GateToggles } from '../../components/gate-toggles.tsx';

// 模块加载时若 sessionStorage 中存在设备令牌，自动同步至内存缓存，确保路由守卫通过（07 节前端架构）
if (typeof sessionStorage !== 'undefined') {
	try {
		const stored = sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY);
		if (stored && !getCachedToken()) {
			setCachedToken(stored);
		}
	} catch {
		// 忽略无权限或隐私模式异常
	}
}

export interface GateTogglesContainerProps {
	/** 外部注入的初始闸门配置（可选，优先于异步拉取） */
	readonly initialGates?: GateSettingsValues | null;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 设置卡片 */
	readonly layout?: 'topbar' | 'settings';
	/** 自定义类名 */
	readonly className?: string;
	/** 外部自定义 fetcher / patcher（用于单元测试与集成测试） */
	readonly fetcher?: () => Promise<{ readonly gates: GateSettingsValues }>;
	readonly patcher?: (body: GateSettingsValues) => Promise<{ readonly gates: GateSettingsValues }>;
}

const DEFAULT_GATES: GateSettingsValues = {
	dispatch: 'manual',
	review: 'manual',
	landing: 'manual',
};

/**
 * 闸门开关容器。
 */
export function GateTogglesContainer({
	initialGates = null,
	layout = 'topbar',
	className = '',
	fetcher,
	patcher,
}: GateTogglesContainerProps) {
	const [gates, setGates] = useState<GateSettingsValues | null>(initialGates ?? DEFAULT_GATES);
	const [isPending, setIsPending] = useState<boolean>(false);

	// 1. 初始化拉取闸门状态
	useEffect(() => {
		let isMounted = true;

		const fetchGates = async () => {
			try {
				if (fetcher) {
					const res = await fetcher();
					if (isMounted && res?.gates) {
						setGates(res.gates);
					}
					return;
				}

				const token = getCachedToken();
				if (
					!token &&
					typeof sessionStorage !== 'undefined' &&
					!sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY)
				) {
					return;
				}

				const res = await httpClient.get<{ readonly gates: GateSettingsValues }>(
					'/api/v1/settings/gates',
				);
				if (isMounted && res?.gates) {
					setGates(res.gates);
				}
			} catch {
				// 静默或由全局 errorSink 处理
			}
		};

		if (!initialGates) {
			void fetchGates();
		} else {
			setGates(initialGates);
		}

		return () => {
			isMounted = false;
		};
	}, [initialGates, fetcher]);

	// 2. 订阅 settings.gates_changed milestone 事件回流（E-299）
	useEffect(() => {
		const unsub = eventBus.subscribeMilestone((envelope) => {
			if (envelope.kind === 'settings.gates_changed' && envelope.payload) {
				const payload = envelope.payload as { readonly gates?: GateSettingsValues };
				if (payload.gates) {
					setGates(payload.gates);
					setIsPending(false);
				}
			}
		});

		return () => {
			unsub();
		};
	}, []);

	// 3. 提交全量三值 PATCH 更新（不翻转状态、不提前结束 pending，只等事件回流，R4, E-299）
	const handleChange = useCallback(
		async (nextValues: GateSettingsValues) => {
			setIsPending(true);

			try {
				if (patcher) {
					await patcher(nextValues);
				} else {
					await httpClient.patch<{ readonly gates: GateSettingsValues }>(
						'/api/v1/settings/gates',
						nextValues,
					);
				}
				// 注意：PATCH 成功响应后绝不翻转状态，也不结束 pending（R4），严格等待 settings.gates_changed 回流
			} catch {
				// 仅在网络或服务端报错失败时恢复 pending 态，保持服务端当前真实数据
				setIsPending(false);
			}
		},
		[patcher],
	);

	return (
		<div className={['flex flex-col gap-1', className].filter(Boolean).join(' ')}>
			<GateToggles value={gates} isPending={isPending} layout={layout} onChange={handleChange} />
		</div>
	);
}

export default GateTogglesContainer;
