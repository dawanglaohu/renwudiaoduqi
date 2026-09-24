/**
 * packages/web/src/lib/stage-rows.ts
 *
 * 阶段链行与阶段衍生纯函数库（M9-T21 / 07 节前端架构 / 11 节 UI）
 *
 * 规范依据：
 * - src/lib/ 只放纯函数：不 import React、不 import src/ 下其他目录，零模块级副作用
 * - 阶段定义顺序来自 shared 的 PIPELINE_STAGES = ['implement','review','bughunt','landing']
 *   （lib/ 只 import type，值由调用方作 stageOrder 传入，E-332）
 * - rework / queued 落在实施行，不是独立行（E-332）
 * - 未知 stage 显示「—」、未来行不画、不抛错（E-332）
 * - 「查 bug」行只在存在 kind='bughunt' 运行时出现、不画「已跳过」节点（E-306, AC 4）
 * - 「落地」行恒最后（AC 4）
 * - 返工回环由 LOOP_PIECES 按行片段画在 20px 轨列内，reworkCount=0 不画（AC 3）
 * - 查 bug 后再审的回环指向审查行且轮次沿用同一计数（E-307）
 * - 空闲泳道渲染 idleText，不画假链（AC 7, E-319）
 */

import type { LaneStage, PipelineStage } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { LOOP_PIECES, type SpineLoopPiece } from './spine-shape.ts';

export type StageRowStatus = 'done' | 'current' | 'future';

export interface StageRow {
	/** 阶段唯一标识符（如 'implement', 'review', 'bughunt', 'landing'） */
	readonly id: string;
	/** 阶段类型 */
	readonly stage: PipelineStage | string;
	/** 展示文案标签（「实施」「排队」「返工实施 · 第 N 轮」「审查」「审查 · 第 N 轮」「查 bug」「落地」「—」） */
	readonly label: string;
	/** 阶段状态：'done'（已过阶段折一行带总耗时）| 'current'（当前阶段）| 'future'（未来虚线阶段） */
	readonly status: StageRowStatus;
	/** 阶段耗时（毫秒数值，未来阶段为 null，AC 2） */
	readonly durationMs: number | null;
	/** 该阶段对应的最近一次运行 ID（用于点击打开详情，AC 5, E-313） */
	readonly runId: string | null;
	/** 对应轨段形态（'done' | 'live' | 'pending' | 'waiting' 等） */
	readonly spineKind: 'done' | 'live' | 'pending' | 'waiting' | 'stopped' | 'failed';
	/** 节点尺寸级别：阶段大节点恒为 'stage' (12px) */
	readonly spineLevel: 'stage';
	/** 返工回环片段（仅在 reworkCount >= 1 时生成，AC 3） */
	readonly loop?: SpineLoopPiece;
	/** 是否支持键盘焦点与交互（readOnly 或 runId=null 时为 false，AC 5, E-313, E-314） */
	readonly interactive: boolean;
	/** 该阶段对应的运行列表 */
	readonly stageRuns: readonly RunDto[];
	/** 是否为未来阶段 */
	readonly isFuture: boolean;
	/** 是否为当前阶段 */
	readonly isCurrent: boolean;
	/** 是否为已过阶段 */
	readonly isDone: boolean;
}

export interface StageRowInput {
	/** 当前泳道所处的阶段（来自 daemon LaneView.stage） */
	readonly currentStage?: LaneStage | string | null;
	/** 阶段定义顺序（来自 shared PIPELINE_STAGES，由调用方传入，lib 只 import type，E-332） */
	readonly stageOrder: readonly PipelineStage[];
	/** 该任务或泳道关联的全部运行列表 */
	readonly runs?: readonly RunDto[];
	/** 返工轮次（reworkCount，>=1 时显示「第 N 轮」= reworkCount + 1） */
	readonly reworkCount?: number;
	/** 是否处于只读状态（如历史行展开态，E-314） */
	readonly readOnly?: boolean;
	/** 是否为收口运行（收口泳道） */
	readonly isWrapup?: boolean;
	/** 收口运行轮次 */
	readonly wrapupRound?: number | null;
	/** 强制指定是否存在查 bug 运行（若未提供则根据 runs 中是否有 kind='bughunt' 判定） */
	readonly hasBughuntRun?: boolean;
}

const KNOWN_LANE_STAGES = new Set<string>([
	'idle',
	'queued',
	'implement',
	'rework',
	'review',
	'bughunt',
	'wrapup',
]);

/**
 * 判断泳道是否处于空闲态（纯函数，避免展示层比较阶段字面量，E-317）。
 */
export function isLaneIdle(stage: LaneStage | string | null | undefined): boolean {
	return stage === 'idle' || stage === null || stage === undefined;
}

/**
 * 判断泳道是否为收口泳道（纯函数，避免展示层比较阶段字面量，E-317）。
 */
export function isLaneWrapup(stage: LaneStage | string | null | undefined): boolean {
	return stage === 'wrapup';
}

/**
 * 获取泳道的外壳分类（纯函数，供 StreamColumn kind 消费，E-317）。
 */
