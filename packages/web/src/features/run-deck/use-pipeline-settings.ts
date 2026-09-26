/**
 * packages/web/src/features/run-deck/use-pipeline-settings.ts
 *
 * 流水线设置获取、订阅与四键全量更新 Hook（M9-T22 / AC 2, AC 5, E-157, E-318, E-356）
 *
 * 规范依据（07 节前端架构、边界 E-157、E-318、E-356）：
 * - features 容器层专用，唯一允许 import src/api
 * - 初始化从 GET /api/v1/settings/pipeline 读取完整四键
 * - 切换开关触发 PATCH /api/v1/settings/pipeline 时，用当前缓存的 reviewOverride / wrapupAssignment
 *   补齐后发送【四键全量】（E-356），严禁漏键
 * - pending 期间 disabled 且 DOM 不翻转，严格等待 settings.pipeline_changed 事件回流（E-157, E-318）
 * - E_PIPELINE_STAGE_DISABLED 按 details.stage 格式化为就地提示数据，不 toast（AC 5）
 */

import { ROUTES, type RouteDefinition } from '@agent-scheduler/shared/api/routes';
import type {
	GetPipelineSettingsResponse,
	PipelineSettings,
	UpdatePipelineSettingsBody,
	UpdatePipelineSettingsResponse,
} from '@agent-scheduler/shared/api/settings';
import { useMemo, useSyncExternalStore } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { sseClient } from '../../api/sse-client.ts';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';
import { readCurrentDeviceId } from '../../shell/shell-bridge.ts';
import { registerResyncHandler } from '../../store/connection-store.ts';

const getPipelineRoute: RouteDefinition | undefined = ROUTES.find(
	(r) => r.method === 'GET' && r.path === '/api/v1/settings/pipeline',
);

const patchPipelineRoute: RouteDefinition | undefined = ROUTES.find(
	(r) => r.method === 'PATCH' && r.path === '/api/v1/settings/pipeline',
);

export interface PipelineSettingsError {
	readonly code?: string;
	readonly message: string;
	readonly technical: string;
	readonly stage?: string | null;
}

export interface UsePipelineSettingsOptions {
	readonly initialPipeline?: PipelineSettings | null;
	readonly fetcher?: () => Promise<GetPipelineSettingsResponse>;
	readonly patcher?: (body: UpdatePipelineSettingsBody) => Promise<UpdatePipelineSettingsResponse>;
	readonly source?: PipelineSettingsSource;
}

interface PendingPipelinePatch {
	readonly body: UpdatePipelineSettingsBody;
	readonly deviceId: string | null;
	httpDone: boolean;
	eventSeen: boolean;
}

function matchesPendingPatch(
	pipeline: PipelineSettings,
	actorDeviceId: string | null,
	pending: PendingPipelinePatch,
): boolean {
	return (
		(!pending.deviceId || actorDeviceId === pending.deviceId) &&
		pipeline.bughunt === pending.body.bughunt &&
		pipeline.wrapupMode === pending.body.wrapupMode &&
		JSON.stringify(pipeline.reviewOverride) === JSON.stringify(pending.body.reviewOverride) &&
		JSON.stringify(pipeline.wrapupAssignment) === JSON.stringify(pending.body.wrapupAssignment)
	);
}

export function toPipelineSettingsError(error: unknown, fallback: string): PipelineSettingsError {
	if (isApiError(error)) {
		let message = getErrorMessage(error.code);
		let stage: string | null = null;

		// AC 5: E_PIPELINE_STAGE_DISABLED 按 details.stage 就地展示具体阶段
		if (
			error.code === 'E_PIPELINE_STAGE_DISABLED' &&
			error.details &&
			typeof error.details === 'object'
		) {
			const rawStage = (error.details as Record<string, unknown>).stage;
			if (typeof rawStage === 'string' && rawStage) {
				stage = rawStage;
				const stageName = UI_STRINGS.stages[rawStage as keyof typeof UI_STRINGS.stages] ?? rawStage;
				message = `当前流水线阶段已停用（${stageName}）`;
			}
		}

		return {
			code: error.code,
			message,
			stage,
			technical: `${error.code} · ${error.message}${error.requestId ? ` · requestId=${error.requestId}` : ''}`,
		};
	}

	return {
		message: fallback,
		technical: error instanceof Error ? error.message : String(error),
	};
}

interface PipelineSettingsSnapshot {
	readonly pipeline: PipelineSettings | null;
	readonly isPending: boolean;
	readonly error: PipelineSettingsError | null;
}

export interface PipelineSettingsSource {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => PipelineSettingsSnapshot;
	readonly updatePipelineToggles: (partial: {
		bughunt?: 0 | 1;
		wrapupMode?: 'auto' | 'manual';
	}) => Promise<void>;
	readonly clearError: () => void;
}

