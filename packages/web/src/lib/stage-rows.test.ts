import type { PipelineStage } from '@agent-scheduler/shared/api/lanes';
import type { RunDto } from '@agent-scheduler/shared/api/runs';
import { describe, expect, it } from 'vitest';
import { LOOP_PIECES } from './spine-shape.ts';
import {
	deriveStageRows,
	formatIdleText,
	formatStageDuration,
	getLaneKind,
	isLaneIdle,
	isLaneWrapup,
} from './stage-rows.ts';

const PIPELINE_STAGES: readonly PipelineStage[] = ['implement', 'review', 'bughunt', 'landing'];

function createMockRun(partial: Partial<RunDto> & { durationMs?: number } = {}): RunDto {
	const durationMs = partial.durationMs ?? 15000;
	const startedAt = partial.startedAt ?? '2025-01-01T00:00:00.000Z';
	const endedAt = partial.endedAt ?? new Date(Date.parse(startedAt) + durationMs).toISOString();

	return {
		id: partial.id ?? 'run-1',
		taskId: partial.taskId ?? 'task-1',
		kind: partial.kind ?? 'implement',
		state: partial.state ?? 'exited',
		attemptNo: partial.attemptNo ?? 1,
		startedAt,
		endedAt,
		lastEventAt: endedAt,
		reworkCount: partial.reworkCount ?? 0,
		parentRunId: partial.parentRunId ?? null,
		agentId: partial.agentId ?? 'agent-1',
		modelName: partial.modelName ?? null,
		reportedModel: partial.reportedModel ?? null,
		effortTier: partial.effortTier ?? null,
		reportedEffort: partial.reportedEffort ?? null,
		permissionTier: partial.permissionTier ?? 'readOnly',
		worktreePath: partial.worktreePath ?? null,
		branchName: partial.branchName ?? null,
		pid: partial.pid ?? null,
		exitCode: partial.exitCode ?? 0,
		exitSignal: partial.exitSignal ?? null,
		changedFileCount: partial.changedFileCount ?? null,
		tokenUsage: partial.tokenUsage ?? null,
		isStallSuspected: partial.isStallSuspected ?? false,
		queuedReason: partial.queuedReason ?? null,
		idempotencyKey: partial.idempotencyKey ?? 'idem-1',
		actorDeviceId: partial.actorDeviceId ?? null,
		reviewVerdict: partial.reviewVerdict ?? null,
		...partial,
	} as RunDto;
}

