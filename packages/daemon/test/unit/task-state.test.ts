import { describe, expect, it } from 'vitest';
import {
	deriveTaskCrossBatchFix,
	deriveTaskInHead,
	deriveTaskState,
	isTaskState,
} from '../../src/domain/task-state.ts';

describe('M8-T7 domain/task-state: origin branch, deriveTaskInHead, and crossBatchFix', () => {
	describe('deriveTaskState: manual_state, attempt_no, and origin branches (09 节, E-275)', () => {
		it('prioritizes manual_state over run state', () => {
			expect(deriveTaskState('landed', 'running')).toBe('landed');
			expect(
				deriveTaskState({
					manualState: 'landed',
					latestRunState: 'running',
				}),
			).toBe('landed');
		});

		it('falls back to latest run state when manual_state is null or whitespace', () => {
			expect(deriveTaskState(null, 'running')).toBe('running');
			expect(deriveTaskState('  ', 'reviewing')).toBe('reviewing');
			expect(
				deriveTaskState({
					manualState: null,
					latestRunState: 'reviewing',
				}),
			).toBe('reviewing');
		});

		it('returns never_dispatched when both manual_state and run state are absent', () => {
			expect(deriveTaskState(null, null)).toBe('never_dispatched');
			expect(deriveTaskState('', '')).toBe('never_dispatched');
			expect(deriveTaskState({})).toBe('never_dispatched');
		});

		it('selects highest attempt_no run when runs array is provided', () => {
			const state = deriveTaskState({
				runs: [
					{ state: 'landed', attempt_no: 1, origin: 'dispatch' },
					{ state: 'running', attempt_no: 2, origin: 'rework' },
				],
			});
			expect(state).toBe('running');
		});

		it('under ignoreWrapupFix (batch count perspective, E-275), filters out wrapup-fix runs', () => {
			// Task was landed in attempt 1, currently in wrapup-fix in attempt 2
			const runs = [
				{ state: 'landed', attempt_no: 1, origin: 'dispatch' },
				{ state: 'running', attempt_no: 2, origin: 'wrapup-fix' },
			];

			// Default behavior: picks latest attempt (running)
			expect(deriveTaskState({ runs })).toBe('running');

			// Batch-level count perspective (E-275): ignores in-flight wrapup-fix, keeps landed
			expect(deriveTaskState({ runs }, null, { ignoreWrapupFix: true })).toBe('landed');
		});

		it('under ignoreWrapupFix with latestRunOrigin and latestNonFixRunState', () => {
			const input = {
				latestRunState: 'queued',
				latestRunOrigin: 'wrapup-fix',
				latestNonFixRunState: 'landed',
			};

			expect(deriveTaskState(input, null, { ignoreWrapupFix: false })).toBe('queued');
			expect(deriveTaskState(input, null, { ignoreWrapupFix: true })).toBe('landed');
		});

		it('under ignoreWrapupFix returns never_dispatched if all runs are wrapup-fix and no manualState', () => {
			const runs = [{ state: 'queued', attempt_no: 1, origin: 'wrapup-fix' }];
			expect(deriveTaskState({ runs }, null, { ignoreWrapupFix: true })).toBe('never_dispatched');
		});
	});

	describe('deriveTaskInHead: 3-state derivation (AC 6, E-298)', () => {
		it('returns true when task is landed and run is_in_head is 1', () => {
			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'landed', is_in_head: 1 },
				}),
			).toBe(true);

			// Overload style
			expect(deriveTaskInHead({ state: 'landed', is_in_head: 1 })).toBe(true);
		});

		it('returns false when task is landed and run is_in_head is 0 or null', () => {
			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'landed', is_in_head: 0 },
				}),
			).toBe(false);

			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'landed', is_in_head: null },
				}),
			).toBe(false);

			expect(deriveTaskInHead({ state: 'landed', is_in_head: 0 })).toBe(false);
		});

		it('returns null when task is not landed', () => {
			// In-flight / non-landed states return null (shows "—" in UI)
			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'running', is_in_head: 0 },
				}),
			).toBeNull();

			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'reviewing', is_in_head: 1 },
				}),
			).toBeNull();

			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'queued', is_in_head: 0 },
				}),
			).toBeNull();

			expect(
				deriveTaskInHead({
					latestImplementationRun: { state: 'failed', is_in_head: 0 },
				}),
			).toBeNull();

			expect(deriveTaskInHead(null, null)).toBeNull();
		});

		it('returns true for manual landed task without runs (no branch to merge)', () => {
			expect(
				deriveTaskInHead({
					manualState: 'landed',
					latestImplementationRun: null,
				}),
			).toBe(true);

			expect(deriveTaskInHead(null, 'landed')).toBe(true);
		});

		it('respects run is_in_head when manualState is landed but run exists', () => {
			expect(
				deriveTaskInHead({
					manualState: 'landed',
					latestImplementationRun: { state: 'landed', is_in_head: 1 },
				}),
			).toBe(true);

			expect(
				deriveTaskInHead({
					manualState: 'landed',
					latestImplementationRun: { state: 'landed', is_in_head: 0 },
				}),
			).toBe(false);
		});
	});

	describe('deriveTaskCrossBatchFix: cross-batch fix detection (AC 4, E-275)', () => {
		it('returns true when in-flight wrapup-fix run has batch_id differing from taskBatchId', () => {
			const result = deriveTaskCrossBatchFix({
				taskBatchId: 'batch-1',
				runs: [
					{ state: 'landed', origin: 'dispatch', batch_id: 'batch-1' },
					{ state: 'running', origin: 'wrapup-fix', batch_id: 'batch-2' },
				],
			});
			expect(result).toBe(true);
		});

		it('returns false when wrapup-fix run is within same batch', () => {
			const result = deriveTaskCrossBatchFix({
				taskBatchId: 'batch-1',
				runs: [
					{ state: 'landed', origin: 'dispatch', batch_id: 'batch-1' },
					{ state: 'running', origin: 'wrapup-fix', batch_id: 'batch-1' },
				],
			});
			expect(result).toBe(false);
		});

		it('returns false when cross-batch fix run has already landed', () => {
			const result = deriveTaskCrossBatchFix({
				taskBatchId: 'batch-1',
				runs: [
					{ state: 'landed', origin: 'dispatch', batch_id: 'batch-1' },
					{ state: 'landed', origin: 'wrapup-fix', batch_id: 'batch-2' },
				],
			});
			expect(result).toBe(false);
		});

		it('returns false when cross-batch fix run has terminated in failure', () => {
			const result = deriveTaskCrossBatchFix({
				taskBatchId: 'batch-1',
				runs: [
					{ state: 'landed', origin: 'dispatch', batch_id: 'batch-1' },
					{ state: 'failed', origin: 'wrapup-fix', batch_id: 'batch-2' },
				],
			});
			expect(result).toBe(false);
		});

		it('returns false when in-flight run is not wrapup-fix (e.g. rework)', () => {
			const result = deriveTaskCrossBatchFix({
				taskBatchId: 'batch-1',
				runs: [
					{ state: 'landed', origin: 'dispatch', batch_id: 'batch-1' },
					{ state: 'running', origin: 'rework', batch_id: 'batch-2' },
				],
			});
			expect(result).toBe(false);
		});

		it('returns false when taskBatchId is missing or runs are empty', () => {
			expect(deriveTaskCrossBatchFix({ taskBatchId: null, runs: [] })).toBe(false);
			expect(deriveTaskCrossBatchFix({ taskBatchId: 'batch-1', runs: [] })).toBe(false);
		});
	});

	describe('isTaskState validator', () => {
		it('returns true for all valid task states', () => {
			expect(isTaskState('never_dispatched')).toBe(true);
			expect(isTaskState('running')).toBe(true);
			expect(isTaskState('landed')).toBe(true);
			expect(isTaskState('queued')).toBe(true);
			expect(isTaskState('awaiting_human')).toBe(true);
		});

		it('returns false for invalid task states', () => {
			expect(isTaskState('invalid_state')).toBe(false);
			expect(isTaskState(123)).toBe(false);
			expect(isTaskState(null)).toBe(false);
		});
	});
});
