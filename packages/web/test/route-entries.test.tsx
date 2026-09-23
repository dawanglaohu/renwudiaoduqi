/**
 * packages/web/test/route-entries.test.tsx
 *
 * 真实路由入口接线测试（M9-T19 / R2）
 *
 * 验证：
 * 1. 真实 #/ 在零流与有流时均渲染批次树（桌面左栏与手机 tasks pane）
 * 2. 顶栏只渲染一组闸门开关，页面绝不出现重复闸门
 * 3. 真实 #/tasks 渲染批次树与 TaskListContainer
 * 4. 删除任一接线时测试必须失败
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { setCachedToken } from '../src/api/http-client.ts';
import { App } from '../src/app/app.tsx';
import { navigateTo } from '../src/app/routes.tsx';
import { RunDeckView } from '../src/features/run-deck/run-deck-view.tsx';
import type { DeckStreamLane } from '../src/features/run-deck/types.ts';
import { TaskListPage } from '../src/pages/task-list-page.tsx';

describe('R2: 路由入口真实渲染接线测试', () => {
	beforeEach(() => {
		setCachedToken('test-device-token');
	});

	// ─── 1. 真实 #/ 入口零流状态下的渲染 ───
	it('renders batch tree and empty onboarding on #/ with zero streams (R2)', () => {
		navigateTo('#/');

		const html = renderToStaticMarkup(createElement(App));

		// 顶栏必须存在且只包含一组闸门开关
		expect(html).toContain('Agent 任务调度器');
		const gateToggleMatches = html.match(/data-component="gate-toggles"/g) ?? [];
		expect(gateToggleMatches.length).toBe(1);

		// 左栏 272px 批次树必须存在
		expect(html).toContain('data-testid="deck-rail"');
		expect(html).toContain('批次与任务');
		expect(html).toContain('data-component="batch-tree"');

		// 主区域显示零流引导
		expect(html).toContain('data-testid="empty-onboarding-console"');
	});

	// ─── 2. 真实 #/ 入口有流状态下的渲染 ───
	it('renders batch tree alongside stream columns on #/ with active streams (R2)', () => {
		const sampleLane: DeckStreamLane = {
			laneNo: 1,
			id: 'lane-1',
			currentRunId: 'run-1',
			taskKey: 'M9-T19',
			title: '批次树与闸门',
			status: 'running',
		};

		const html = renderToStaticMarkup(
			createElement(RunDeckView, {
				lanes: [sampleLane],
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

		// 左栏批次树依然渲染
		expect(html).toContain('data-testid="deck-rail"');
		expect(html).toContain('批次与任务');
		expect(html).toContain('data-component="batch-tree"');

		// 泳道流监看区渲染 StreamColumn
		expect(html).toContain('data-stream-column="true"');
		expect(html).toContain('data-lane-no="1"');
		expect(html).toContain('M9-T19');

		// 顶栏不在视图内部重复渲染闸门
		expect(html).not.toContain('data-component="gate-toggles"');
	});

	// ─── 3. 手机单栏 tasks pane 共用批次树组件 ───
	it('renders BatchTree in phone tasks pane with 44px touch height (R2, E-13)', () => {
		const html = renderToStaticMarkup(
			createElement(RunDeckView, {
				lanes: [],
				batches: [{ id: 'batch-p1', batchNo: 1 }],
				tier: 'phone',
				isTouch: true,
				width: 375,
				activePane: 'tasks',
				expandedLaneNo: null,
				toggleExpandLane: () => {},
				stoppingLanes: new Set<number>(),
				handleStopLane: async () => {},
				userPreference: 'phone',
				togglePreference: () => {},
				scrollContainerRef: { current: null },
				offScreenWaiting: { left: 0, right: 0 },
				scrollToLane: () => {},
			}),
		);

		// 手机端 tasks pane 顶层必须使用 BatchTree
		expect(html).toContain('data-pane-view="tasks"');
		expect(html).toContain('data-component="batch-tree"');
		// 触控优化档位 44px 与 44x44 开合槽
		expect(html).toContain('h-[44px]');
		expect(html).toContain('w-[44px]');
	});

	// ─── 4. 手机单栏 stream pane 在零流时渲染 EmptyOnboarding ───
	it('renders EmptyOnboarding in phone stream pane when streamCount is 0 (R2)', () => {
		const html = renderToStaticMarkup(
			createElement(RunDeckView, {
				lanes: [],
				tier: 'phone',
				isTouch: true,
				width: 375,
				activePane: 'stream',
				expandedLaneNo: null,
				toggleExpandLane: () => {},
				stoppingLanes: new Set<number>(),
				handleStopLane: async () => {},
				userPreference: 'phone',
				togglePreference: () => {},
				scrollContainerRef: { current: null },
				offScreenWaiting: { left: 0, right: 0 },
				scrollToLane: () => {},
			}),
		);

		expect(html).toContain('data-pane-view="stream"');
		expect(html).toContain('data-testid="empty-onboarding-console"');
	});

	// ─── 5. 真实 #/tasks 入口渲染批次树 ───
	it('renders batch tree and task list container on #/tasks (R2)', () => {
		navigateTo('#/tasks');

		const html = renderToStaticMarkup(createElement(App));

		// 顶栏只包含一组闸门
		const gateToggleMatches = html.match(/data-component="gate-toggles"/g) ?? [];
		expect(gateToggleMatches.length).toBe(1);

		// 任务列表主区域
		expect(html).toContain('任务列表');
		expect(html).toContain('data-component="batch-tree"');
	});

	// ─── 6. 接线断言：若 TaskListPage 移除 TaskListContainer，页面失去批次树 ───
	it('fails when tasks page wiring is missing (R2 assertion)', () => {
		const html = renderToStaticMarkup(createElement(TaskListPage));
		expect(html).toContain('data-component="batch-tree"');
	});
});