describe('lib/stage-rows (M9-T21 / AC 1..7b, E-306, E-307, E-313, E-314, E-315, E-317, E-319, E-325, E-332)', () => {
	// ─── AC 7 & E-319: 空闲泳道不画假链 ───
	it('AC 7 & E-319: idle lane returns empty stage chain', () => {
		expect(deriveStageRows({ currentStage: 'idle', stageOrder: PIPELINE_STAGES })).toEqual([]);
		expect(deriveStageRows({ currentStage: null, stageOrder: PIPELINE_STAGES })).toEqual([]);
		expect(deriveStageRows({ currentStage: undefined, stageOrder: PIPELINE_STAGES })).toEqual([]);
	});

	// ─── AC 7 & E-319: formatIdleText 格式化空闲文案 ───
	it('AC 7 & E-319: formatIdleText formats queue position and blocked predecessors', () => {
		expect(formatIdleText(null)).toBe('空闲 · 本批已全部派出');
		expect(formatIdleText(undefined)).toBe('空闲 · 本批已全部派出');
		expect(formatIdleText('M9-T22')).toBe('空闲 · 队列下一个是 M9-T22');
		expect(formatIdleText('M9-T22', ['M9-T21'])).toBe(
			'空闲 · 队列下一个是 M9-T22（等 M9-T21 落地）',
		);
		expect(formatIdleText('M9-T22', ['M9-T19', 'M9-T20'])).toBe(
			'空闲 · 队列下一个是 M9-T22（等 M9-T19、M9-T20 落地）',
		);
	});

	// ─── E-332: 未知 stage 显示「—」、未来行不画、不抛错 ───
	it('E-332: unknown stage renders single row with "—" and no future rows, without throwing', () => {
		const rows = deriveStageRows({
			currentStage: 'some_alien_stage',
			stageOrder: PIPELINE_STAGES,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.label).toBe('—');
		expect(rows[0]?.status).toBe('current');
		expect(rows[0]?.durationMs).toBeNull();
		expect(rows[0]?.interactive).toBe(false);
	});

	// ─── AC 4 & E-306: 「查 bug」行只在存在 kind='bughunt' 运行时出现、不画「已跳过」节点；「落地」恒最后 ───
	it('AC 4 & E-306: bughunt stage is omitted when no bughunt run exists, and landing is always last', () => {
		const runs = [
			createMockRun({ kind: 'implement', durationMs: 12000 }),
			createMockRun({ kind: 'review', durationMs: 8000 }),
		];

		const rows = deriveStageRows({
			currentStage: 'review',
			stageOrder: PIPELINE_STAGES,
			runs,
		});

		// 阶段只有: implement, review, landing（bughunt 不出现）
		expect(rows.map((r) => r.id)).toEqual(['implement', 'review', 'landing']);
		expect(rows[rows.length - 1]?.id).toBe('landing');
		expect(rows.some((r) => r.id === 'bughunt')).toBe(false);

		// implement 完成，带耗时
		expect(rows[0]?.status).toBe('done');
		expect(rows[0]?.durationMs).toBe(12000);
		expect(rows[0]?.spineKind).toBe('done');

		// review 当前，带耗时
		expect(rows[1]?.status).toBe('current');
		expect(rows[1]?.durationMs).toBe(8000);
		expect(rows[1]?.spineKind).toBe('live');

		// landing 未来，虚线，耗时留空 null（AC 2）
		expect(rows[2]?.status).toBe('future');
		expect(rows[2]?.durationMs).toBeNull();
		expect(rows[2]?.spineKind).toBe('pending');
	});

	it('AC 4 & E-306: bughunt stage appears when kind="bughunt" run exists', () => {
		const runs = [
			createMockRun({ kind: 'implement', durationMs: 10000 }),
			createMockRun({ kind: 'review', durationMs: 5000 }),
			createMockRun({ id: 'run-hunt-1', kind: 'bughunt', durationMs: 7000 }),
		];

		const rows = deriveStageRows({
			currentStage: 'bughunt',
			stageOrder: PIPELINE_STAGES,
			runs,
		});

		expect(rows.map((r) => r.id)).toEqual(['implement', 'review', 'bughunt', 'landing']);
		expect(rows[2]?.id).toBe('bughunt');
		expect(rows[2]?.label).toBe('查 bug');
		expect(rows[2]?.status).toBe('current');
		expect(rows[2]?.runId).toBe('run-hunt-1');
		expect(rows[rows.length - 1]?.id).toBe('landing');
	});

	// ─── E-332: stage='rework' / queued 落在实施行 ───
	it('E-332: queued and rework stages map to the implementation row', () => {
		const queuedRows = deriveStageRows({
			currentStage: 'queued',
			stageOrder: PIPELINE_STAGES,
		});
		expect(queuedRows[0]?.id).toBe('implement');
		expect(queuedRows[0]?.label).toBe('排队');
		expect(queuedRows[0]?.status).toBe('current');

		const reworkRows = deriveStageRows({
			currentStage: 'rework',
			stageOrder: PIPELINE_STAGES,
			reworkCount: 1,
		});
		expect(reworkRows[0]?.id).toBe('implement');
		expect(reworkRows[0]?.label).toBe('返工实施 · 第 2 轮');
		expect(reworkRows[0]?.status).toBe('current');
	});

	// ─── AC 3 & E-307: 返工回环由 LOOP_PIECES 按行片段画在 20px 轨列内，reworkCount=0 不画 ───
	it('AC 3: loop pieces are not drawn when reworkCount = 0', () => {
		const rows = deriveStageRows({
			currentStage: 'review',
			stageOrder: PIPELINE_STAGES,
			reworkCount: 0,
		});
		for (const row of rows) {
			expect(row.loop).toBeUndefined();
		}
	});

	it('AC 3: review rework draws loop from review back to implement row', () => {
		const rows = deriveStageRows({
			currentStage: 'rework',
			stageOrder: PIPELINE_STAGES,
			reworkCount: 1,
		});

		const implementRow = rows.find((r) => r.id === 'implement');
		const reviewRow = rows.find((r) => r.id === 'review');

		expect(implementRow?.loop).toEqual(LOOP_PIECES.top);
		expect(reviewRow?.loop).toEqual(LOOP_PIECES.bottom);
		expect(implementRow?.label).toBe('返工实施 · 第 2 轮');
		expect(reviewRow?.label).toBe('审查 · 第 2 轮');
	});

	it('AC 3 & E-307: bughunt rework loop points back to review row with same reworkCount', () => {
		const runs = [
			createMockRun({ kind: 'implement' }),
			createMockRun({ kind: 'review' }),
			createMockRun({ kind: 'bughunt' }),
		];
		const rows = deriveStageRows({
			currentStage: 'review',
			stageOrder: PIPELINE_STAGES,
			runs,
			reworkCount: 1,
			hasBughuntRun: true,
		});

		const bughuntRow = rows.find((r) => r.id === 'bughunt');
		const reviewRow = rows.find((r) => r.id === 'review');

		expect(bughuntRow?.loop).toEqual(LOOP_PIECES.bottom);
		expect(reviewRow?.loop).toEqual(LOOP_PIECES.top);
		expect(reviewRow?.label).toBe('审查 · 第 2 轮');
	});

	// ─── AC 5 & E-313 & E-314: readOnly 或 runId=null 的行无 tabIndex (interactive: false) ───
	it('AC 5 & E-313: interactive is true only when not readOnly and runId exists', () => {
		const runs = [createMockRun({ id: 'run-impl-1', kind: 'implement' })];
		const rows = deriveStageRows({
			currentStage: 'implement',
			stageOrder: PIPELINE_STAGES,
			runs,
			readOnly: false,
		});

		expect(rows[0]?.runId).toBe('run-impl-1');
		expect(rows[0]?.interactive).toBe(true);

		// landing has no runId yet -> not interactive
		const landingRow = rows.find((r) => r.id === 'landing');
		expect(landingRow?.runId).toBeNull();
		expect(landingRow?.interactive).toBe(false);

		// readOnly mode -> all interactive: false
		const readOnlyRows = deriveStageRows({
			currentStage: 'implement',
			stageOrder: PIPELINE_STAGES,
			runs,
			readOnly: true,
		});
		for (const r of readOnlyRows) {
			expect(r.interactive).toBe(false);
			expect(r.spineKind).not.toBe('live');
		}
	});

	// ─── AC 2: 耗时格式化 ───
	it('AC 2: formatStageDuration handles milliseconds, seconds, minutes, hours, and blanks', () => {
		expect(formatStageDuration(null)).toBe('');
		expect(formatStageDuration(undefined)).toBe('');
		expect(formatStageDuration(0)).toBe('—');
		expect(formatStageDuration(450)).toBe('450ms');
		expect(formatStageDuration(15000)).toBe('15s');
		expect(formatStageDuration(135000)).toBe('2m 15s');
		expect(formatStageDuration(120000)).toBe('2m');
		expect(formatStageDuration(3720000)).toBe('1h 2m');
	});

	// ─── E-317: 辅助分类纯函数 ───
	it('E-317: getLaneKind, isLaneIdle, isLaneWrapup correctly identify stage categories', () => {
		expect(isLaneIdle('idle')).toBe(true);
		expect(isLaneIdle(null)).toBe(true);
		expect(isLaneIdle('implement')).toBe(false);

		expect(isLaneWrapup('wrapup')).toBe(true);
		expect(isLaneWrapup('implement')).toBe(false);

		expect(getLaneKind('idle')).toBe('idle');
		expect(getLaneKind(null)).toBe('idle');
		expect(getLaneKind('wrapup')).toBe('wrapup');
		expect(getLaneKind('implement')).toBe('task');
		expect(getLaneKind('review')).toBe('task');
	});
});
