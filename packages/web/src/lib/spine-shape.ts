/**
 * packages/web/src/lib/spine-shape.ts
 *
 * 形状枚举与字形映射表（M9-T2 / E-110, E-172, E-230, E-231, E-232, E-233, E-234）
 *
 * 纯函数库（src/lib/ 约束）：
 * - 不 import React、不 import src/ 下其他目录，零模块级副作用
 * - 12 个状态形状为单色描边/填充内联 SVG，一律 currentColor，绝无颜色字面量（E-231）
 * - 「失联」「审查未完成」「未识别／降级」各有专属形状，绝不复用 ✕（E-230）
 * - 统一 viewBox="0 0 16 16" 与 vector-effect: non-scaling-stroke（E-232）
 * - 每个形状带中文 aria-label 与语义字符来源（E-233、E-110）
 * - 浅色深色两模式逐一对应，不依赖深色发光或光晕（E-172）
 * - 形状表与状态枚举 1:1 对应且机检完备，不允许先上线后补形状（E-234）
 * - 覆盖 07 节与 11 节约定的 6 个步骤类型形状
 */

import type { RunState } from '@agent-scheduler/shared/api/runs';

/**
 * 运行状态到状态徽标的 13 态映射表（M2-T8 / E-234）。
 * 以 satisfies 覆盖全部 13 个 RunState，删去任一键即 tsc 报错。
 */
export const RUN_STATE_TO_STATUS = {
	queued: 'queued',
	starting: 'thinking',
	running: 'thinking',
	awaiting_reply: 'awaiting_input',
	exited: 'succeeded',
	reviewing: 'thinking',
	reworking: 'thinking',
	awaiting_human: 'awaiting_input',
	orphaned: 'orphaned',
	landed: 'succeeded',
	failed: 'failed',
	aborted: 'stopped',
	interrupted: 'stopped',
} as const satisfies Record<RunState, string>;

/**
 * 非运行状态映射的额外前端状态（步骤类型与专属边界态）。
 */
export const EXTRA_STATUS_STATES = [
	'tool',
	'streaming',
	'partial',
	'review_incomplete',
	'unrecognized',
] as const;

export type RunDerivedStatus = (typeof RUN_STATE_TO_STATUS)[RunState];
export type ExtraStatusState = (typeof EXTRA_STATUS_STATES)[number];

/**
 * 运行状态徽标的标准状态枚举类型：
 * 由 RUN_STATE_TO_STATUS 派生的运行状态与 EXTRA_STATUS_STATES 联合构成。
 */
export type StatusState = RunDerivedStatus | ExtraStatusState;

/**
 * 运行状态徽标的 12 个标准状态枚举（11 节状态表 9 态 + E-230 补齐 3 态）。
 * 顺序固定，与 STATUS_SHAPES 严格 1:1 对应。
 */
export const STATUS_STATES = [
	'queued',
	'thinking',
	'tool',
	'streaming',
	'awaiting_input',
	'succeeded',
	'partial',
	'failed',
	'stopped',
	'orphaned',
	'review_incomplete',
	'unrecognized',
] as const satisfies readonly StatusState[];

type AssertStatusStatesExhaustive = [
	Exclude<StatusState, (typeof STATUS_STATES)[number]>,
	Exclude<(typeof STATUS_STATES)[number], StatusState>,
] extends [never, never]
	? true
	: never;
const _assertStatusStatesExhaustive: AssertStatusStatesExhaustive = true;

/**
 * 运行流步骤的 6 个类型枚举（07 节与 11 节）。
 */
export const STEP_TYPES = [
	'thinking',
	'tool',
	'file_write',
	'network',
	'awaiting_input',
	'output',
] as const;

export type StepType = (typeof STEP_TYPES)[number];

/**
 * 单个 SVG 节点描述对象（无 React 依赖的纯数据结构）。
 */
export interface SvgElementSpec {
	readonly tag: 'path' | 'rect' | 'circle' | 'line' | 'polyline' | 'polygon';
	readonly attrs: Readonly<Record<string, string | number>>;
}

/**
 * 形状定义。
 */
