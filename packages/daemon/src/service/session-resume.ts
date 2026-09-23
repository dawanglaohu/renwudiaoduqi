import type { UnitOfWork } from '../db/unit-of-work.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import type { LaunchSpec, ManagedProcess } from '../proc/spawn.ts';
import type { DocumentsRepo } from '../repo/documents.ts';
import type { RunMessagesRepo } from '../repo/run-messages-repo.ts';
import type { RunRow, RunsRepo } from '../repo/runs.ts';
import type { TasksRepo } from '../repo/tasks.ts';
import type { EventEnvelopeInput } from './logstore.ts';
import type { ResumeSessionInput, ResumeSessionResult } from './message.ts';

/**
 * 恢复投递失败的类型化原因（#136 / E-112）。
 * 原因既写进运行行的 `queued_reason`，也通过 `E_MESSAGE_UNDELIVERED.details.reason` 回给调用方。
 */
export type SessionResumeFailureReason =
	| 'vendor_session_missing'
	| 'session_resume_unavailable'
	| 'session_resume_spec_failed'
	| 'spawn_failed'
	| 'premature_exit';

/** 恢复投递失败时留在运行行上的 `queued_reason` 前缀。 */
export const SESSION_RESUME_FAILED_REASON_PREFIX = 'session_resume_failed';

export interface SessionResumeAdapter {
	readonly buildLaunchSpec: (options: {
		readonly runId: string;
		readonly cwd: string;
		readonly model?: string | null;
		readonly effortTier?: unknown;
		readonly permissionTier?: unknown;
		readonly prompt?: string;
		readonly [key: string]: unknown;
	}) => LaunchSpec;
	readonly mapEvents: (vendorLine: unknown) => readonly EventEnvelopeInput[];
}

export interface SessionResumeRunWiring {
	readonly attachProcess: (
		runId: string,
		process: ManagedProcess,
		options?: {
			readonly eventMapper?: (vendorLine: unknown) => readonly EventEnvelopeInput[];
		},
	) => unknown;
	readonly transitionState: (input: {
		readonly runId: string;
		readonly targetState: 'running';
		readonly reason: string;
		readonly pid?: number | null;
		readonly worktreePath?: string | null;
		readonly branchName?: string | null;
	}) => Promise<unknown>;
}

export interface SessionResumeDeps {
	readonly runsRepo: RunsRepo;
	readonly tasksRepo?: TasksRepo;
	readonly documentsRepo?: DocumentsRepo;
	readonly runMessagesRepo?: RunMessagesRepo;
	readonly processRegistry?: ProcessRegistry;
	readonly runService?: SessionResumeRunWiring;
	readonly proc?: { readonly spawnManaged: (spec: LaunchSpec) => ManagedProcess };
	readonly adapters?: Readonly<Record<string, SessionResumeAdapter>>;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly unitOfWork?: UnitOfWork;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly logFailure?: (error: unknown) => void;
}

/**
 * 生产容器的 `resumeSession` 实现（M6-T6 约定、M7-T5 / M7-T7 消费）。
 *
 * 约定：调用方已经写好一条 `state='starting'`、带 `vendor_session_ref` 的新运行行，
 * 本函数负责**真的把进程拉起来**并把消息文本交给它，然后才返回 `delivered: true`。
 *
 * 三条硬规则：
 * 1. 没有厂商会话引用、没有适配器、没有 `runService` / `spawnManaged` → 抛类型化错误，绝不返回成功。
 * 2. 启动失败或启动即退出 → 运行行落 `failed` + `queued_reason='session_resume_failed:<reason>'`，
 *    再抛 `E_MESSAGE_UNDELIVERED`，让上游留下可恢复状态而不是虚假成功。
 * 3. 交付文本进的是启动参数（`codex exec resume <ref> <prompt>` / `grok --resume <ref> -p <prompt>`）,
 *    成功后再落一条 `run_messages` 已送达记录并发 `run.message_delivered`。
 */
