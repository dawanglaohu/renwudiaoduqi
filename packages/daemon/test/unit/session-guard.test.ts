import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import type { RunRow } from '../../src/repo/runs.ts';
import {
	assertNotArchived,
	assertSessionRefFree,
	createSessionGuardService,
} from '../../src/service/session-guard.ts';

function createMockRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		task_id: 'task-1',
		attempt_no: 1,
		kind: 'implement',
		parent_run_id: null,
		state: 'running',
		review_verdict: null,
		agent_id: 'codex',
		model_name: null,
		reported_model: null,
		effort_tier: null,
		reported_effort: null,
		permission_tier: 'workspaceWrite',
		snapshot_id: 'snap-1',
		worktree_path: null,
		branch_name: null,
		pid: 1234,
		exit_code: null,
		exit_signal: null,
		vendor_session_ref: 'vendor/session/path-1',
		changed_file_count: null,
		token_usage_json: null,
		unmapped_event_count: 0,
		is_stall_suspected: 0,
		rework_count: 0,
		queued_reason: null,
		idempotency_key: 'idem-1',
		actor_device_id: null,
		started_at: '2026-09-15T00:00:00.000Z',
		last_event_at: null,
		ended_at: null,
		session_archived_at: null,
		lane_no: 1,
		...overrides,
	};
}

