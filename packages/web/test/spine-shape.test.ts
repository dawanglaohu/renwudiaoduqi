import { describe, expect, it } from 'vitest';
import {
	STATUS_SHAPES,
	STATUS_STATES,
	STEP_SHAPES,
	STEP_TYPES,
	type StatusState,
	getStatusShape,
	getStepShape,
	normalizeStatusState,
	renderSpineShapeSvg,
} from '../src/lib/spine-shape.ts';

describe('spine-shape (M9-T2 / E-110, E-172, E-230, E-231, E-232, E-233, E-234)', () => {
	// ─── AC 5 & E-234: 形状表与状态枚举一一对应且可机检 ───
	it('AC 5 & E-234: STATUS_STATES has exactly 12 states, and STATUS_SHAPES matches 1:1', () => {
		expect(STATUS_STATES).toHaveLength(12);

		const shapeKeys = Object.keys(STATUS_SHAPES) as StatusState[];
		expect(shapeKeys).toHaveLength(12);

		// 排序比对，必须全集完全一致
		expect([...shapeKeys].sort()).toEqual([...STATUS_STATES].sort());

		// 验证每个状态都能通过 getStatusShape 获取到专属定义
		for (const state of STATUS_STATES) {
			const shape = getStatusShape(state);
			expect(shape).toBeDefined();
			expect(shape.id).toBe(state);
			expect(typeof shape.ariaLabel).toBe('string');
			expect(shape.ariaLabel.length).toBeGreaterThan(0);
			expect(typeof shape.semanticChar).toBe('string');
			expect(shape.semanticChar.length).toBeGreaterThan(0);
			expect(typeof shape.defaultText).toBe('string');
			expect(shape.defaultText.length).toBeGreaterThan(0);
		}
	});

	// ─── AC 1 & E-231: 12 个形状为单色描边内联 SVG，一律 currentColor，无颜色字面量 ───
	it('AC 1 & E-231: all 12 shapes use currentColor or none, with zero color literals', () => {
		const COLOR_LITERAL_REGEX =
			/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgb|rgba|hsl|hsla)\(/i;

		for (const state of STATUS_STATES) {
			const shape = STATUS_SHAPES[state];
			expect(shape.elements.length).toBeGreaterThan(0);

			for (const el of shape.elements) {
				for (const [attrKey, attrVal] of Object.entries(el.attrs)) {
					const valStr = String(attrVal);
					expect(
						COLOR_LITERAL_REGEX.test(valStr),
						`Shape ${state} element ${el.tag} attribute ${attrKey}="${valStr}" must not contain color literal`,
					).toBe(false);

					if (attrKey === 'stroke') {
						expect(valStr).toBe('currentColor');
					}
					if (attrKey === 'fill') {
						expect(['currentColor', 'none']).toContain(valStr);
					}
				}
			}
		}
	});

	// ─── AC 2 & E-230: 「失联」「审查未完成」「未识别／降级」各有专属形状，绝不复用 ✕ ───
	it('AC 2 & E-230: orphaned, review_incomplete, unrecognized have dedicated shapes and do not reuse ✕', () => {
		const failedShape = STATUS_SHAPES.failed;
		const orphanedShape = STATUS_SHAPES.orphaned;
		const reviewIncompleteShape = STATUS_SHAPES.review_incomplete;
		const unrecognizedShape = STATUS_SHAPES.unrecognized;

		// 失败形状是对角叉号 ✕
		expect(failedShape.semanticChar).toBe('✕');
		expect(failedShape.ariaLabel).toBe('失败');

		// 1. 失联：专属断开双环链扣 ⚯，绝不等于 ✕
		expect(orphanedShape.ariaLabel).toBe('失联');
		expect(orphanedShape.semanticChar).not.toBe('✕');
		expect(orphanedShape.elements).not.toEqual(failedShape.elements);
		// 验证失联包含断开链条的左环、右环与切线
		expect(orphanedShape.elements).toHaveLength(3);

		// 2. 审查未完成：专属带未决横杠的放大镜 🔍，绝不等于 ✕
		expect(reviewIncompleteShape.ariaLabel).toBe('审查未完成');
		expect(reviewIncompleteShape.semanticChar).not.toBe('✕');
		expect(reviewIncompleteShape.elements).not.toEqual(failedShape.elements);
		// 验证包含镜片圆、镜柄线和内部未决横杠
		expect(reviewIncompleteShape.elements.some((e) => e.tag === 'circle')).toBe(true);
		expect(reviewIncompleteShape.elements.filter((e) => e.tag === 'line')).toHaveLength(2);

		// 3. 未识别／降级：专属虚线圆内嵌问号 ？，绝不等于 ✕
		expect(unrecognizedShape.ariaLabel).toBe('未识别');
		expect(unrecognizedShape.semanticChar).not.toBe('✕');
		expect(unrecognizedShape.elements).not.toEqual(failedShape.elements);
		// 验证包含外围虚线圆与内嵌问号
		const dashedCircle = unrecognizedShape.elements.find(
			(e) => e.tag === 'circle' && e.attrs.strokeDasharray !== undefined,
		);
		expect(dashedCircle).toBeDefined();

		// 四者两两不同
		const fourElements = [
			JSON.stringify(failedShape.elements),
			JSON.stringify(orphanedShape.elements),
			JSON.stringify(reviewIncompleteShape.elements),
			JSON.stringify(unrecognizedShape.elements),
		];
		const uniqueSets = new Set(fourElements);
		expect(uniqueSets.size).toBe(4);
	});

	// ─── AC 3 & E-232: 统一 viewBox="0 0 16 16" + vector-effect: non-scaling-stroke ───
	it('AC 3 & E-232: all 12 shapes use unified viewBox="0 0 16 16" and vector-effect: non-scaling-stroke', () => {
		for (const state of STATUS_STATES) {
			const shape = STATUS_SHAPES[state];
			expect(shape.viewBox).toBe('0 0 16 16');

			for (const el of shape.elements) {
				expect(
					el.attrs.vectorEffect,
					`Shape ${state} element ${el.tag} must declare vectorEffect="non-scaling-stroke"`,
				).toBe('non-scaling-stroke');
			}
		}
	});

	// ─── AC 4, 4b & E-110, E-172, E-233: 中文 aria-label，灰度下纯几何区分，浅色深色无发光依赖 ───
	it('AC 4 & E-233, E-110: each shape carries descriptive Chinese aria-label and distinct geometry', () => {
		const expectedLabels: Record<StatusState, string> = {
			queued: '排队',
			thinking: '思考中',
			tool: '调用工具',
			streaming: '输出中',
			awaiting_input: '等待输入',
			succeeded: '完成',
			partial: '部分完成',
			failed: '失败',
			stopped: '已停止',
			orphaned: '失联',
			review_incomplete: '审查未完成',
			unrecognized: '未识别',
		};

		for (const state of STATUS_STATES) {
			const shape = STATUS_SHAPES[state];
			expect(shape.ariaLabel).toBe(expectedLabels[state]);
		}

		// 几何轮廓在黑白下两两各异（无两形状元素完全相同）
		const serializedShapes = STATUS_STATES.map((s) => JSON.stringify(STATUS_SHAPES[s].elements));
		const uniqueShapeSet = new Set(serializedShapes);
		expect(uniqueShapeSet.size).toBe(12);
	});

	it('AC 4b & E-172: shapes rely strictly on geometry and do not include filter/shadow/glow elements', () => {
		for (const state of STATUS_STATES) {
			const shape = STATUS_SHAPES[state];
			// 形状定义内不允许出现 filter、feGaussianBlur、feDropShadow 等发光滤镜
			for (const el of shape.elements) {
				expect(['filter', 'feGaussianBlur', 'feDropShadow'].includes(el.tag)).toBe(false);
				expect(el.attrs.filter).toBeUndefined();
			}
		}
	});

	// ─── 步骤类型 6 态完备性 ───
	it('covers 6 step types from Section 07 and 11', () => {
		expect(STEP_TYPES).toHaveLength(6);
		for (const step of STEP_TYPES) {
			const shape = getStepShape(step);
			expect(shape).toBeDefined();
			expect(shape.viewBox).toBe('0 0 16 16');
			expect(shape.ariaLabel.length).toBeGreaterThan(0);
		}
		expect(STEP_SHAPES.file_write.semanticChar).toBe('▤');
		expect(STEP_SHAPES.network.semanticChar).toBe('⌁');
	});

	// ─── 别名与状态归一化解析 ───
	it('normalizeStatusState handles aliases and daemon RunStates safely', () => {
		expect(normalizeStatusState('queued')).toBe('queued');
		expect(normalizeStatusState('awaiting-input')).toBe('awaiting_input');
		expect(normalizeStatusState('awaiting_reply')).toBe('awaiting_input');
		expect(normalizeStatusState('awaiting_human')).toBe('awaiting_input');
		expect(normalizeStatusState('incomplete')).toBe('review_incomplete');
		expect(normalizeStatusState('degraded')).toBe('unrecognized');
		expect(normalizeStatusState('unknown')).toBe('unrecognized');
		expect(normalizeStatusState('landed')).toBe('succeeded');
		expect(normalizeStatusState('aborted')).toBe('stopped');
		expect(normalizeStatusState('interrupted')).toBe('stopped');
		expect(normalizeStatusState('running')).toBe('thinking');
		expect(normalizeStatusState('')).toBe('unrecognized');
		expect(normalizeStatusState(null)).toBe('unrecognized');
		expect(normalizeStatusState('non_existent_random_status')).toBe('unrecognized');
	});

	// ─── 纯 SVG 字符串渲染器 ───
	it('renderSpineShapeSvg produces valid SVG string with attributes and non-scaling-stroke', () => {
		const svgStr = renderSpineShapeSvg(STATUS_SHAPES.succeeded, {
			size: 14,
			className: 'icon-check',
		});
		expect(svgStr).toContain('viewBox="0 0 16 16"');
		expect(svgStr).toContain('width="14"');
		expect(svgStr).toContain('height="14"');
		expect(svgStr).toContain('role="img"');
		expect(svgStr).toContain('aria-label="完成"');
		expect(svgStr).toContain('class="icon-check"');
		expect(svgStr).toContain('vector-effect="non-scaling-stroke"');
		expect(svgStr).toContain('stroke="currentColor"');
	});
});
