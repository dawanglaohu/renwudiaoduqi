/**
 * packages/web/src/features/run-deck/gate-toggles-container.tsx
 *
 * 闸门开关容器组件（M9-T19 / AC 6, E-299, R4）
 *
 * 规范依据（07 节前端架构与边界 E-299, 返工 R4）：
 * - features 容器层：负责调用 api（http-client）、订阅 event-bus（milestone 事件）
 * - 容器里只写 grid/flex/gap 布局结构，禁止写颜色字号圆角
 * - 值走 GET/PATCH /api/v1/settings/gates 全量三值（dispatch, review, landing）
 * - 使用 shared 定义的 GateSettings 与 UpdateGateSettingsResponse 类型，使用 ROUTES 与 httpClient.callRoute
 * - 状态等 settings.gates_changed 事件回流，不进行乐观翻转（E-299, R4）
 * - 不伪造 DEFAULT_GATES，未获取到服务端数据时显示 null 占位态
 * - 无 sessionStorage / 令牌重复代码，无任何 window 生产测试钩子
 * - 读取或 PATCH 失败就地 InlineNotice，不 toast、不整页替换（07 节错误体系）
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type {
	GateSettings,
	UpdateGateSettingsResponse,
} from '@agent-scheduler/shared/api/settings';
import { useCallback, useEffect, useRef, useState } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { sseClient } from '../../api/sse-client.ts';
import { GateToggles } from '../../components/gate-toggles.tsx';
import { InlineNotice } from '../../components/inline-notice.tsx';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import { readCurrentDeviceId } from '../../shell/shell-bridge.ts';
import { registerResyncHandler } from '../../store/connection-store.ts';

const getGatesRoute: RouteDefinition | undefined = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/settings/gates',
);

const patchGatesRoute: RouteDefinition | undefined = ROUTES.find(
	(r) => r.method === 'PATCH' && r.path === '/api/v1/settings/gates',
);

/** 就地提示用的错误：中文文案 + 可展开的技术详情（07 节错误体系）。 */
interface GateTogglesError {
	readonly message: string;
	readonly technical: string;
}

interface PendingGatePatch {
	readonly gates: GateSettings;
	readonly deviceId: string | null;
	httpDone: boolean;
	eventSeen: boolean;
}

function matchesPatch(
	gates: GateSettings,
	actorDeviceId: string | null,
	pending: PendingGatePatch,
): boolean {
	return (
		(!pending.deviceId || actorDeviceId === pending.deviceId) &&
		gates.dispatch === pending.gates.dispatch &&
		gates.review === pending.gates.review &&
		gates.landing === pending.gates.landing
	);
}

