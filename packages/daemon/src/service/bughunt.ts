import type { RunDto } from '@agent-scheduler/shared/api/runs';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { assembleBughuntPrompt } from '../domain/bughunt-prompt.ts';
import { decideBughuntOutcome, parseBughuntReport } from '../domain/bughunt-report.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	isTerminalRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { GatesRepo } from '../repo/gates.ts';
import { type RunInsertRow, type RunsRepo, toRunDto } from '../repo/runs.ts';
import type { SettingsRepo } from '../repo/settings.ts';
import { type GitRunner, type WorktreeManagerDeps, getDiffStat } from '../workspace/diff.ts';
import { readWorktreeStartingBaseline } from '../workspace/in-head.ts';
import type { AgentService } from './agents.ts';
import type { BughuntContextService } from './bughunt-context.ts';
import type { GateService } from './gates.ts';
import type { ReviewService } from './review.ts';
import { assertSessionRefFree } from './session-guard.ts';
import type { SettingsService } from './settings.ts';

export interface BughuntServiceDeps {
	readonly runsRepo: RunsRepo;
	readonly settingsRepo?: SettingsRepo;
	readonly settingsService?: SettingsService;
	readonly unitOfWork: UnitOfWork;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly agentRegistry?: AgentRegistry;
	readonly agentService?: AgentService;
	readonly bughuntContextService?: BughuntContextService;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly gatesRepo?: GatesRepo;
	readonly gatesService?: GateService;
	readonly reviewService?: ReviewService;
	readonly gitRunner?: GitRunner;
	readonly worktreeDeps?: WorktreeManagerDeps;
	readonly warn?: (message: string, ...args: unknown[]) => void;
}

export interface DispatchBughuntInput {
	readonly implRunId: string;
	readonly actorDeviceId?: string | null;
}

export interface DispatchBughuntResult {
	readonly action: 'dispatched' | 'already_exists' | 'agent_unavailable';
	readonly bughuntRun?: RunDto;
	readonly gateId?: string;
}

export interface FinalizeBughuntRunInput {
	readonly bughuntRunId: string;
	readonly outputText?: string;
	readonly exitCode?: number | null;
	readonly exitSignal?: string | null;
	readonly failedReason?: 'failed' | 'aborted' | 'interrupted' | 'startup_timeout';
	readonly actorDeviceId?: string | null;
}

export interface FinalizeBughuntRunResult {
	readonly action: 'rereview' | 'awaiting_human' | 'gate' | 'failed' | 'unparsed';
	readonly reason?: string;
	readonly gateId?: string;
	readonly newReworkCount?: number;
}

export interface BughuntService {
	readonly dispatchBughunt: (input: DispatchBughuntInput) => Promise<DispatchBughuntResult>;
	readonly finalizeBughuntRun: (
		input: FinalizeBughuntRunInput,
	) => Promise<FinalizeBughuntRunResult>;
}