export function createSessionResumeDispatcher(
	deps: SessionResumeDeps,
): (input: ResumeSessionInput) => Promise<ResumeSessionResult> {
	function fail(run: RunRow | null, reason: SessionResumeFailureReason, message: string): AppError {
		if (run) {
			const now = deps.clock.now();
			deps.runsRepo.updateState({
				id: run.id,
				state: 'failed',
				fromState: run.state,
				toState: 'failed',
				queuedReason: `${SESSION_RESUME_FAILED_REASON_PREFIX}:${reason}`,
				endedAt: now,
				actorDeviceId: null,
			});
		}
		return new AppError('E_MESSAGE_UNDELIVERED', message, {
			details: {
				runId: run?.id ?? null,
				taskId: run?.task_id ?? null,
				reason,
			},
		});
	}

	return async function resumeSession(input: ResumeSessionInput): Promise<ResumeSessionResult> {
		const run = deps.runsRepo.findById(input.runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run '${input.runId}' was not found.`, {
				details: { runId: input.runId },
			});
		}

		if (run.session_archived_at) {
			throw new AppError(
				'E_SESSION_ARCHIVED',
				`Run '${run.id}' session is archived and read-only.`,
				{ details: { runId: run.id, taskId: run.task_id } },
			);
		}

		const vendorSessionRef = run.vendor_session_ref;
		if (!vendorSessionRef) {
			throw fail(
				run,
				'vendor_session_missing',
				`Run '${run.id}' has no vendor session reference to resume.`,
			);
		}

		const adapter = deps.adapters?.[run.agent_id];
		if (!adapter || !deps.proc || !deps.runService) {
			throw fail(
				run,
				'session_resume_unavailable',
				`No session resume dispatcher is wired for agent '${run.agent_id}'.`,
			);
		}

		const task = run.task_id && deps.tasksRepo ? deps.tasksRepo.findById(run.task_id) : null;
		const docRow =
			task?.doc_id && deps.documentsRepo ? deps.documentsRepo.findById(task.doc_id) : null;
		const cwd = run.worktree_path ?? docRow?.repo_path ?? '';

		let spec: LaunchSpec;
		try {
			spec = adapter.buildLaunchSpec({
				runId: run.id,
				cwd,
				model: run.model_name ?? null,
				effortTier: run.effort_tier ?? null,
				permissionTier: run.permission_tier ?? 'workspaceWrite',
				prompt: input.text,
				resumeSessionRef: vendorSessionRef,
				// codex 只有 exec 模式能带 `resume` 子命令（E-112 恢复通路）。
				...(run.agent_id === 'codex' ? { mode: 'exec' } : {}),
			});
		} catch (error) {
			deps.logFailure?.(error);
			throw fail(
				run,
				'session_resume_spec_failed',
				`Failed to assemble the resume launch spec for run '${run.id}': ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		let managed: ManagedProcess;
		try {
			managed = deps.proc.spawnManaged(spec);
		} catch (error) {
			deps.logFailure?.(error);
			throw fail(
				run,
				'spawn_failed',
				`Failed to spawn the resumed session for run '${run.id}': ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}

		if (managed.isExited) {
			throw fail(
				run,
				'premature_exit',
				`Resumed session for run '${run.id}' exited before it could receive the message.`,
			);
		}

		deps.runService.attachProcess(run.id, managed, { eventMapper: adapter.mapEvents });

		await deps.runService.transitionState({
			runId: run.id,
			targetState: 'running',
			reason: 'session_resumed',
			pid: managed.pid,
			worktreePath: cwd,
			branchName: run.branch_name ?? null,
		});

		const messageId = deps.ids.newId();
		const now = deps.clock.now();
		let envelope: ReturnType<EnvelopeFactory['createEnvelope']> | null = null;

		const persistDelivered = () => {
			deps.runMessagesRepo?.insertMessage({
				id: messageId,
				runId: run.id,
				kind: input.kind,
				text: input.text,
				deliveryState: 'delivered',
				undeliveredReason: null,
				actorDeviceId: input.actorDeviceId ?? null,
				createdAt: now,
				deliveredAt: now,
			});

			if (deps.envelopeFactory) {
				envelope = deps.envelopeFactory.createEnvelope({
					kind: 'run.message_delivered',
					runId: run.id,
					taskId: run.task_id,
					actorDeviceId: input.actorDeviceId ?? null,
					payload: { messageId },
				});
			}
		};

		if (deps.unitOfWork) {
			deps.unitOfWork.run(persistDelivered);
		} else {
			persistDelivered();
		}

		if (envelope && deps.bus) {
			deps.bus.publish(envelope);
		}

		return Object.freeze({
			newRunId: run.id,
			messageId,
			delivered: true,
		});
	};
}
