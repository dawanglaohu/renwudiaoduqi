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
import { getInvalidationPrefixesForEvent } from '../../api/cache-invalidation.ts';
import { settingsPipeline } from '../../api/cache-keys.ts';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { invalidate, read, refetchAll, unregister } from '../../api/resource-cache.ts';
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
	readonly field?: string | null;
	readonly fieldErrors?: Readonly<Record<string, string>>;
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

function samePipeline(a: PipelineSettings, b: PipelineSettings): boolean {
	return (
		a.bughunt === b.bughunt &&
		a.wrapupMode === b.wrapupMode &&
		JSON.stringify(a.reviewOverride) === JSON.stringify(b.reviewOverride) &&
		JSON.stringify(a.wrapupAssignment) === JSON.stringify(b.wrapupAssignment)
	);
}

export function toPipelineSettingsError(error: unknown, fallback: string): PipelineSettingsError {
	if (isApiError(error)) {
		let message = getErrorMessage(error.code);
		let stage: string | null = null;
		let field: string | null = null;
		const fieldErrors: Record<string, string> = {};

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

		// AC 8 / E-356: E_VALIDATION 的 details.field 点路径就地渲染到对应控件下
		if (error.code === 'E_VALIDATION' && error.details && typeof error.details === 'object') {
			const rawField = (error.details as Record<string, unknown>).field;
			if (typeof rawField === 'string' && rawField) {
				field = rawField;
				fieldErrors[rawField] = message;
			}
		}

		return {
			code: error.code,
			message,
			stage,
			field,
			fieldErrors,
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
	readonly fieldErrors: Readonly<Record<string, string>>;
}

export interface PipelineSettingsSource {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => PipelineSettingsSnapshot;
	readonly updatePipelineSettings: (partial: Partial<UpdatePipelineSettingsBody>) => Promise<void>;
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
		fieldErrors: {},
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

	async function readSettings(
		recover = false,
		eventPipeline: PipelineSettings | null = null,
	): Promise<void> {
		// 恢复时先等已发出的 HTTP 结算，GET 才能读到最终持久值。
		if (recover && patchCompletion) await patchCompletion;
		if (listeners.size === 0) return;
		const pendingAtRead = pendingPatch?.httpDone ? pendingPatch : null;
		const requestVersion = sourceVersion;
		const requestReadVersion = ++readVersion;
		try {
			const fetcher =
				options.fetcher ??
				(async () => {
					if (!getPipelineRoute) {
						throw new Error('GET /api/v1/settings/pipeline route missing');
					}
					return httpClient.callRoute<GetPipelineSettingsResponse>(getPipelineRoute);
				});

			// 恢复前主动使 settings 缓存失效，确保拉取 daemon 端最新数据
			if (recover) {
				invalidate('settings');
				await refetchAll();
				if (listeners.size === 0 || requestReadVersion !== readVersion) return;
			}

			// 通过 resource-cache 共享缓存读取流水线设置（AC 1, AC 2）
			const res = await read(settingsPipeline(), fetcher);
			if (listeners.size === 0 || requestReadVersion !== readVersion) return;
			if (res?.pipeline && sourceVersion === requestVersion) {
				if (eventPipeline && !samePipeline(res.pipeline, eventPipeline)) {
					// 事件已给出完整权威值，旧 GET 只用于补缓存，不能回写快照。
					invalidate('settings');
					return;
				}
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
			// AC 2: 消费失效表，前缀粒度触发 resource-cache 失效
			const prefixes = getInvalidationPrefixesForEvent(envelope.kind);
			for (const prefix of prefixes) {
				invalidate(prefix);
			}

			if (envelope.kind === 'settings.pipeline_changed') {
				const payload = envelope.payload as { readonly pipeline?: PipelineSettings } | undefined;
				if (payload?.pipeline) {
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
					void readSettings(false, payload.pipeline);
				} else {
					// 截断事件或无内联数据时，递增 sourceVersion 防止迟到 GET 覆盖事件权威值
					sourceVersion += 1;
					// 生产入口实际消费失效并重取（AC 2）
					void readSettings(false);
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

	const updatePipelineSettings = async (partial: Partial<UpdatePipelineSettingsBody>) => {
			const pipeline = snapshot.pipeline;
			if (!pipeline || pendingPatch) return;
			// AC 8 / E-356: PATCH 永远发四键全量
			const fullBody: UpdatePipelineSettingsBody = {
				bughunt: partial.bughunt !== undefined ? partial.bughunt : pipeline.bughunt,
				wrapupMode: partial.wrapupMode !== undefined ? partial.wrapupMode : pipeline.wrapupMode,
				reviewOverride:
					partial.reviewOverride !== undefined
						? partial.reviewOverride
						: pipeline.reviewOverride,
				wrapupAssignment:
					partial.wrapupAssignment !== undefined
						? partial.wrapupAssignment
						: pipeline.wrapupAssignment,
			};
			const pending: PendingPipelinePatch = {
				body: fullBody,
				deviceId: readCurrentDeviceId(),
				httpDone: false,
				eventSeen: false,
			};
			pendingPatch = pending;
			sourceVersion += 1;
			// pending 期间四个控件一起 disabled
			publish({ isPending: true, error: null, fieldErrors: {} });
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
					const parsedError = toPipelineSettingsError(
						cause,
						'流水线设置未能保存，请稍后重试',
					);
					publish({
						error: parsedError,
						fieldErrors: parsedError.fieldErrors ?? {},
					});
				}
			})();
			patchCompletion = completion;
			await completion;
			if (patchCompletion === completion) patchCompletion = null;
		};

		const updatePipelineToggles = async (partial: {
			bughunt?: 0 | 1;
			wrapupMode?: 'auto' | 'manual';
		}) => {
			return updatePipelineSettings(partial);
		};

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
						unregister(settingsPipeline());
						if (!options.initialPipeline) publish({ pipeline: null, error: null });
					}
				};
			},
			updatePipelineSettings,
			updatePipelineToggles,
			clearError: () => publish({ error: null, fieldErrors: {} }),
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
		updatePipelineSettings: source.updatePipelineSettings,
		updatePipelineToggles: source.updatePipelineToggles,
		clearError: source.clearError,
	};
}