export function createBughuntService(deps: BughuntServiceDeps): BughuntService {
	return Object.freeze({
		/**
		 * 派发查 bug 运行（AC 1, AC 2, E-316, E-328, E-329, E-341）。
		 * 唯一调用方是 review 判 pass 后的分流。
		 */
		async dispatchBughunt(input: DispatchBughuntInput): Promise<DispatchBughuntResult> {
			const implRun = deps.runsRepo.findById(input.implRunId);
			if (!implRun) {
				throw new AppError('E_NOT_FOUND', `Implementation run '${input.implRunId}' not found.`);
			}
			const taskId = implRun.task_id;
			if (!taskId) {
				throw new AppError('E_VALIDATION', 'Cannot dispatch bughunt for run without task_id.');
			}

			// 检查是否已有 bughunt 行（AC 1）
			const existing = deps.runsRepo.findByParentRunIdAndKind?.(implRun.id, 'bughunt');
			if (existing) {
				return Object.freeze({
					action: 'already_exists',
					bughuntRun: toRunDto(existing),
				});
			}

			// 任务指派：逐字复制被审实施运行行的 agent_id / model_name / effort_tier（决策 107, E-328, E-341）
			const agentId = implRun.agent_id;
			const modelName = implRun.model_name ?? null;
			const effortTier = (implRun.effort_tier as 'low' | 'medium' | 'high' | null) ?? null;
			const effortVendor = implRun.effort_vendor ?? null;

			// agent 可用性检查（E-328）
			let isAvailable = true;
			if (deps.agentRegistry) {
				const snapshot = deps.agentRegistry.getSnapshot();
				const agent = snapshot.agents[agentId];
				if (!agent) {
					isAvailable = false;
				}
			}
			if (deps.agentService) {
				const availability = deps.agentService.getAvailability(agentId);
				if (availability && !availability.canDispatch) {
					isAvailable = false;
				}
			}

			const now = deps.clock.now();

			if (!isAvailable) {
				// agent 不可用则不派、不换家并转人写 bughunt_agent_unavailable（E-328）
				const gateId = `gate_${deps.ids.newId()}`;
				deps.unitOfWork.run(() => {
					deps.runsRepo.updateState({
						id: implRun.id,
						fromState: implRun.state,
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_AGENT_UNAVAILABLE,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.gatesRepo?.create({
						id: gateId,
						task_id: taskId,
						run_id: implRun.id,
						kind: 'review',
						state: 'waiting',
						comment: RUN_TRANSITION_REASONS.BUGHUNT_AGENT_UNAVAILABLE,
						created_at: now,
					});
				});

				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: implRun.id,
							taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: implRun.state,
								to: 'awaiting_human',
								reason: RUN_TRANSITION_REASONS.BUGHUNT_AGENT_UNAVAILABLE,
							},
						}),
					);
				}

				return Object.freeze({
					action: 'agent_unavailable',
					gateId,
				});
			}

			// 组装查 bug 提示词与起点树基线（E-316, E-329）
			const context = deps.bughuntContextService?.getBughuntContext(taskId);
			const baseline = implRun.worktree_path
				? await readWorktreeStartingBaseline(
						implRun.worktree_path,
						deps.gitRunner ? { gitRunner: deps.gitRunner } : deps.worktreeDeps,
					).catch(() => ({ headSha: 'HEAD', treeSha: 'HEAD' }))
				: { headSha: 'HEAD', treeSha: 'HEAD' };

			const bughuntPrompt = assembleBughuntPrompt({
				worktreePath: implRun.worktree_path ?? '',
				branchName: implRun.branch_name ?? '',
				baseSha: baseline.headSha,
				treeSha: baseline.treeSha,
				bugPrompt: context?.bugPrompt,
				promptSource: context?.promptSource ?? 'builtin',
				task: {
					taskId,
					title: `Task ${taskId}`,
					branchName: implRun.branch_name,
					worktreePath: implRun.worktree_path,
				},
			});

			const implSnapshot =
				implRun.snapshot_id && deps.dispatchSnapshotsRepo?.findById
					? deps.dispatchSnapshotsRepo.findById(implRun.snapshot_id)
					: null;

			let launchSpecJson = implSnapshot?.launch_spec_json ?? '{}';
			if (launchSpecJson === '{}' && deps.agentRegistry) {
				const snapshot = deps.agentRegistry.getSnapshot();
				const entry = snapshot.agents[agentId];
				if (entry) {
					launchSpecJson = JSON.stringify(entry);
				}
			}

			const assignmentJson = JSON.stringify({
				agentId,
				modelName,
				effortTier,
				effortVendor,
				source: 'task',
				capturedAt: now,
			});

			const snapshotId = deps.ids.newId();
			const allRuns = deps.runsRepo.listByTaskId(taskId);
			const nextAttemptNo = Math.max(0, ...allRuns.map((r) => r.attempt_no)) + 1;
			const bughuntRunId = deps.ids.newId();

			// 事务内插入快照与 kind='bughunt' 行，实施行保持 reviewing（AC 1, AC 2, E-316, E-329）
			deps.unitOfWork.run(() => {
				assertSessionRefFree({ taskId, vendorSessionRef: null }, { runsRepo: deps.runsRepo });

				if (deps.dispatchSnapshotsRepo) {
					// 子快照（09 节）：文本列与契约信息逐字复制实施快照，只把 impl_prompt 换成四段查 bug 提示词；
					// 「最近快照」类查询按 parent_snapshot_id IS NULL 跳过子快照，子快照不参与契约/提示词是否变化的判断。
					deps.dispatchSnapshotsRepo.insert({
						id: snapshotId,
						task_id: taskId,
						parent_snapshot_id: implRun.snapshot_id ?? null,
						input_text: implSnapshot?.input_text ?? null,
						output_text: implSnapshot?.output_text ?? null,
						accept_text: implSnapshot?.accept_text ?? null,
						review_prompt: implSnapshot?.review_prompt ?? null,
						bug_prompt: implSnapshot?.bug_prompt ?? null,
						impl_prompt: bughuntPrompt,
						launch_spec_json: launchSpecJson,
						assignment_json: assignmentJson,
						task_paths_json: implSnapshot?.task_paths_json ?? '[]',
						contract_hash: implSnapshot?.contract_hash ?? 'bughunt',
						created_at: now,
					});
				}

				const row: RunInsertRow = {
					id: bughuntRunId,
					task_id: taskId,
					attempt_no: nextAttemptNo,
					kind: 'bughunt',
					parent_run_id: implRun.id,
					state: 'queued',
					agent_id: agentId,
					model_name: modelName,
					effort_tier: effortTier,
					effort_vendor: effortVendor,
					permission_tier: 'workspaceWrite',
					snapshot_id: snapshotId,
					worktree_path: implRun.worktree_path,
					branch_name: implRun.branch_name,
					origin: 'dispatch',
					prompt_source: context?.promptSource ?? 'builtin',
					lane_no: implRun.lane_no,
					assignment_source: 'task',
					branch_tip_sha: baseline.headSha,
					started_at: now,
				};
				deps.runsRepo.insert(row);
			});

			const created = deps.runsRepo.findById(bughuntRunId);

			if (deps.bus && deps.envelopeFactory && created) {
				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.started',
						runId: bughuntRunId,
						taskId,
						actorDeviceId: input.actorDeviceId ?? null,
						payload: {
							run: toRunDto(created),
						},
					}),
				);
			}

			return Object.freeze({
				action: 'dispatched',
				bughuntRun: created ? toRunDto(created) : undefined,
			});
		},

		/**
		 * 终结查 bug 运行并解析结果（AC 3, AC 4, AC 5, E-307, E-308, E-320, E-321, E-323）。
		 * 事务前解析、事务内迁移、事务后投递。
		 */
		async finalizeBughuntRun(input: FinalizeBughuntRunInput): Promise<FinalizeBughuntRunResult> {
			const bughuntRun = deps.runsRepo.findById(input.bughuntRunId);
			if (!bughuntRun) {
				throw new AppError('E_NOT_FOUND', `Bughunt run '${input.bughuntRunId}' not found.`);
			}
			const implRunId = bughuntRun.parent_run_id;
			if (!implRunId) {
				throw new AppError('E_VALIDATION', 'Bughunt run missing parent_run_id.');
			}
			const implRun = deps.runsRepo.findById(implRunId);
			if (!implRun) {
				throw new AppError('E_NOT_FOUND', `Implementation run '${implRunId}' not found.`);
			}
			const taskId = bughuntRun.task_id;
			if (!taskId) {
				throw new AppError('E_VALIDATION', 'Bughunt run missing task_id.');
			}
			const now = deps.clock.now();

			// 1. 检查失败类情况（AC 5, E-323: failed / aborted / interrupted / 启动超时）
			const isExplicitFailure =
				input.failedReason !== undefined ||
				isTerminalRunState(bughuntRun.state as RunState) ||
				(input.exitCode !== undefined && input.exitCode !== null && input.exitCode !== 0);

			if (isExplicitFailure) {
				const gateId = `gate_${deps.ids.newId()}`;
				deps.unitOfWork.run(() => {
					if (!isTerminalRunState(bughuntRun.state as RunState)) {
						deps.runsRepo.updateState({
							id: bughuntRun.id,
							fromState: bughuntRun.state,
							toState: 'failed',
							endedAt: now,
							queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_FAILED,
							exitCode: input.exitCode ?? bughuntRun.exit_code,
							exitSignal: input.exitSignal ?? bughuntRun.exit_signal,
							actorDeviceId: input.actorDeviceId ?? null,
						});
					}

					deps.runsRepo.updateState({
						id: implRun.id,
						fromState: implRun.state,
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_FAILED,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.gatesRepo?.create({
						id: gateId,
						task_id: taskId,
						run_id: implRun.id,
						kind: 'review',
						state: 'waiting',
						comment: RUN_TRANSITION_REASONS.BUGHUNT_FAILED,
						created_at: now,
					});
				});

				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: implRun.id,
							taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: implRun.state,
								to: 'awaiting_human',
								reason: RUN_TRANSITION_REASONS.BUGHUNT_FAILED,
							},
						}),
					);
				}

				return Object.freeze({
					action: 'failed',
					reason: RUN_TRANSITION_REASONS.BUGHUNT_FAILED,
					gateId,
				});
			}

			// 2. 正常退出：bughunt 行走 reviewing（AC 3）
			// 事务前解析五段报告与工作区 diff（08 节）
			const parsed = parseBughuntReport(input.outputText ?? '');

			if (!parsed.ok) {
				// 不合五段：两行均 awaiting_human（reason bughunt_unparsed），查 bug 行开一张 kind='review' 闸门（AC 5, E-320）
				const gateId = `gate_${deps.ids.newId()}`;
				deps.unitOfWork.run(() => {
					deps.runsRepo.updateState({
						id: bughuntRun.id,
						fromState: bughuntRun.state,
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_UNPARSED,
						exitCode: input.exitCode ?? 0,
						exitSignal: input.exitSignal ?? null,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.runsRepo.updateState({
						id: implRun.id,
						fromState: implRun.state,
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_UNPARSED,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.gatesRepo?.create({
						id: gateId,
						task_id: taskId,
						run_id: bughuntRun.id,
						kind: 'review',
						state: 'waiting',
						comment: RUN_TRANSITION_REASONS.BUGHUNT_UNPARSED,
						created_at: now,
					});
				});

				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: bughuntRun.id,
							taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: bughuntRun.state,
								to: 'awaiting_human',
								reason: RUN_TRANSITION_REASONS.BUGHUNT_UNPARSED,
							},
						}),
					);
				}

				return Object.freeze({
					action: 'unparsed',
					reason: RUN_TRANSITION_REASONS.BUGHUNT_UNPARSED,
					gateId,
				});
			}

			// 计算工作区 diff（相对起点树基线，E-329）
			let hasWorkspaceDiff = false;
			if (bughuntRun.worktree_path) {
				try {
					const diffResult = await getDiffStat(bughuntRun.worktree_path, {
						baseRef: bughuntRun.branch_tip_sha ?? 'HEAD',
						deps: deps.worktreeDeps,
						runner: deps.gitRunner,
					});
					hasWorkspaceDiff = diffResult.filesChanged > 0;
				} catch {
					hasWorkspaceDiff = false;
				}
			}

			const outcome = decideBughuntOutcome({
				report: parsed,
				hasWorkspaceDiff,
				reworkCount: implRun.rework_count ?? 0,
			});

			if (outcome.outcome === 'rereview') {
				// FIXED 非空且 diff 非空，rework_count < 2：先 +1，通知同一审查会话再审（AC 4, E-307）
				deps.unitOfWork.run(() => {
					deps.runsRepo.updateState({
						id: bughuntRun.id,
						fromState: bughuntRun.state,
						toState: 'landed',
						endedAt: now,
						queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_REREVIEW,
						exitCode: input.exitCode ?? 0,
						exitSignal: input.exitSignal ?? null,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.runsRepo.updateState({
						id: implRun.id,
						reworkCount: outcome.newReworkCount,
						actorDeviceId: input.actorDeviceId ?? null,
					});
				});

				// 事务后投递：通知同一审查会话再审
				if (deps.reviewService) {
					await deps.reviewService.startReviewRound({
						taskId,
						implRunId: implRun.id,
						round: outcome.newReworkCount + 1,
						reworkItems: outcome.fixedItems,
						isBugHuntFix: true,
					});
				}

				return Object.freeze({
					action: 'rereview',
					newReworkCount: outcome.newReworkCount,
				});
			}

			if (outcome.outcome === 'awaiting_human') {
				const gateId = `gate_${deps.ids.newId()}`;
				deps.unitOfWork.run(() => {
					if (outcome.reason === 'bughunt_fixed_over_limit') {
						deps.runsRepo.updateState({
							id: bughuntRun.id,
							fromState: bughuntRun.state,
							toState: 'landed',
							endedAt: now,
							exitCode: input.exitCode ?? 0,
							exitSignal: input.exitSignal ?? null,
							actorDeviceId: input.actorDeviceId ?? null,
						});
					} else {
						deps.runsRepo.updateState({
							id: bughuntRun.id,
							fromState: bughuntRun.state,
							toState: 'awaiting_human',
							endedAt: now,
							queuedReason: outcome.reason,
							exitCode: input.exitCode ?? 0,
							exitSignal: input.exitSignal ?? null,
							actorDeviceId: input.actorDeviceId ?? null,
						});
					}

					deps.runsRepo.updateState({
						id: implRun.id,
						fromState: implRun.state,
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: outcome.reason,
						actorDeviceId: input.actorDeviceId ?? null,
					});

					deps.gatesRepo?.create({
						id: gateId,
						task_id: taskId,
						run_id: implRun.id,
						kind: 'review',
						state: 'waiting',
						comment: outcome.comment,
						created_at: now,
					});
				});

				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'run.state_changed',
							runId: implRun.id,
							taskId,
							actorDeviceId: input.actorDeviceId ?? null,
							payload: {
								from: implRun.state,
								to: 'awaiting_human',
								reason: outcome.reason,
							},
						}),
					);
				}

				return Object.freeze({
					action: 'awaiting_human',
					reason: outcome.reason,
					gateId,
				});
			}

			// outcome === 'gate'：干净或只剩 S3，走落地闸门（AC 4, E-308, E-321）
			const gatesService = deps.gatesService;
			if (!gatesService) {
				// 落地闸门是唯一出口：缺依赖时报错，绝不直落（落地闸门默认「等我确认」，E-53）。
				throw new AppError(
					'E_INTERNAL',
					'gatesService is required to route a clean bughunt run to the landing gate.',
				);
			}

			deps.unitOfWork.run(() => {
				deps.runsRepo.updateState({
					id: bughuntRun.id,
					fromState: bughuntRun.state,
					toState: 'landed',
					endedAt: now,
					queuedReason: RUN_TRANSITION_REASONS.BUGHUNT_CLEAN,
					exitCode: input.exitCode ?? 0,
					exitSignal: input.exitSignal ?? null,
					actorDeviceId: input.actorDeviceId ?? null,
				});
			});

			await gatesService.resolveAfterReviewAndApply({
				taskId,
				runId: implRun.id,
				reviewVerdict: 'pass',
			});

			return Object.freeze({
				action: 'gate',
			});
		},
	});
}