function toGateTogglesError(error: unknown, fallback: string): GateTogglesError {
	if (isApiError(error)) {
		return {
			message: getErrorMessage(error.code),
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}
	return {
		message: fallback,
		technical: error instanceof Error ? error.message : String(error),
	};
}

export interface GateTogglesContainerProps {
	/** 外部注入的初始闸门配置（可选，优先于异步拉取） */
	readonly initialGates?: GateSettings | null;
	/** 布局方向：topbar 紧凑横排（默认）或 settings 设置卡片 */
	readonly layout?: 'topbar' | 'settings';
	/** 自定义类名 */
	readonly className?: string;
	/** 外部自定义 fetcher / patcher（用于单元测试与集成测试） */
	readonly fetcher?: () => Promise<UpdateGateSettingsResponse>;
	readonly patcher?: (body: GateSettings) => Promise<UpdateGateSettingsResponse>;
}

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
	const [gates, setGates] = useState<GateSettings | null>(initialGates ?? null);
	const [isPending, setIsPending] = useState<boolean>(false);
	const [error, setError] = useState<GateTogglesError | null>(null);
	const mounted = useRef(false);
	const sourceVersion = useRef(0);
	const readVersion = useRef(0);
	const pendingPatch = useRef<PendingGatePatch | null>(null);
	const patchCompletion = useRef<Promise<void> | null>(null);

	const fetchGates = useCallback(
		async function readGates(recover = false): Promise<void> {
			// Recovery must observe the committed write, even when reconnect beats its HTTP response.
			if (recover && patchCompletion.current) await patchCompletion.current;
			if (!mounted.current) return;
			const requestVersion = sourceVersion.current;
			const requestReadVersion = ++readVersion.current;
			const pendingAtRead = pendingPatch.current?.httpDone ? pendingPatch.current : null;
			try {
				const res = fetcher
					? await fetcher()
					: getGatesRoute
						? await httpClient.callRoute<UpdateGateSettingsResponse>(getGatesRoute)
						: null;
				if (
					mounted.current &&
					requestReadVersion === readVersion.current &&
					requestVersion === sourceVersion.current &&
					res?.gates
				) {
					setGates(res.gates);
					setError(null);
					if (recover && pendingAtRead && pendingPatch.current === pendingAtRead) {
						pendingPatch.current = null;
						setIsPending(false);
					}
				} else if (
					recover &&
					mounted.current &&
					requestReadVersion === readVersion.current &&
					pendingAtRead &&
					pendingPatch.current === pendingAtRead &&
					requestVersion !== sourceVersion.current
				) {
					await readGates(true);
				}
			} catch (cause: unknown) {
				if (
					mounted.current &&
					requestReadVersion === readVersion.current &&
					requestVersion === sourceVersion.current
				) {
					setError(toGateTogglesError(cause, '读取闸门设置失败，请稍后重试'));
				}
			}
		},
		[fetcher],
	);

	useEffect(() => {
		mounted.current = true;
		if (!initialGates) {
			void fetchGates();
		} else {
			sourceVersion.current += 1;
			setGates(initialGates);
		}
		const unsub = eventBus.subscribeMilestone((envelope) => {
			if (envelope.kind === 'settings.gates_changed' && envelope.payload) {
				const payload = envelope.payload as { readonly gates?: GateSettings };
				if (payload.gates) {
					sourceVersion.current += 1;
					setGates(payload.gates);
					setError(null);
					const pending = pendingPatch.current;
					if (pending && matchesPatch(payload.gates, envelope.actorDeviceId, pending)) {
						pending.eventSeen = true;
						if (pending.httpDone) {
							pendingPatch.current = null;
							setIsPending(false);
						}
					}
				}
			}
		});
		const unregisterResync = registerResyncHandler(() => fetchGates(true));
		const unregisterReplay = sseClient.onClearBuffer(() => {
			void fetchGates(true);
		});

		return () => {
			mounted.current = false;
			readVersion.current += 1;
			unsub();
			unregisterResync();
			unregisterReplay();
		};
	}, [initialGates, fetchGates]);

	// 3. 提交全量三值 PATCH 更新（不翻转状态、不提前结束 pending，只等事件回流，R4, E-299）
	const handleChange = useCallback(
		async (nextValues: GateSettings) => {
			if (pendingPatch.current) return;
			const pending: PendingGatePatch = {
				gates: nextValues,
				deviceId: readCurrentDeviceId(),
				httpDone: false,
				eventSeen: false,
			};
			pendingPatch.current = pending;
			sourceVersion.current += 1;
			setIsPending(true);
			setError(null);

			const operation = Promise.resolve()
				.then(async () => {
					if (patcher) {
						await patcher(nextValues);
					} else if (patchGatesRoute) {
						await httpClient.callRoute<UpdateGateSettingsResponse, GateSettings>(patchGatesRoute, {
							body: nextValues,
						});
					}
					pending.httpDone = true;
					if (mounted.current && pendingPatch.current === pending && pending.eventSeen) {
						pendingPatch.current = null;
						setIsPending(false);
					}
				})
				.catch((cause: unknown) => {
					if (!mounted.current || pendingPatch.current !== pending) return;
					pendingPatch.current = null;
					setIsPending(false);
					setError(toGateTogglesError(cause, '闸门设置未能保存，请稍后重试'));
				})
				.finally(() => {
					if (patchCompletion.current === operation) patchCompletion.current = null;
				});
			patchCompletion.current = operation;
			await operation;
		},
		[patcher],
	);

	return (
		<div className={['flex flex-col gap-1', className].filter(Boolean).join(' ')}>
			<GateToggles value={gates} isPending={isPending} layout={layout} onChange={handleChange} />
			{error && (
				<InlineNotice
					tone="down"
					testId="gate-toggles-error"
					message={error.message}
					technical={error.technical}
				/>
			)}
		</div>
	);
}

export default GateTogglesContainer;