export function getLaneKind(
	stage: LaneStage | string | null | undefined,
): 'idle' | 'wrapup' | 'task' {
	if (isLaneIdle(stage)) return 'idle';
	if (isLaneWrapup(stage)) return 'wrapup';
	return 'task';
}

/**
 * 格式化空闲泳道提示文案（AC 7, E-319）。
 */
export function formatIdleText(
	nextTaskId: string | null | undefined,
	nextBlockedBy?: readonly string[] | null,
): string {
	if (!nextTaskId) {
		return '空闲 · 本批已全部派出';
	}
	if (nextBlockedBy && nextBlockedBy.length > 0) {
		return `空闲 · 队列下一个是 ${nextTaskId}（等 ${nextBlockedBy.join('、')} 落地）`;
	}
	return `空闲 · 队列下一个是 ${nextTaskId}`;
}

/**
 * 计算单个运行的耗时毫秒数（兼容 startedAt/endedAt 字段推算与已有的 durationMs 属性）。
 */
export function getRunDurationMs(run: RunDto): number | null {
	const anyRun = run as unknown as { durationMs?: number | null };
	if (typeof anyRun.durationMs === 'number') {
		return anyRun.durationMs;
	}
	if (!run.startedAt) return null;
	const start = Date.parse(run.startedAt);
	if (Number.isNaN(start)) return null;
	const end = run.endedAt
		? Date.parse(run.endedAt)
		: run.lastEventAt
			? Date.parse(run.lastEventAt)
			: null;
	if (end && !Number.isNaN(end) && end >= start) {
		return end - start;
	}
	return null;
}

/**
 * 格式化阶段耗时（毫秒数值转标准短文本；未来阶段或无数据返回 '' 空字符串，AC 2）。
 */
