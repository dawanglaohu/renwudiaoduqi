/**
 * packages/web/test/stream-column.test.ts
 *
 * M9-T9 多流甲板与密度档单元测试（AC 1-12, E-106, E-163..E-168, E-235..E-239, E-311, E-317）
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StreamColumn, type StreamColumnProps } from '../src/components/stream-column.tsx';
import { RunDeckView } from '../src/features/run-deck/run-deck-view.tsx';
import type { DeckStreamLane } from '../src/features/run-deck/types.ts';
import { isWaitingApproval } from '../src/features/run-deck/use-run-deck.ts';
import {
	type DensityTier,
	computeDensityTier,
	getStoredDensityPreference,
	setStoredDensityPreference,
} from '../src/hooks/use-breakpoint.ts';

describe('M9-T9: Multi-stream deck and density tiers (AC 1-12, E-106, E-163..E-168, E-235..E-239)', () => {
	// ─────────────────────────────────────────────────────────────────────────────
	// AC 1 & E-235: 档位是单点计算的枚举（full/compact/narrow/phone/phone-xs）并以 prop 下传
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 1 & E-235: Density tier single-point computation', () => {
		it('uses the tier prop, not a second raw-width threshold, for full three-lane layout', () => {
			const source = readFileSync(
				resolve(__dirname, '../src/features/run-deck/run-deck-view.tsx'),
				'utf8',
			);
			expect(source).not.toMatch(/streamCount\s*<=\s*3\s*&&\s*width\s*>=\s*1440/);
		});

		it('does not treat a coarse pointer in a desktop tier as a phone session', () => {
			const source = readFileSync(
				resolve(__dirname, '../src/features/run-deck/use-run-deck.ts'),
				'utf8',
			);
			expect(source).not.toMatch(/isMobileTier\s*=\s*[^;]*density\.isTouch/);
		});
		it('strictly computes one of the five enum values without scattering', () => {
			const tiers: DensityTier[] = [
				computeDensityTier({ width: 1600, streamCount: 2 }), // full
				computeDensityTier({ width: 1600, streamCount: 6 }), // compact
				computeDensityTier({ width: 1000 }), // narrow
				computeDensityTier({ width: 500, isTouch: true }), // phone
				computeDensityTier({ width: 360, isTouch: true }), // phone-xs
			];

			expect(tiers).toEqual(['full', 'compact', 'narrow', 'phone', 'phone-xs']);
		});

		it('passes tier down as prop to StreamColumn and renders on data-tier attribute', () => {
			const allTiers: readonly DensityTier[] = [
				'full',
				'compact',
				'narrow',
				'phone',
				'phone-xs',
			] as const;

			for (const tier of allTiers) {
				const html = renderToStaticMarkup(
					createElement(StreamColumn, {
						laneNo: 1,
						tier,
						taskKey: 'M9-T9',
						title: '多流甲板与密度档',
					}),
				);
				expect(html).toContain(`data-tier="${tier}"`);
			}
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 2 & E-164: 流数 >= 4 默认紧凑档，用 auto-fill 换行网格（每格 min 260px）而非横向滚动
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 2 & E-164: Stream count >= 4 defaults to compact with auto-fill wrapping grid', () => {
		it('computes compact tier by default when stream count is 4 or more on desktop', () => {
			expect(computeDensityTier({ width: 1440, streamCount: 4 })).toBe('compact');
			expect(computeDensityTier({ width: 1920, streamCount: 8 })).toBe('compact');
			expect(computeDensityTier({ width: 2560, streamCount: 12 })).toBe('compact');
		});

		it('RunDeckView renders auto-fill grid with min 260px per cell and no horizontal scroll in compact tier', () => {
			const lanes: DeckStreamLane[] = Array.from({ length: 8 }, (_, i) => ({
				laneNo: i + 1,
				taskKey: `M9-T${i + 1}`,
				title: `任务 ${i + 1}`,
				status: 'streaming',
			}));

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'compact',
					isTouch: false,
					width: 1440,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'auto',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			// 网格布局包含 auto-fill 与 min 260px
			expect(html).toContain(
				'grid-cols-[repeat(auto-fill,minmax(var(--stream-min-dense,260px),1fr))]',
			);
			// 8 条流全部渲染在 DOM 中
			for (let i = 1; i <= 8; i++) {
				expect(html).toContain(`data-lane-no="${i}"`);
			}
			// 严禁带有 overflow-x
			expect(html).not.toContain('overflow-x');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 3 & E-165: 紧凑档展开某条时该条占满宽度、其余保持 260px 留在同屏绝不折叠消失
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 3 & E-165: Expanded lane in compact tier occupies full row, others never disappear', () => {
		it('expanded stream has col-span-full and all other streams remain in the same screen', () => {
			const lanes: DeckStreamLane[] = Array.from({ length: 5 }, (_, i) => ({
				laneNo: i + 1,
				taskKey: `M9-T${i + 1}`,
				title: `任务 ${i + 1}`,
				status: 'thinking',
			}));

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'compact',
					isTouch: false,
					width: 1440,
					expandedLaneNo: 2, // 展开第 2 条流
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'compact',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			// 第 2 条流展开占满全宽（col-span-full）
			expect(html).toContain('data-lane-deck-slot="2" class="col-span-full');
			expect(html).toContain(
				'data-lane-no="2" data-lane-id="lane-2" data-tier="compact" data-expanded="true"',
			);

			// 其余流（1, 3, 4, 5）全部仍在同屏，绝无 display:none 或折叠移除
			for (const laneNo of [1, 3, 4, 5]) {
				expect(html).toContain(`data-lane-no="${laneNo}"`);
				expect(html).toContain(`data-lane-deck-slot="${laneNo}"`);
			}
		});

		it('StreamColumn renders toggle expand button when tier is compact and onToggleExpand is provided', () => {
			const collapsedHtml = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					tier: 'compact',
					isExpanded: false,
					onToggleExpand: () => {},
				}),
			);
			expect(collapsedHtml).toContain('data-action="toggle-expand"');
			expect(collapsedHtml).toContain('展开');

			const expandedHtml = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					tier: 'compact',
					isExpanded: true,
					onToggleExpand: () => {},
				}),
			);
			expect(expandedHtml).toContain('data-action="toggle-expand"');
			expect(expandedHtml).toContain('收起');
			expect(expandedHtml).toContain('data-expanded="true"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 4 & E-166: 260px 放不下时加宽列宽，不许砍掉停止控件或把状态降级成纯色点
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 4 & E-166: Column maintains stop control and full status badge with dedicated glyph', () => {
		it('preserves stop button and dedicated SVG status glyph without degrading to color dot', () => {
			const html = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					tier: 'compact',
					status: 'awaiting_input',
					taskKey: 'M9-T9',
					title: '长任务标题放不下时也保持完整控件',
				}),
			);

			// 停止控件常驻
			expect(html).toContain('data-action="stop-stream"');
			expect(html).toContain('data-resident="true"');

			// 状态徽标为字形+文字矩形，绝非纯色点
			expect(html).toContain('data-status-badge="true"');
			expect(html).toContain('data-state="awaiting_input"');
			expect(html).toContain('data-shape="awaiting_input"');
			expect(html).toContain('等你');
			expect(html).not.toContain('rounded-full');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 5 & E-236, E-106: 停止控件与审批槽位渲染在所有档位分支之外（逐档断言单测）
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 5 & E-236, E-106: Mandatory presence of stop button and approval slot across ALL tiers', () => {
		const ALL_TIERS: readonly DensityTier[] = [
			'full',
			'compact',
			'narrow',
			'phone',
			'phone-xs',
		] as const;

		for (const tier of ALL_TIERS) {
			it(`renders stop control and approval slot unconditionally in tier "${tier}"`, () => {
				const gateSlotContent = createElement(
					'div',
					{ 'data-test-gate': 'gate-waiting' },
					'人工审批卡内容',
				);

				const html = renderToStaticMarkup(
					createElement(StreamColumn, {
						laneNo: 3,
						tier,
						taskKey: 'M9-T9',
						status: 'awaiting_input',
						gateSlot: gateSlotContent,
					}),
				);

				// 1. 停止控件必须存在且可访问（E-236, E-106）
				expect(html).toContain('data-action="stop-stream"');
				expect(html).toContain('data-resident="true"');
				expect(html).toContain('aria-label="停止泳道 3"');
				expect(html).toContain('data-glyph="stop-square"');

				// 2. 审批槽位必须常驻渲染在所有档位分支之外（E-236）
				expect(html).toContain('data-slot="approval"');
				expect(html).toContain('data-resident-slot="true"');
				expect(html).toContain('data-test-gate="gate-waiting"');
			});
		}
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 6 & E-237: narrow 档停止键仍常驻可见，禁止 hover 显示或收进 ⋯
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 6 & E-237: Stop control in narrow tier remains resident and visible without hover or menu', () => {
		it('stop control is permanently visible in narrow tier without hover class or menu wrap', () => {
			const html = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					tier: 'narrow',
					taskKey: 'M9-T9',
					status: 'streaming',
				}),
			);

			// 停止键直接渲染
			expect(html).toContain('data-action="stop-stream"');
			expect(html).toContain('data-resident="true"');

			// 禁止仅在 hover 时可见（如 group-hover:opacity-100 opacity-0）
			expect(html).not.toContain('opacity-0');
			expect(html).not.toContain('group-hover:flex');
			expect(html).not.toContain('group-hover:block');

			// 禁止收进 ⋯ 下拉菜单
			expect(html).not.toContain('data-menu="more"');
			expect(html).not.toContain('⋯');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 7 & E-238: 拖动窗口切换档位时不重挂虚拟列表、不弹回顶部、不中断跟随
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 7 & E-238: DOM identity and key stability across tier switches', () => {
		it('retains stable data-lane-deck-slot keys and identical wrapper structure between compact and narrow', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T1', status: 'succeeded' },
				{ laneNo: 2, taskKey: 'M9-T2', status: 'streaming' },
			];

			const compactHtml = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'compact',
					isTouch: false,
					width: 1200,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'auto',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			const narrowHtml = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'narrow',
					isTouch: false,
					width: 1000,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'auto',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			// 两个档位中每个泳道的外层插槽 key 均一致
			expect(compactHtml).toContain('data-lane-deck-slot="1"');
			expect(compactHtml).toContain('data-lane-deck-slot="2"');
			expect(narrowHtml).toContain('data-lane-deck-slot="1"');
			expect(narrowHtml).toContain('data-lane-deck-slot="2"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 8 & E-239: 档位只依据视口宽度 + 指针类型，绝不按 UA 猜设备
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 8 & E-239: Decision based solely on viewport width and pointer type, never UA', () => {
		it('touch laptop or tablet at width < 1100px enters narrow tier with 44px touch targets', () => {
			// 触屏笔电/平板窄窗：width=900, isTouch=true
			const tier = computeDensityTier({
				width: 900,
				isTouch: true,
			});
			// 走 narrow 档，绝非 phone
			expect(tier).toBe('narrow');

			const html = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					tier,
					isTouch: true,
				}),
			);
			// 命中区放大至 44px
			expect(html).toContain('h-[44px]');
			expect(html).toContain('min-w-[44px]');
		});

		it('touch laptop at width >= 1100px stays in desktop tiers (compact/full), not phone', () => {
			const compactTier = computeDensityTier({
				width: 1200,
				isTouch: true,
				streamCount: 4,
			});
			expect(compactTier).toBe('compact');

			const fullTier = computeDensityTier({
				width: 1500,
				isTouch: true,
				streamCount: 2,
			});
			expect(fullTier).toBe('full');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 9 & E-163: 流数 <= 3 且窗口 >= 1440px 时默认完整档、不出现横向滚动，偏好记忆到本地
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 9 & E-163: Stream count <= 3 and width >= 1440px defaults to full, persists preference', () => {
		it('defaults to full tier for stream count <= 3 on wide desktop', () => {
			expect(computeDensityTier({ width: 1440, streamCount: 1 })).toBe('full');
			expect(computeDensityTier({ width: 1440, streamCount: 2 })).toBe('full');
			expect(computeDensityTier({ width: 1440, streamCount: 3 })).toBe('full');
			expect(computeDensityTier({ width: 1920, streamCount: 3 })).toBe('full');
		});

		it('respects user density preference stored in localStorage', () => {
			// 模拟 localStorage
			const store: Record<string, string> = {};
			const mockStorage = {
				getItem: (k: string) => store[k] ?? null,
				setItem: (k: string, v: string) => {
					store[k] = v;
				},
				removeItem: (k: string) => {
					delete store[k];
				},
			};
			vi.stubGlobal('localStorage', mockStorage);

			setStoredDensityPreference('compact');
			expect(getStoredDensityPreference()).toBe('compact');

			// 用户偏好 compact 时，哪怕 width >= 1440 且流数 <= 3 也走 compact
			expect(
				computeDensityTier({
					width: 1600,
					streamCount: 2,
					userPreference: 'compact',
				}),
			).toBe('compact');

			setStoredDensityPreference('full');
			expect(getStoredDensityPreference()).toBe('full');

			// 用户偏好 full 时，哪怕流数 >= 4 也走 full
			expect(
				computeDensityTier({
					width: 1600,
					streamCount: 6,
					userPreference: 'full',
				}),
			).toBe('full');

			vi.unstubAllGlobals();
		});

		it('RunDeckView renders 3-column grid for <= 3 streams without horizontal overflow in full tier', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T1', title: '任务 1', status: 'succeeded' },
				{ laneNo: 2, taskKey: 'M9-T2', title: '任务 2', status: 'streaming' },
				{ laneNo: 3, taskKey: 'M9-T3', title: '任务 3', status: 'queued' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'full',
					isTouch: false,
					width: 1440,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'full',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			// 采用网格并列排布
			expect(html).toContain('grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 10 & E-167: 完整档横向滚动时若视野外某条流转成「要你」，视口左右边缘出现常驻计数标记
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 10 & E-167: Off-screen waiting streams trigger permanent indicators at viewport edges', () => {
		it('detects waiting approval states via isWaitingApproval', () => {
			expect(isWaitingApproval({ laneNo: 1, status: 'awaiting_input' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 1, status: 'waiting' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 1, status: 'gate_waiting' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 1, needsApproval: true, status: 'tool' })).toBe(true);
			expect(isWaitingApproval({ laneNo: 1, status: 'streaming' })).toBe(false);
			expect(isWaitingApproval({ laneNo: 1, status: 'succeeded' })).toBe(false);
		});

		it('renders resident off-screen badges at left/right edges when offScreenWaiting count > 0', () => {
			const lanes: DeckStreamLane[] = Array.from({ length: 6 }, (_, i) => ({
				laneNo: i + 1,
				taskKey: `M9-T${i + 1}`,
				status: i === 0 || i === 5 ? 'awaiting_input' : 'streaming',
			}));

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'full',
					isTouch: false,
					width: 1200,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'full',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: {
						left: 1,
						right: 2,
						firstLeftLaneNo: 1,
						firstRightLaneNo: 6,
					},
					scrollToLane: () => {},
				}),
			);

			// 左侧常驻标记
			expect(html).toContain('data-offscreen="left"');
			expect(html).toContain('data-waiting-count="1"');
			expect(html).toContain('←');
			expect(html).toContain('1 条待处理');

			// 右侧常驻标记
			expect(html).toContain('data-offscreen="right"');
			expect(html).toContain('data-waiting-count="2"');
			expect(html).toContain('→');
			expect(html).toContain('2 条待处理');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 11 & E-168: 桌面窗口 < 1100px 退化为单列列表，不套用手机端规则，不硬塞多栏
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 11 & E-168: Desktop narrow window (< 1100px) degrades to single column without mobile rules', () => {
		it('computes narrow tier when width < 1100px with mouse pointer', () => {
			expect(computeDensityTier({ width: 1099, isTouch: false })).toBe('narrow');
			expect(computeDensityTier({ width: 900, isTouch: false })).toBe('narrow');
			expect(computeDensityTier({ width: 750, isTouch: false })).toBe('narrow');
		});

		it('RunDeckView in narrow tier uses single column vertical layout', () => {
			const lanes: DeckStreamLane[] = [
				{ laneNo: 1, taskKey: 'M9-T1', status: 'thinking' },
				{ laneNo: 2, taskKey: 'M9-T2', status: 'streaming' },
			];

			const html = renderToStaticMarkup(
				createElement(RunDeckView, {
					lanes,
					tier: 'narrow',
					isTouch: false,
					width: 900,
					expandedLaneNo: null,
					toggleExpandLane: () => {},
					stoppingLanes: new Set<number>(),
					handleStopLane: async () => {},
					userPreference: 'auto',
					togglePreference: () => {},
					scrollContainerRef: { current: null },
					offScreenWaiting: { left: 0, right: 0 },
					scrollToLane: () => {},
				}),
			);

			// 单列垂直列表
			expect(html).toContain('flex flex-col gap-4 p-4 overflow-y-auto flex-1 w-full');
			// 不包含手机切换栏
			expect(html).not.toContain('data-mobile-switcher="true"');
		});
	});

	// ─────────────────────────────────────────────────────────────────────────────
	// AC 12 & E-311, E-317: 五段网格 [head][refBar][body][afterBody][foot]
	// ─────────────────────────────────────────────────────────────────────────────
	describe('AC 12 & E-311, E-317: Five-segment grid structure and daemon field presentation', () => {
		it('renders all five segments in correct order with daemon fields', () => {
			const props: StreamColumnProps = {
				laneNo: 2,
				currentRunId: 'run-888',
				taskKey: 'M9-T9',
				title: '多流甲板与密度档',
				status: 'streaming',
				agentMonogram: 'CX',
				modelName: 'claude-3-7-sonnet',
				refSource: 'dispatch.prompt',
				duration: 15400,
				tokenCount: 42300,
				cost: 0.128,
				bodySlot: createElement('div', { 'data-test-body': 'true' }, '阶段链主体内容'),
				gateSlot: createElement('div', { 'data-test-gate': 'true' }, '审批卡插槽'),
			};

			const html = renderToStaticMarkup(createElement(StreamColumn, props));

			// 五段网格段标签
			expect(html).toContain('data-segment="head"');
			expect(html).toContain('data-segment="refBar"');
			expect(html).toContain('data-segment="body"');
			expect(html).toContain('data-segment="afterBody"');
			expect(html).toContain('data-segment="foot"');

			// [head] 呈现泳道号、任务标识、标题与常驻停止键
			expect(html).toContain('泳道 2');
			expect(html).toContain('M9-T9');
			expect(html).toContain('多流甲板与密度档');
			expect(html).toContain('data-action="stop-stream"');

			// [refBar] 呈现 Monogram、模型名、来源、当前运行 ID
			expect(html).toContain('CX');
			expect(html).toContain('claude-3-7-sonnet');
			expect(html).toContain('来源: dispatch.prompt');
			expect(html).toContain('run: run-888');

			// [body] 呈现主体内容插槽
			expect(html).toContain('data-test-body="true"');

			// [afterBody] 呈现审批槽位插槽
			expect(html).toContain('data-slot="approval"');
			expect(html).toContain('data-test-gate="true"');

			// [foot] 呈现耗时、Tokens 格式化结果、费用
			expect(html).toContain('耗时: 15.4s');
			expect(html).toContain('Tokens: 42.3k');
			expect(html).toContain('费用: $0.128');
		});

		it('displays "—" when daemon fields are missing, never returning 0 for missing tokens or empty strings', () => {
			const html = renderToStaticMarkup(
				createElement(StreamColumn, {
					laneNo: 1,
					taskKey: undefined,
					title: undefined,
					duration: null,
					tokenCount: null,
					cost: null,
					refSource: undefined,
				}),
			);

			expect(html).toContain('耗时: —');
			expect(html).toContain('Tokens: —');
			expect(html).not.toContain('Tokens: 0');
			expect(html).toContain('费用: —');
			expect(html).toContain('来源: —');

			// 状态缺失时不得由前端补齐成 queued，走 E-230/E-234 的降级形状「未识别」
			expect(html).toContain('data-status="unrecognized"');
			expect(html).not.toContain('data-status="queued"');
		});
	});
});
