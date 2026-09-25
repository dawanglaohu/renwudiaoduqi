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
import { useCallback, useEffect, useState } from 'react';
import { eventBus } from '../../api/event-bus.ts';
import { httpClient, isApiError } from '../../api/http-client.ts';
import { getErrorMessage } from '../../i18n/error-messages.ts';
import { UI_STRINGS } from '../../i18n/ui-strings.ts';

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

export function usePipelineSettings(options: UsePipelineSettingsOptions = {}) {
	const { initialPipeline = null, fetcher, patcher } = options;
	const [pipeline, setPipeline] = useState<PipelineSettings | null>(initialPipeline);
	const [isPending, setIsPending] = useState<boolean>(false);
	const [error, setError] = useState<PipelineSettingsError | null>(null);

	// 1. 初始化拉取流水线配置（GET /api/v1/settings/pipeline）
	useEffect(() => {
		let isMounted = true;

		const fetchSettings = async () => {
			try {
				if (fetcher) {
					const res = await fetcher();
					if (isMounted && res?.pipeline) {
						setPipeline(res.pipeline);
					}
					return;
				}

				if (getPipelineRoute) {
					const res = await httpClient.callRoute<GetPipelineSettingsResponse>(getPipelineRoute);
					if (isMounted && res?.pipeline) {
						setPipeline(res.pipeline);
					}
				}
			} catch (cause: unknown) {
				if (isMounted) {
					setError(toPipelineSettingsError(cause, '读取流水线设置失败，请稍后重试'));
				}
			}
		};

		if (!initialPipeline) {
			void fetchSettings();
		} else {
			setPipeline(initialPipeline);
		}

		return () => {
			isMounted = false;
		};
	}, [initialPipeline, fetcher]);

	// 2. 订阅 settings.pipeline_changed milestone 事件回流（E-157, E-318）
	useEffect(() => {
		const unsub = eventBus.subscribeMilestone((envelope) => {
			if (envelope.kind === 'settings.pipeline_changed' && envelope.payload) {
				const payload = envelope.payload as { readonly pipeline?: PipelineSettings };
				if (payload.pipeline) {
					setPipeline(payload.pipeline);
					setIsPending(false);
					setError(null);
				}
			}
		});

		return () => {
			unsub();
		};
	}, []);

	// 3. 提交全量四键 PATCH 更新（AC 2, E-356）
	const updatePipelineToggles = useCallback(
		async (partial: { bughunt?: 0 | 1; wrapupMode?: 'auto' | 'manual' }) => {
			if (!pipeline) {
				return;
			}

			setIsPending(true);
			setError(null);

			// E-356: 四键整体写入，用当前缓存里的 reviewOverride 与 wrapupAssignment 补齐全量
			const fullBody: UpdatePipelineSettingsBody = {
				bughunt: partial.bughunt ?? pipeline.bughunt,
				wrapupMode: partial.wrapupMode ?? pipeline.wrapupMode,
				reviewOverride: pipeline.reviewOverride,
				wrapupAssignment: pipeline.wrapupAssignment,
			};

			try {
				if (patcher) {
					await patcher(fullBody);
				} else if (patchPipelineRoute) {
					await httpClient.callRoute<UpdatePipelineSettingsResponse, UpdatePipelineSettingsBody>(
						patchPipelineRoute,
						{
							body: fullBody,
						},
					);
				}
				// 成功响应后绝不提前翻转状态，也不提前结束 pending，等待回流事件
			} catch (cause: unknown) {
				// 失败才解除 pending，保持服务端真实状态，错误就地提示（E-157）
				setIsPending(false);
				setError(toPipelineSettingsError(cause, '流水线设置未能保存，请稍后重试'));
			}
		},
		[pipeline, patcher],
	);

	return {
		pipeline,
		isPending,
		error,
		updatePipelineToggles,
		clearError: () => setError(null),
	};
}