export function formatStageDuration(rawMs: number | null | undefined): string {
	if (rawMs === null || rawMs === undefined) {
		return '';
	}
	if (!Number.isFinite(rawMs) || rawMs <= 0) {
		return '—';
	}
	const totalSeconds = Math.floor(rawMs / 1000);
	if (totalSeconds < 1) {
		return `${Math.round(rawMs)}ms`;
	}
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const remainingSeconds = totalSeconds % 60;
	if (minutes < 60) {
		return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/**
 * 将 LaneStage 标准化为核心流水线阶段（rework / queued 落在 implement 实施行，E-332）。
 */
function normalizeStageToPipeline(stage: string): PipelineStage | null {
	switch (stage) {
		case 'queued':
		case 'implement':
		case 'rework':
			return 'implement';
		case 'review':
			return 'review';
		case 'bughunt':
			return 'bughunt';
		case 'landing':
			return 'landing';
		default:
			return null;
	}
}

/**
 * 计算单个阶段的标签文案（E-332, AC 2, AC 3）。
 */
function getStageLabel(stage: PipelineStage, currentStage: string, reworkCount: number): string {
	switch (stage) {
		case 'implement': {
			if (currentStage === 'queued') {
				return '排队';
			}
			if (currentStage === 'rework') {
				return reworkCount >= 1 ? `返工实施 · 第 ${reworkCount + 1} 轮` : '返工实施';
			}
			return '实施';
		}
		case 'review':
			return reworkCount >= 1 ? `审查 · 第 ${reworkCount + 1} 轮` : '审查';
		case 'bughunt':
			return '查 bug';
		case 'landing':
			return '落地';
	}
}

/**
 * 衍生流水线阶段链各行数据模型（核心纯函数）。
 */
export function deriveStageRows(input: StageRowInput): readonly StageRow[] {
	const {
		currentStage,
		stageOrder,
		runs = [],
		reworkCount = 0,
		readOnly = false,
		isWrapup = false,
		wrapupRound = null,
	} = input;

	// 1. 空闲态泳道不画假链（AC 7, E-319）
	if (isLaneIdle(currentStage)) {
		return [];
	}

	// 2. 收口泳道独立阶段行
	if (isWrapup || currentStage === 'wrapup') {
		const roundText = wrapupRound && wrapupRound >= 1 ? `第 ${wrapupRound} 轮` : '';
		const label = roundText ? `批次收口 · ${roundText}` : '批次收口';
		const totalMs = runs.reduce((acc, r) => acc + (getRunDurationMs(r) ?? 0), 0);
		const latestRun = runs[runs.length - 1] ?? null;

		return [
			{
				id: 'wrapup',
				stage: 'wrapup',
				label,
				status: 'current',
				durationMs: totalMs > 0 ? totalMs : null,
				runId: latestRun?.id ?? null,
				spineKind: readOnly ? 'done' : 'live',
				spineLevel: 'stage',
				interactive: !readOnly && Boolean(latestRun?.id),
				stageRuns: runs,
				isFuture: false,
				isCurrent: true,
				isDone: false,
			},
		];
	}

	const stageStr = currentStage ?? '';

	// 3. 未知阶段：E-332 规定 stage 不在 LANE_STAGES 内显示「—」、未来行不画、不抛错
	if (!KNOWN_LANE_STAGES.has(stageStr)) {
		return [
			{
				id: 'unknown',
				stage: stageStr,
				label: '—',
				status: 'current',
				durationMs: null,
				runId: null,
				spineKind: readOnly ? 'done' : 'live',
				spineLevel: 'stage',
				interactive: false,
				stageRuns: [],
				isFuture: false,
				isCurrent: true,
				isDone: false,
			},
		];
	}

	// 4. 判断是否出现过查 bug 运行（AC 4, E-306）
	// 「查 bug」行只在存在 kind='bughunt' 运行时出现、不画「已跳过」节点；未来行不预画 bughunt
	const hasBughuntRun =
		input.hasBughuntRun ?? (runs.some((r) => r.kind === 'bughunt') || stageStr === 'bughunt');

	// 5. 过滤出本次任务应当呈现的阶段清单
	// 阶段顺序来自传入的 stageOrder（shared PIPELINE_STAGES = ['implement','review','bughunt','landing']）
	// 去掉 bughunt（若无 bughunt 运行），落地恒最后（AC 4）
	const activePipelineStages = stageOrder.filter((stage) => {
		if (stage === 'bughunt' && !hasBughuntRun) {
			return false;
		}
		return true;
	});

	const activeStage = normalizeStageToPipeline(stageStr);
	const activeIndex = activeStage ? activePipelineStages.indexOf(activeStage) : -1;

	// 6. 按阶段归类运行列表，计算各阶段耗时与最近一次运行
	const runsByStage = new Map<PipelineStage, RunDto[]>();
	for (const run of runs) {
		const norm = normalizeStageToPipeline(run.kind);
		if (norm) {
			const list = runsByStage.get(norm) ?? [];
			list.push(run);
			runsByStage.set(norm, list);
		}
	}

	// 7. 判断回环类型（AC 3, E-307）：
	// 查 bug 后再审的回环指向审查行且轮次沿用同一计数（E-307）；
	// 否则常规返工实施回环指向审查行到实施行；
	// reworkCount = 0 时不画回环
	const isBughuntRework =
		reworkCount >= 1 && hasBughuntRun && (stageStr === 'review' || stageStr === 'rework');

	// 8. 构建每一行 StageRow
	return activePipelineStages.map((stage, index) => {
		const stageRuns = runsByStage.get(stage) ?? [];
		const latestRun = stageRuns[stageRuns.length - 1] ?? null;

		let status: StageRowStatus;
		if (readOnly) {
			// 只读模式（已归档历史行）：所有已执行阶段均视为 done
			status = stageRuns.length > 0 || index <= activeIndex ? 'done' : 'future';
		} else if (activeIndex === -1) {
			status = index === 0 ? 'current' : 'future';
		} else if (index < activeIndex) {
			status = 'done';
		} else if (index === activeIndex) {
			status = 'current';
		} else {
			status = 'future';
		}

		const isDone = status === 'done';
		const isCurrent = status === 'current';
		const isFuture = status === 'future';

		// 耗时计算：未来阶段留空 null（AC 2）；已过阶段总耗时；当前阶段当前累计
		let durationMs: number | null = null;
		if (!isFuture) {
			const sumMs = stageRuns.reduce((acc, r) => acc + (getRunDurationMs(r) ?? 0), 0);
			durationMs = sumMs > 0 ? sumMs : null;
		}

		// 轨形态：未来阶段虚线 pending；完成阶段实线 done；当前阶段 live
		let spineKind: StageRow['spineKind'] = 'pending';
		if (isDone) {
			spineKind = 'done';
		} else if (isCurrent) {
			spineKind = readOnly ? 'done' : 'live';
		}

		// 标签
		const label = getStageLabel(stage, stageStr, reworkCount);

		// 回环片段分配（AC 3, E-307）：
		let loop: SpineLoopPiece | undefined;
		if (reworkCount >= 1) {
			if (isBughuntRework) {
				// 查 bug -> 审查 回环：bughunt 为底部 hook+above，review 为顶部 hook+below
				if (stage === 'bughunt') {
					loop = LOOP_PIECES.bottom;
				} else if (stage === 'review') {
					loop = LOOP_PIECES.top;
				}
			} else {
				// 常规返工：review 为底部 hook+above，implement 为顶部 hook+below，中间行 through
				if (stage === 'review') {
					loop = LOOP_PIECES.bottom;
				} else if (stage === 'implement') {
					loop = LOOP_PIECES.top;
				} else if (index > 0 && index < activePipelineStages.indexOf('review')) {
					loop = LOOP_PIECES.middle;
				}
			}
		}

		// 交互判定（AC 5, E-313）：readOnly 或 runId=null 的行无 tabIndex，不可焦点导航
		const interactive = !readOnly && Boolean(latestRun?.id);

		return {
			id: stage,
			stage,
			label,
			status,
			durationMs,
			runId: latestRun?.id ?? null,
			spineKind,
			spineLevel: 'stage',
			loop,
			interactive,
			stageRuns,
			isFuture,
			isCurrent,
			isDone,
		};
	});
}