export interface SpineShapeDefinition {
	/** 形状唯一标识符 */
	readonly id: StatusState | StepType;
	/** 形状名称 */
	readonly name: string;
	/** 中文可访问性说明（E-233, E-110） */
	readonly ariaLabel: string;
	/** 语义来源字符（11 节字符表降级为语义来源与 aria 来源，E-233） */
	readonly semanticChar: string;
	/** 默认展示文案 */
	readonly defaultText: string;
	/** 统一视口尺寸（E-232） */
	readonly viewBox: '0 0 16 16';
	/** 内联 SVG 节点清单，全部 path/node 绝无颜色字面量，一律 currentColor（E-231） */
	readonly elements: readonly SvgElementSpec[];
}

/**
 * 12 个运行状态对应的专属内联 SVG 形状（AC 1, AC 2, E-230, E-231, E-232, E-234）。
 * 统一在 16x16 坐标系下，各形状依靠几何轮廓在灰度与黑白下清晰可辨（E-110, E-172）。
 */
export const STATUS_SHAPES: Readonly<Record<StatusState, SpineShapeDefinition>> = Object.freeze({
	// 1. 排队：空心正方形 ▢
	queued: Object.freeze({
		id: 'queued',
		name: 'queued',
		ariaLabel: '排队',
		semanticChar: '▢',
		defaultText: '排队',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'rect',
				attrs: Object.freeze({
					x: 3,
					y: 3,
					width: 10,
					height: 10,
					rx: 1.5,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 2. 思考中：空心菱形 ◇
	thinking: Object.freeze({
		id: 'thinking',
		name: 'thinking',
		ariaLabel: '思考中',
		semanticChar: '◇',
		defaultText: '思考中',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 8 2.5 L 13.5 8 L 8 13.5 L 2.5 8 Z',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinejoin: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 3. 调用工具：空心正六边形 ⬡
	tool: Object.freeze({
		id: 'tool',
		name: 'tool',
		ariaLabel: '调用工具',
		semanticChar: '⬡',
		defaultText: '调用工具',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 8 2.5 L 13 5.4 L 13 10.6 L 8 13.5 L 3 10.6 L 3 5.4 Z',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinejoin: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 4. 输出中：实心垂直光标条 ▮
	streaming: Object.freeze({
		id: 'streaming',
		name: 'streaming',
		ariaLabel: '输出中',
		semanticChar: '▮',
		defaultText: '输出中',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'rect',
				attrs: Object.freeze({
					x: 5.5,
					y: 2.5,
					width: 5,
					height: 11,
					rx: 0.75,
					fill: 'currentColor',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 5. 等待输入 / 等你：实心菱形 ◆（与思考中的空心菱形 ◇ 依靠实心/空心在黑白下立判）
	awaiting_input: Object.freeze({
		id: 'awaiting_input',
		name: 'awaiting_input',
		ariaLabel: '等待输入',
		semanticChar: '◆',
		defaultText: '等你',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 8 2.5 L 13.5 8 L 8 13.5 L 2.5 8 Z',
					fill: 'currentColor',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 6. 完成：对勾 ✓
	succeeded: Object.freeze({
		id: 'succeeded',
		name: 'succeeded',
		ariaLabel: '完成',
		semanticChar: '✓',
		defaultText: '完成',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 3.5 8.5 L 6.5 11.5 L 12.5 4.5',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.75,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 7. 部分完成：左实右虚半填方块 ◧（与排队的纯空心方块、完成的对勾明显区分）
	partial: Object.freeze({
		id: 'partial',
		name: 'partial',
		ariaLabel: '部分完成',
		semanticChar: '◧',
		defaultText: '部分完成',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'rect',
				attrs: Object.freeze({
					x: 3,
					y: 3,
					width: 10,
					height: 10,
					rx: 1.5,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 4.5 3 H 8 V 13 H 4.5 C 3.67 13 3 12.33 3 11.5 V 4.5 C 3 3.67 3.67 3 4.5 3 Z',
					fill: 'currentColor',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 8,
					y1: 3,
					x2: 8,
					y2: 13,
					stroke: 'currentColor',
					strokeWidth: 1.5,
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 8. 失败：对角叉号 ✕
	failed: Object.freeze({
		id: 'failed',
		name: 'failed',
		ariaLabel: '失败',
		semanticChar: '✕',
		defaultText: '失败',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 4.5 4.5 L 11.5 11.5 M 11.5 4.5 L 4.5 11.5',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.75,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 9. 已停止：水平实心横杠 ▬（与输出中的竖条 ▮ 垂直横向互为直角区分）
	stopped: Object.freeze({
		id: 'stopped',
		name: 'stopped',
		ariaLabel: '已停止',
		semanticChar: '▬',
		defaultText: '已停止',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'rect',
				attrs: Object.freeze({
					x: 3,
					y: 6.5,
					width: 10,
					height: 3,
					rx: 1,
					fill: 'currentColor',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 10. 失联：断开的双环链扣 ⚯（E-230 专属形状，绝不复用 ✕，两环断裂分离）
	orphaned: Object.freeze({
		id: 'orphaned',
		name: 'orphaned',
		ariaLabel: '失联',
		semanticChar: '⚯',
		defaultText: '失联',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			// 左侧开口环
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 6.5 5.5 H 4.5 C 3.1 5.5 2 6.6 2 8 C 2 9.4 3.1 10.5 4.5 10.5 H 6.5',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 右侧开口环
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 9.5 5.5 H 11.5 C 12.9 5.5 14 6.6 14 8 C 14 9.4 12.9 10.5 11.5 10.5 H 9.5',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 中间断开斜切线
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 9,
					y1: 4.5,
					x2: 7,
					y2: 11.5,
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 11. 审查未完成：带未决横杠的放大镜 🔍（E-230 专属形状，绝不复用 ✕，镜面内嵌未决水平杠）
	review_incomplete: Object.freeze({
		id: 'review_incomplete',
		name: 'review_incomplete',
		ariaLabel: '审查未完成',
		semanticChar: '🔍',
		defaultText: '审查未完成',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			// 放大镜镜片圆环
			Object.freeze({
				tag: 'circle',
				attrs: Object.freeze({
					cx: 6.5,
					cy: 6.5,
					r: 4,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 镜柄
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 9.5,
					y1: 9.5,
					x2: 13.5,
					y2: 13.5,
					stroke: 'currentColor',
					strokeWidth: 2,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 镜面内中置横杠（未决/未完成标志）
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 4.5,
					y1: 6.5,
					x2: 8.5,
					y2: 6.5,
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 12. 未识别／降级：虚线圆环内嵌问号 ？（E-230 专属形状，绝不复用 ✕，未知状态符号）
	unrecognized: Object.freeze({
		id: 'unrecognized',
		name: 'unrecognized',
		ariaLabel: '未识别',
		semanticChar: '?',
		defaultText: '未识别',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			// 外围虚线圆
			Object.freeze({
				tag: 'circle',
				attrs: Object.freeze({
					cx: 8,
					cy: 8,
					r: 5.75,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.25,
					strokeDasharray: '3 1.5',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 问号弯钩
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 6.5 6 C 6.5 4.9 7.2 4.25 8 4.25 C 8.8 4.25 9.5 4.9 9.5 5.8 C 9.5 6.8 8.1 7.2 8.1 8.3',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			// 问号底点
			Object.freeze({
				tag: 'circle',
				attrs: Object.freeze({
					cx: 8,
					cy: 10.5,
					r: 0.75,
					fill: 'currentColor',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),
});

/**
 * 6 个步骤类型对应的专属内联 SVG 形状（07 节与 11 节）。
 */
export const STEP_SHAPES: Readonly<Record<StepType, SpineShapeDefinition>> = Object.freeze({
	// 思考 ◇
	thinking: STATUS_SHAPES.thinking,

	// 工具 ⬡
	tool: STATUS_SHAPES.tool,

	// 写文件 ▤：带横排文字行的文档纸张
	file_write: Object.freeze({
		id: 'file_write',
		name: 'file_write',
		ariaLabel: '写文件',
		semanticChar: '▤',
		defaultText: '写文件',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'rect',
				attrs: Object.freeze({
					x: 3.5,
					y: 2.5,
					width: 9,
					height: 11,
					rx: 1,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 5.5,
					y1: 5.5,
					x2: 10.5,
					y2: 5.5,
					stroke: 'currentColor',
					strokeWidth: 1.25,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 5.5,
					y1: 8,
					x2: 10.5,
					y2: 8,
					stroke: 'currentColor',
					strokeWidth: 1.25,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
			Object.freeze({
				tag: 'line',
				attrs: Object.freeze({
					x1: 5.5,
					y1: 10.5,
					x2: 8.5,
					y2: 10.5,
					stroke: 'currentColor',
					strokeWidth: 1.25,
					strokeLinecap: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 网络 ⌁：脉冲心跳信号线
	network: Object.freeze({
		id: 'network',
		name: 'network',
		ariaLabel: '网络请求',
		semanticChar: '⌁',
		defaultText: '网络',
		viewBox: '0 0 16 16',
		elements: Object.freeze([
			Object.freeze({
				tag: 'path',
				attrs: Object.freeze({
					d: 'M 2.5 8.5 H 5.5 L 7 4.5 L 9 11.5 L 10.5 8.5 H 13.5',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					vectorEffect: 'non-scaling-stroke',
				}),
			}),
		]),
	}),

	// 等你 ◆
	awaiting_input: STATUS_SHAPES.awaiting_input,

	// 输出 ▮
	output: STATUS_SHAPES.streaming,
});

/**
 * 别名映射字典（包含中划线别名、ReviewVerdict 别名与后端 RunState 映射）。
 */
const STATUS_STATE_ALIASES: Readonly<Record<string, StatusState>> = Object.freeze({
	...RUN_STATE_TO_STATUS,
	'awaiting-input': 'awaiting_input',
	incomplete: 'review_incomplete',
	degraded: 'unrecognized',
	unknown: 'unrecognized',
});

/**
 * 将任意状态输入规格化为 12 个标准状态之一。
 * 未知输入安全降级为 unrecognized（E-230, E-234）。
 */
export function normalizeStatusState(raw: string | undefined | null): StatusState {
	if (!raw) {
		return 'unrecognized';
	}
	const trimmed = raw.trim();
	if ((STATUS_STATES as readonly string[]).includes(trimmed)) {
		return trimmed as StatusState;
	}
	const alias = STATUS_STATE_ALIASES[trimmed];
	if (alias) {
		return alias;
	}
	return 'unrecognized';
}

/**
 * 获取指定状态的形状定义（E-234 完备性保证）。
 */
export function getStatusShape(state: StatusState): SpineShapeDefinition {
	return STATUS_SHAPES[state] ?? STATUS_SHAPES.unrecognized;
}

/**
 * 获取指定步骤类型的形状定义。
 */
export function getStepShape(type: StepType): SpineShapeDefinition {
	return STEP_SHAPES[type] ?? STEP_SHAPES.tool;
}

/**
 * 纯字符串 SVG 渲染器（无需 React 运行时，供测试、服务端或工具脚本使用）。
 */
export function renderSpineShapeSvg(
	shape: SpineShapeDefinition,
	options?: { readonly size?: number; readonly className?: string; readonly style?: string },
): string {
	const size = options?.size ?? 16;
	const classAttr = options?.className ? ` class="${escapeXml(options.className)}"` : '';
	const styleAttr = options?.style ? ` style="${escapeXml(options.style)}"` : '';

	const inner = shape.elements
		.map((el) => {
			const attrs = Object.entries(el.attrs)
				.map(([k, v]) => {
					// 转 camelCase 为 kebab-case（例如 strokeWidth -> stroke-width）
					const kebab = k.replace(/([A-Z])/g, '-$1').toLowerCase();
					return `${kebab}="${escapeXml(String(v))}"`;
				})
				.join(' ');
			return `<${el.tag} ${attrs} />`;
		})
		.join('');

	return `<svg viewBox="${shape.viewBox}" width="${size}" height="${size}" role="img" aria-label="${escapeXml(shape.ariaLabel)}" fill="none" stroke="currentColor"${classAttr}${styleAttr}>${inner}</svg>`;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}