/** 顶栏与设置页共用一份权威缓存及写入锁；最后一个订阅者离开时释放事件注册。 */
export function createPipelineSettingsSource(
	options: Omit<UsePipelineSettingsOptions, 'source'> = {},
): PipelineSettingsSource {
	let snapshot: PipelineSettingsSnapshot = {
		pipeline: options.initialPipeline ?? null,
		isPending: false,
		error: null,
	};
	const listeners = new Set<() => void>();
	let sourceVersion = 0;
	let readVersion = 0;
	let pendingPatch: PendingPipelinePatch | null = null;
	let patchCompletion: Promise<void> | null = null;
	let cleanup: (() => void) | null = null;

	function publish(update: Partial<PipelineSettingsSnapshot>): void {
		snapshot = { ...snapshot, ...update };
		for (const listener of listeners) listener();
	}

	async function readSettings(recover = false): Promise<void> {
		// 恢复时先等已发出的 HTTP 结算，GET 才能读到最终持久值。
		if (recover && patchCompletion) await patchCompletion;
		const pendingAtRead = pendingPatch?.httpDone ? pendingPatch : null;
		const requestVersion = sourceVersion;
		const requestReadVersion = ++readVersion;
		try {
			const res = options.fetcher
				? await options.fetcher()
				: getPipelineRoute
					? await httpClient.callRoute<GetPipelineSettingsResponse>(getPipelineRoute)
					: null;
			if (listeners.size === 0 || requestReadVersion !== readVersion) return;
			if (res?.pipeline && sourceVersion === requestVersion) {
				publish({ pipeline: res.pipeline, error: null });
			}
			// SSE 重放窗口过期时可能永远收不到本次事件，只能用重新读取的 daemon 值恢复。
			if (
				recover &&
				res?.pipeline &&
				sourceVersion === requestVersion &&
				pendingAtRead &&
				pendingPatch === pendingAtRead
			) {
				pendingPatch = null;
				publish({ isPending: false });
			}
		} catch (cause) {
			if (listeners.size > 0 && requestReadVersion === readVersion) {
				publish({ error: toPipelineSettingsError(cause, '读取流水线设置失败，请稍后重试') });
			}
		}
	}

	function start(): void {
		const unsub = eventBus.subscribeMilestone((envelope) => {
			if (envelope.kind === 'settings.pipeline_changed' && envelope.payload) {
				const payload = envelope.payload as { readonly pipeline?: PipelineSettings };
				if (payload.pipeline) {
					sourceVersion += 1;
					publish({ pipeline: payload.pipeline, error: null });
					const pending = pendingPatch;
					if (pending && matchesPendingPatch(payload.pipeline, envelope.actorDeviceId, pending)) {
						pending.eventSeen = true;
						if (pending.httpDone) {
							pendingPatch = null;
							publish({ isPending: false });
						}
					}
				}
			}
		});
		const unregisterResync = registerResyncHandler(() => readSettings(true));
		const unregisterReplay = sseClient.onClearBuffer(() => {
			void readSettings(true);
		});
		cleanup = () => {
			unsub();
			unregisterResync();
			unregisterReplay();
			readVersion += 1;
		};
		if (!options.initialPipeline || pendingPatch) void readSettings(true);
	}

	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener);
			if (listeners.size === 1) start();
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					cleanup?.();
					cleanup = null;
					if (!options.initialPipeline) publish({ pipeline: null, error: null });
				}
			};
		},
		async updatePipelineToggles(partial) {
			const pipeline = snapshot.pipeline;
			if (!pipeline || pendingPatch) return;
			const fullBody: UpdatePipelineSettingsBody = {
				bughunt: partial.bughunt ?? pipeline.bughunt,
				wrapupMode: partial.wrapupMode ?? pipeline.wrapupMode,
				reviewOverride: pipeline.reviewOverride,
				wrapupAssignment: pipeline.wrapupAssignment,
			};
			const pending: PendingPipelinePatch = {
				body: fullBody,
				deviceId: readCurrentDeviceId(),
				httpDone: false,
				eventSeen: false,
			};
			pendingPatch = pending;
			sourceVersion += 1;
			publish({ isPending: true, error: null });
			const completion = (async () => {
				try {
					if (options.patcher) {
						await options.patcher(fullBody);
					} else if (patchPipelineRoute) {
						await httpClient.callRoute<UpdatePipelineSettingsResponse, UpdatePipelineSettingsBody>(
							patchPipelineRoute,
							{
								body: fullBody,
							},
						);
					}

					pending.httpDone = true;
					if (pending.eventSeen && pendingPatch === pending) {
						pendingPatch = null;
						publish({ isPending: false });
					}
				} catch (cause: unknown) {
					if (pendingPatch === pending) {
						pendingPatch = null;
						publish({ isPending: false });
					}
					publish({ error: toPipelineSettingsError(cause, '流水线设置未能保存，请稍后重试') });
				}
			})();
			patchCompletion = completion;
			await completion;
			if (patchCompletion === completion) patchCompletion = null;
		},
		clearError: () => publish({ error: null }),
	};
}

const sharedPipelineSource = createPipelineSettingsSource();

export function usePipelineSettings(options: UsePipelineSettingsOptions = {}) {
	const { initialPipeline, fetcher, patcher, source: injectedSource } = options;
	const source = useMemo(
		() =>
			injectedSource ??
			(initialPipeline || fetcher || patcher
				? createPipelineSettingsSource({ initialPipeline, fetcher, patcher })
				: sharedPipelineSource),
		[initialPipeline, fetcher, patcher, injectedSource],
	);
	const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
	return {
		...state,
		updatePipelineToggles: source.updatePipelineToggles,
		clearError: source.clearError,
	};
}