describe('M6-T10 Unit: session-guard (assertSessionRefFree & assertNotArchived)', () => {
	describe('assertSessionRefFree (AC 5, E-303)', () => {
		it('allows null, undefined, or empty vendorSessionRef without querying repo', () => {
			let queryCount = 0;
			const mockRunsRepo = {
				findByVendorSessionRef: () => {
					queryCount++;
					return null;
				},
			};

			expect(() =>
				assertSessionRefFree(
					{ taskId: 'task-1', vendorSessionRef: undefined },
					{ runsRepo: mockRunsRepo },
				),
			).not.toThrow();
			expect(() =>
				assertSessionRefFree(
					{ taskId: 'task-1', vendorSessionRef: null },
					{ runsRepo: mockRunsRepo },
				),
			).not.toThrow();
			expect(() =>
				assertSessionRefFree(
					{ taskId: 'task-1', vendorSessionRef: '' },
					{ runsRepo: mockRunsRepo },
				),
			).not.toThrow();
			expect(queryCount).toBe(0);
		});

		it('allows unused session reference', () => {
			const mockRunsRepo = {
				findByVendorSessionRef: () => null,
			};

			expect(() =>
				assertSessionRefFree(
					{ taskId: 'task-1', vendorSessionRef: 'unique/session/path' },
					{ runsRepo: mockRunsRepo },
				),
			).not.toThrow();
		});

		it('AC 5: allows multi-round shared reference within the same task', () => {
			const existingRun = createMockRun({
				id: 'run-1',
				task_id: 'task-1',
				vendor_session_ref: 'session/shared/task-1',
			});
			const mockRunsRepo = {
				findByVendorSessionRef: (ref: string) =>
					ref === 'session/shared/task-1' ? existingRun : null,
			};

			// Same taskId ('task-1') -> must NOT throw (shared across review rounds)
			expect(() =>
				assertSessionRefFree(
					{ taskId: 'task-1', vendorSessionRef: 'session/shared/task-1' },
					{ runsRepo: mockRunsRepo },
				),
			).not.toThrow();
		});

		it('AC 5 & E-303: throws E_SESSION_ARCHIVED with conflictTaskKey when referenced by another task', () => {
			const existingRun = createMockRun({
				id: 'run-task-a',
				task_id: 'task-a-uuid',
				vendor_session_ref: 'session/shared/clash',
			});
			const mockRunsRepo = {
				findByVendorSessionRef: (ref: string) =>
					ref === 'session/shared/clash' ? existingRun : null,
			};
			const mockTasksRepo = {
				findById: (id: string) => (id === 'task-a-uuid' ? { task_key: 'M6-T1' } : null),
			};

			let thrown: unknown;
			try {
				assertSessionRefFree(
					{ taskId: 'task-b-uuid', vendorSessionRef: 'session/shared/clash' },
					{ runsRepo: mockRunsRepo, tasksRepo: mockTasksRepo },
				);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(AppError);
			const appErr = thrown as AppError;
			expect(appErr.code).toBe('E_SESSION_ARCHIVED');
			expect(appErr.details).toMatchObject({
				conflictTaskKey: 'M6-T1',
				conflictRunId: 'run-task-a',
				vendorSessionRef: 'session/shared/clash',
				taskId: 'task-b-uuid',
			});
		});

		it('falls back to taskId when conflict task record is missing from tasksRepo', () => {
			const existingRun = createMockRun({
				id: 'run-unknown',
				task_id: 'task-missing',
				vendor_session_ref: 'session/clash-fallback',
			});
			const mockRunsRepo = {
				findByVendorSessionRef: () => existingRun,
			};
			const mockTasksRepo = {
				findById: () => null,
			};

			try {
				assertSessionRefFree(
					{ taskId: 'task-new', vendorSessionRef: 'session/clash-fallback' },
					{ runsRepo: mockRunsRepo, tasksRepo: mockTasksRepo },
				);
				expect.fail('Should have thrown');
			} catch (err) {
				expect(err).toBeInstanceOf(AppError);
				expect((err as AppError).details?.conflictTaskKey).toBe('task-missing');
			}
		});
	});

	describe('assertNotArchived (AC 4, E-96, E-302)', () => {
		it('allows unarchived runs (session_archived_at is null)', () => {
			const run = createMockRun({ session_archived_at: null });
			expect(() => assertNotArchived(run)).not.toThrow();
		});

		it('throws E_SESSION_ARCHIVED for archived runs when passed as object', () => {
			const run = createMockRun({
				id: 'run-archived-1',
				session_archived_at: '2026-09-15T12:00:00.000Z',
			});

			let thrown: unknown;
			try {
				assertNotArchived(run);
			} catch (err) {
				thrown = err;
			}

			expect(thrown).toBeInstanceOf(AppError);
			const appErr = thrown as AppError;
			expect(appErr.code).toBe('E_SESSION_ARCHIVED');
			expect(appErr.details?.runId).toBe('run-archived-1');
			expect(appErr.details?.sessionArchivedAt).toBe('2026-09-15T12:00:00.000Z');
		});

		it('resolves runId via repo and asserts archive state', () => {
			const archivedRun = createMockRun({
				id: 'run-repo-archived',
				session_archived_at: '2026-09-15T10:30:00.000Z',
			});
			const unarchivedRun = createMockRun({
				id: 'run-repo-live',
				session_archived_at: null,
			});

			const mockRunsRepo = {
				findById: (id: string) => {
					if (id === 'run-repo-archived') return archivedRun;
					if (id === 'run-repo-live') return unarchivedRun;
					return null;
				},
				findByVendorSessionRef: () => null,
			};

			expect(() => assertNotArchived('run-repo-live', { runsRepo: mockRunsRepo })).not.toThrow();

			expect(() => assertNotArchived('run-repo-archived', { runsRepo: mockRunsRepo })).toThrowError(
				/archived and is read-only/,
			);
		});

		it('throws E_NOT_FOUND when runId does not exist in repo', () => {
			const mockRunsRepo = {
				findById: () => null,
				findByVendorSessionRef: () => null,
			};

			expect(() => assertNotArchived('non-existent-run', { runsRepo: mockRunsRepo })).toThrowError(
				AppError,
			);
		});
	});

	describe('createSessionGuardService factory', () => {
		it('provides bound service methods', () => {
			const existingRun = createMockRun({
				id: 'run-bound',
				task_id: 'task-a',
				vendor_session_ref: 'bound-ref',
			});
			const service = createSessionGuardService({
				runsRepo: {
					findByVendorSessionRef: (ref) => (ref === 'bound-ref' ? existingRun : null),
					findById: (id) => (id === 'run-bound' ? existingRun : null),
				},
				tasksRepo: {
					findById: (id) => ({ task_key: `KEY-${id}` }),
				},
			});

			expect(() =>
				service.assertSessionRefFree({ taskId: 'task-a', vendorSessionRef: 'bound-ref' }),
			).not.toThrow();

			expect(() =>
				service.assertSessionRefFree({ taskId: 'task-b', vendorSessionRef: 'bound-ref' }),
			).toThrow(AppError);

			expect(() => service.assertNotArchived(existingRun)).not.toThrow();
		});
	});
});
