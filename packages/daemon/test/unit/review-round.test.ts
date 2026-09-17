import { describe, expect, it, vi } from 'vitest';
import { createReviewService } from '../../src/service/review.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('Review Round Integration (M7-T7)', () => {
	it('AC 1 & E-89: Creates a new review run and rejects invalid continued_from_run_id', async () => {
		const mockRunsRepo: any = {
			findLatestReview: vi.fn().mockReturnValue(null),
		};
		const service = createReviewService({
			runsRepo: mockRunsRepo,
			processRegistry: {} as any,
			messageService: {} as any,
			bus: {} as any,
			unitOfWork: {} as any,
		});

		await expect(service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		})).rejects.toThrow(AppError);
	});

	it('AC 2: Route by capability (reply)', async () => {
		const mockRunsRepo: any = {
			findLatestReview: vi.fn().mockReturnValue({
				id: 'prev-review-1',
				task_id: 'task-1',
				kind: 'review',
				attempt_no: 1,
				agent_id: 'agent-1',
			}),
			insert: vi.fn(),
		};
		const mockProcessRegistry: any = {
			has: vi.fn().mockReturnValue(true),
			reassign: vi.fn(),
		};
		const mockMessageService: any = {
			getCapabilities: vi.fn().mockReturnValue({ canReply: true, canResume: false }),
			deliverMessage: vi.fn().mockResolvedValue({ delivered: true }),
		};
		let triggerEvent: any;
		const mockBus: any = {
			subscribeWithFilter: vi.fn().mockImplementation((filter, cb) => {
				triggerEvent = cb;
				return () => {};
			}),
		};
		const mockUow: any = {
			transaction: vi.fn((cb: any) => cb()),
		};

		const service = createReviewService({
			runsRepo: mockRunsRepo,
			processRegistry: mockProcessRegistry,
			messageService: mockMessageService,
			bus: mockBus,
			unitOfWork: mockUow,
		});

		const p = service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: ['fix this'],
		});

		// wait a tick for the promise to subscribe
		await new Promise(r => setTimeout(r, 0));
		if (triggerEvent) {
			triggerEvent({ kind: 'agent_message_chunk' });
		}

		const newRunId = await p;

		expect(newRunId).toBeDefined();
		expect(mockRunsRepo.insert).toHaveBeenCalled();
		expect(mockProcessRegistry.reassign).toHaveBeenCalledWith('prev-review-1', newRunId);
		expect(mockMessageService.deliverMessage).toHaveBeenCalled();
	});

	it('AC 4 & E-302: Rejects if session is archived', async () => {
		const mockRunsRepo: any = {
			findLatestReview: vi.fn().mockReturnValue({
				id: 'prev-review-1',
				task_id: 'task-1',
				kind: 'review',
				session_archived_at: '2026-01-01T00:00:00Z',
			}),
		};
		const service = createReviewService({
			runsRepo: mockRunsRepo,
			processRegistry: {} as any,
			messageService: {} as any,
			bus: {} as any,
			unitOfWork: {} as any,
		});

		await expect(service.startReviewRound({
			taskId: 'task-1',
			implRunId: 'impl-1',
			round: 2,
			reworkItems: [],
		})).rejects.toThrow('Session archived');
	});
});
