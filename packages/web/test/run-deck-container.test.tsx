// @vitest-environment jsdom
import type { GateDto } from '@agent-scheduler/shared/api/gates';
import type { LaneView } from '@agent-scheduler/shared/api/lanes';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildDeckLanes } from '../src/features/run-deck/run-deck-container.tsx';
import { RunDeckView } from '../src/features/run-deck/run-deck-view.tsx';

const idleLane = {
	laneNo: 1,
	taskId: null,
	currentRunId: null,
	stage: 'idle',
	archivedTaskIds: [],
	archivedWrapupRunId: null,
	nextTaskId: null,
	nextBlockedBy: null,
	overLimit: false,
} as unknown as LaneView;

function renderDeck(gates: readonly GateDto[] = []) {
	const task = {
		id: 't1',
		taskKey: 'TEST-T1',
		title: 'Test task',
		batchId: 'b1',
		docId: 'd1',
		state: 'awaiting_human',
		deps: [],
		moduleKey: 'M1',
		estDays: 1,
	} as TaskDto;
	return renderToStaticMarkup(
		createElement(RunDeckView, {
			tasks: [task],
			batches: [{ id: 'b1', docId: 'd1', batchNo: 1, tasks: [task] }],
			lanes: buildDeckLanes({ lanes: [idleLane], gates }),
			rawLanes: [idleLane],
			gates,
			tier: 'full',
			isTouch: false,
			width: 1200,
			expandedLaneNo: null,
			toggleExpandLane: vi.fn(),
			stoppingLanes: new Set<number>(),
			handleStopLane: vi.fn(),
			userPreference: 'auto',
			togglePreference: vi.fn(),
			scrollContainerRef: { current: null },
			offScreenWaiting: { left: 0, right: 0 },
			scrollToLane: vi.fn(),
			onDecideGate: vi.fn(),
		}),
	);
}

describe('R13 browser entry wiring', () => {
	it('E-108: empty daemon slots still show document onboarding', () => {
		const html = renderDeck();
		expect(html).toContain('empty-onboarding-console');
		expect(html).toContain('import-doc-path');
	});
	it('renders unassigned waiting gates without changing authoritative lane identity or stage', () => {
		const gate = {
			id: 'g1',
			taskId: 't1',
			runId: 'r1',
			kind: 'review',
			state: 'waiting',
		} as GateDto;
		const lanes = buildDeckLanes({ lanes: [idleLane], gates: [gate] });
		expect(lanes[0]?.currentRunId).toBeNull();
		expect(lanes[0]?.taskId).toBeUndefined();
		const html = renderDeck([gate]);
		expect(html).toContain('data-slot="task-approval"');
		expect(html).toContain('data-component="gate-card"');
		expect(html).not.toContain('empty-onboarding-console');
		expect(idleLane.stage).toBe('idle');
	});
});
