import { promises as nodeFs } from 'node:fs';
import { resolve as nodeResolve } from 'node:path';
import type { EventEnvelope } from '@agent-scheduler/shared/api/events';
import type { ErrorCode } from '@agent-scheduler/shared/errors/codes';
import type { AgentRegistry } from '../config/registry.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import type { EffortTier } from '../domain/effort-tier.ts';
import { assembleReviewRoundPrompt } from '../domain/rework-prompt.ts';
import {
	RUN_TRANSITION_REASONS,
	type RunState,
	assertValidTransition,
	isValidRunState,
} from '../domain/run-state-machine.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { PlatformHostInputs, SupportedPlatform } from '../platform/contract.ts';
import { platformPathAdapter, takePlatformHostInputs } from '../platform/host.ts';
import { resolveExecutable } from '../platform/resolve-executable.ts';
import type { ProcessRegistry } from '../proc/registry.ts';
import {
	type LaunchSpec,
	type ManagedProcess,
	type ProcessExitReason,
	type ProcessExitResult,
	spawnManaged,
} from '../proc/spawn.ts';
import { DEFAULT_CHECK_TIMEOUT_MS, type LaunchTimeouts } from '../proc/timers.ts';
import type { DispatchSnapshotsRepo } from '../repo/dispatch-snapshots.ts';
import type { RunInsertRow, RunRow } from '../repo/runs.ts';
import type { SettingsRepo } from '../repo/settings.ts';
import {
	type DiffStatResult,
	type GitRunner,
	type WorktreeManagerDeps,
	getDiffStat,
	getDiffText,
} from '../workspace/diff.ts';
import type { BughuntService } from './bughunt.ts';
import type { GateService } from './gates.ts';
import type { MessageService, ResumeSessionInput, ResumeSessionResult } from './message.ts';
import { waitForContinuationState } from './message.ts';
import { type ReviewAgentAssignment, buildReviewLaunchSpec } from './review-agent.ts';
import type { SettingsService } from './settings.ts';

export { DEFAULT_CHECK_TIMEOUT_MS };

/** E-330 判定窗口：投递后等首条内容事件或失败类事件的上限。 */
const CONTINUATION_TIMEOUT_MS = 180_000;
/** E-330：新开的审查会话再次在内容前失败时写进运行行与闸门 comment 的原因串。 */
export const REVIEW_CONTINUATION_FAILED = 'review_continuation_failed' as const;

/**
 * UI / State machine tags and notices for mechanical check (AC 1-4, E-60, E-61, E-66, E-67).
 */
export const MECHANICAL_COVERAGE_LIMITED_TAG = '机械检查覆盖有限' as const; // E-60
export const NO_CHANGES_TAG = '无改动' as const; // E-61, E-23
export const MECHANICAL_CHECK_TIMEOUT_TAG = '机械检查超时' as const; // E-66
export const MECHANICAL_CHECK_PASSED_TAG = '机械检查通过' as const;
export const COMMAND_FAILED_TAG = '命令执行失败' as const;
export const COMMAND_NOT_FOUND_TAG = '找不到检查命令' as const;
export const ZERO_CONFIG_FAILED_TAG = '零配置检查失败' as const;
export const KEYWORDS_MISSED_TAG = '验收关键词未命中' as const;
export const EXIT_CODE_FAILED_TAG = '进程退出码非零' as const;
export const SESSION_ERROR_TAG = '会话异常' as const;

/**
 * Structured definition of a project check command (build / test).
 */
export interface CheckCommandObject {
	readonly file: string;
	readonly args?: readonly string[];
	readonly timeoutMs?: number;
	readonly label?: string;
	readonly envOverrides?: Readonly<Record<string, string | undefined>>;
}

/**
 * Input format for project check commands: command string, argv array, or command object.
 */
export type ProjectCheckCommandSpec = string | readonly string[] | CheckCommandObject;

/**
 * Execution result of a single project check command.
 */
export interface CheckCommandResult {
	readonly command: string;
	readonly file: string;
	readonly args: readonly string[];
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
	readonly errorCode?: ErrorCode;
}

/**
 * Pluggable command runner for executing project check commands in a worktree.
 */
export type CommandRunner = (
	command: CheckCommandObject,
	cwd: string,
	timeouts?: LaunchTimeouts,
) => Promise<CheckCommandResult>;

/**
 * Input for running the two-layer mechanical check (AC 1-4, E-23, E-60, E-61, E-66, E-67).
 */
export interface MechanicalCheckInput {
	/**
	 * Path to the task's worktree directory (MUST NOT be user main repository, E-67).
	 */
	readonly worktreePath: string;

	/**
	 * Optional path to user primary repository root to guard against E-67.
	 */
	readonly mainRepoPath?: string;

	/**
	 * Exit code of the completed implementation run.
	 */
	readonly exitCode?: number | null;

	/**
	 * Whether the implementation session suffered a fatal process error.
	 */
	readonly hasFatalError?: boolean;

	/**
	 * Exit reason from the implementation run (e.g. 'spawn-failed', 'startup-timeout').
	 */
	readonly exitReason?: ProcessExitReason | string;

	/**
	 * Error details from the implementation run.
	 */
	readonly errorDetail?: string;

	/**
	 * Raw acceptance criteria text from dispatch snapshot (e.g. snapshot.accept_text).
	 */
	readonly acceptText?: string;

	/**
	 * Explicit keywords to match against the worktree changes.
	 * If omitted, keywords will be automatically extracted from acceptText.
	 */
	readonly acceptanceKeywords?: readonly string[];

	/**
	 * Build / test commands declared by project documents (E-60).
	 * If omitted or empty, project command layer is skipped and UI displays '机械检查覆盖有限'.
	 */
	readonly projectCommands?: readonly ProjectCheckCommandSpec[];

	/**
	 * Git base reference for diff comparison (defaults to 'HEAD', E-72).
	 */
	readonly baseRef?: string;

	/**
	 * Pre-computed diff statistics (optional, avoids re-running git diff if already available).
	 */
	readonly diffStat?: DiffStatResult;

	/**
	 * Pre-computed unified diff text (optional).
	 */
	readonly diffText?: string;

	/**
	 * Custom hard timeout for build/test commands (defaults to DEFAULT_CHECK_TIMEOUT_MS = 10 min, E-66).
	 */
	readonly timeoutMs?: number;
}

/**
 * Details of Layer 1: Zero-configuration mechanical checks (AC 1).
 */
export interface ZeroConfigLayerResult {
	readonly passed: boolean;
	readonly diffCheck: {
		readonly passed: boolean;
		readonly hasChanges: boolean;
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
	readonly exitCodeCheck: {
		readonly passed: boolean;
		readonly exitCode: number | null;
	};
	readonly sessionErrorCheck: {
		readonly passed: boolean;
		readonly hasFatalError: boolean;
		readonly errorDetail?: string;
	};
	readonly keywordsCheck: {
		readonly passed: boolean;
		readonly requiredKeywords: readonly string[];
		readonly matchedKeywords: readonly string[];
	};
	readonly reason?: string;
}

/**
 * Details of Layer 2: Project command layer checks (AC 1, E-60, E-66).
 */
export interface ProjectCommandLayerResult {
	readonly passed: boolean;
	readonly executed: boolean;
	readonly coverageLimited: boolean;
	readonly notice?: string;
	readonly commands: readonly CheckCommandResult[];
	readonly timedOut: boolean;
	readonly failedCommand?: string;
	readonly reason?: string;
}

/**
 * Outcome of the complete two-layer mechanical check (AC 1-4).
 */
export interface MechanicalCheckResult {
	/**
	 * Whether all mechanical checks passed cleanly.
	 */
	readonly passed: boolean;

	/**
	 * Target state for state machine transition ('reviewing' if passed, 'awaiting_human' if failed).
	 */
	readonly targetState: 'reviewing' | 'awaiting_human';

	/**
	 * Standard transition reason string (e.g. RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED).
	 */
	readonly reason: string;

	/**
	 * Human-readable tag / UI label (e.g. '无改动', '机械检查超时', '机械检查覆盖有限').
	 */
	readonly tag: string;

	/**
	 * Whether a review agent should be dispatched.
	 * MUST BE FALSE when mechanical check fails (E-61, E-66: 不派审查 agent).
	 */
	readonly canDispatchReviewAgent: boolean;

	/**
	 * Whether this failure is retryable.
	 * FALSE for mechanical check timeout (E-66: 标「机械检查超时」转人，不重试) and no changes (E-61).
	 */
	readonly retryable: boolean;

	/**
	 * Worktree path where the check was executed (E-67).
	 */
	readonly worktreePath: string;

	/**
	 * Zero-configuration layer details (AC 1).
	 */
	readonly zeroConfigLayer: ZeroConfigLayerResult;

	/**
	 * Project command layer details (AC 1, E-60, E-66).
	 */
	readonly projectCommandLayer: ProjectCommandLayerResult;

	/**
	 * Git diff stat of the worktree changes.
	 */
	readonly diffStat?: DiffStatResult;
}

/**
 * Minimal run record needed by review service for state evaluation.
 * 结构化子集：真实 RunsRepo 的 RunRow 满足它，单测可以只造这几个字段。
 */
export type ReviewRunRecord = {
	readonly id: string;
	readonly state: string;
	/** RunsRepo 的 RunRow 用 snake_case；老的 RunsAbortRepo 记录用 camelCase，两种都接。 */
	readonly task_id?: string | null;
	readonly parent_run_id?: string | null;
	readonly kind?: string;
	readonly worktree_path?: string | null;
	readonly pid?: number | null;
	readonly changed_file_count?: number | null;
	readonly rework_count?: number;
	readonly taskId?: string;
	readonly worktreePath?: string | null;
	readonly changedFileCount?: number | null;
	readonly reworkCount?: number;
};

/**
 * Repository interface for updating run states during review.
 * 只声明 review 真正用到的成员；M7-T7 的续接入口用到的三个方法可缺省（老测试桩不实现它们）。
 */
export interface ReviewRunsRepo {
	readonly findById: (id: string) => ReviewRunRecord | null;
	readonly updateState: (input: {
		readonly id: string;
		readonly state?: string;
		readonly fromState: RunState;
		readonly toState: RunState;
		readonly endedAt: string;
		readonly queuedReason?: string | null;
		readonly changedFileCount?: number | null;
		readonly exitCode?: number | null;
		readonly exitSignal?: string | null;
		readonly actorDeviceId?: string | null;
		readonly reworkCount?: number;
	}) => void;
	/** M7-T7 续接：上一轮审查行（按 review_round DESC 取最新）。 */
	readonly findLatestReview?: (taskId: string) => RunRow | null;
	readonly insert?: (row: RunInsertRow) => void;
	readonly updateReviewRound?: (
		id: string,
		reviewRound: number | null,
		continuedFromRunId?: string | null,
	) => void;
	readonly findByParentRunIdAndKind?: (parentRunId: string, kind: string) => RunRow | null;
	/** 同任务全部运行行：新一轮的 attempt_no 取最大值 + 1（`UNIQUE (task_id, attempt_no)`）。 */
	readonly listByTaskId?: (taskId: string) => readonly { readonly attempt_no: number }[];
}

/**
 * Repository interface for recording human review gates.
 */
export interface ReviewGatesRepo {
	insert(input: {
		readonly id: string;
		readonly taskId: string;
		readonly runId: string | null;
		readonly kind: 'dispatch' | 'review' | 'landing';
		readonly state: 'waiting' | 'decided';
		readonly comment?: string | null;
		readonly createdAt: string;
	}): void;
}

/**
 * Dependencies for mechanical check execution and review service.
 */
export interface MechanicalCheckDeps {
	readonly platform?: SupportedPlatform;
	readonly hostInputs?: PlatformHostInputs;
	readonly clock?: { readonly now: () => string };
	readonly ids?: { readonly newId: () => string };
	readonly spawnManaged?: (
		spec: LaunchSpec,
		options: Parameters<typeof spawnManaged>[1],
	) => ManagedProcess;
	readonly commandRunner?: CommandRunner;
	readonly gitRunner?: GitRunner;
	readonly worktreeDeps?: WorktreeManagerDeps;
}

export interface ReviewServiceDeps extends MechanicalCheckDeps {
	readonly runsRepo?: ReviewRunsRepo;
	readonly gatesRepo?: ReviewGatesRepo;
	readonly unitOfWork?: UnitOfWork;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly messageService?: MessageService;
	readonly processRegistry?: ProcessRegistry;
	readonly spawnManagedFn?: typeof spawnManaged;
	readonly agentRegistry?: AgentRegistry;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly bughuntService?: BughuntService;
	readonly settingsRepo?: SettingsRepo;
	readonly settingsService?: SettingsService;
	readonly gatesService?: GateService;
	/** 续接撑爆时改走恢复分支：与 rework.ts 的 resumeSession 同一约定。 */
	readonly resumeSession?: (input: ResumeSessionInput) => Promise<ResumeSessionResult>;
}

export interface EvaluateMechanicalCheckInput {
	readonly runId: string;
	readonly taskId?: string;
	readonly worktreePath?: string;
	readonly mainRepoPath?: string;
	readonly exitCode?: number | null;
	readonly hasFatalError?: boolean;
	readonly exitReason?: string;
	readonly acceptText?: string;
	readonly acceptanceKeywords?: readonly string[];
	readonly projectCommands?: readonly ProjectCheckCommandSpec[];
	readonly baseRef?: string;
	readonly diffStat?: DiffStatResult;
	readonly diffText?: string;
	readonly timeoutMs?: number;
}

export interface EvaluateMechanicalCheckResult {
	readonly result: MechanicalCheckResult;
	readonly previousState: RunState;
	readonly currentState: RunState;
	readonly gateCreated: boolean;
}

export interface StartReviewRoundInput {
	readonly taskId: string;
	readonly implRunId: string;
	readonly round: number;
	readonly reworkItems: readonly string[];
	readonly isBugHuntFix?: boolean;
}

export interface FinalizeReviewRunInput {
	readonly reviewRunId: string;
	readonly verdict: 'pass' | 'rework' | 'doc_issue' | 'incomplete';
	readonly outputText?: string;
	readonly reworkText?: string;
	readonly actorDeviceId?: string | null;
}

export interface FinalizeReviewRunResult {
	readonly action:
		| 'bughunt_dispatched'
		| 'landing_gate'
		| 'rework'
		| 'doc_issue'
		| 'awaiting_human';
	readonly bughuntRunId?: string;
	readonly gateId?: string;
}

export interface ReviewService {
	readonly runMechanicalCheck: (input: MechanicalCheckInput) => Promise<MechanicalCheckResult>;
	readonly evaluateMechanicalCheck: (
		input: EvaluateMechanicalCheckInput,
	) => Promise<EvaluateMechanicalCheckResult>;
	readonly startReviewRound: (input: StartReviewRoundInput) => Promise<string>;
	readonly finalizeReviewRun: (input: FinalizeReviewRunInput) => Promise<FinalizeReviewRunResult>;
}

/**
 * Common English stop words filtered out during keyword extraction.
 */
const COMMON_STOP_WORDS = new Set([
	'and',
	'the',
	'for',
	'with',
	'from',
	'that',
	'this',
	'have',
	'then',
	'when',
	'which',
	'must',
	'should',
	'will',
	'each',
	'every',
	'both',
	'not',
	'only',
	'also',
	'into',
	'over',
	'after',
	'before',
]);

/**
 * Extracts acceptance criteria keywords from acceptance text (AC 1).
 * Extracts boundary IDs (e.g. E-60), task codes (e.g. M7-T1), code identifiers,
 * quoted phrases, and technical Chinese terms.
 */
export function extractAcceptanceKeywords(acceptText?: string): readonly string[] {
	if (!acceptText || acceptText.trim().length === 0) {
		return Object.freeze([]);
	}

	const text = acceptText.trim();
	const keywords = new Set<string>();

	// 1. Boundary IDs, task IDs, error codes (e.g. E-60, M7-T1, E_VALIDATION)
	const codeMatches = text.match(/\b(?:E-\d+|M\d+-T\d+|E_[A-Z0-9_]+)\b/g);
	if (codeMatches) {
		for (const match of codeMatches) {
			keywords.add(match);
		}
	}

	// 2. Quoted terms and bracketed items: 「...」, 『...』, "..."
	const quoteMatches = text.match(/[「『"']([^「『"' \t\r\n]{2,30})[」』"']/g);
	if (quoteMatches) {
		for (const raw of quoteMatches) {
			const clean = raw.replace(/^[「『"']|[」』"']$/g, '').trim();
			if (clean.length >= 2) {
				keywords.add(clean);
			}
		}
	}

	// 3. Technical code identifiers and symbols (camelCase, kebab-case, snake_case, PascalCase)
	const identMatches = text.match(/\b[a-zA-Z][a-zA-Z0-9_.-]{2,}\b/g);
	if (identMatches) {
		for (const ident of identMatches) {
			const lower = ident.toLowerCase();
			if (!COMMON_STOP_WORDS.has(lower) && ident.length >= 3) {
				keywords.add(ident);
			}
		}
	}

	// 4. Significant Chinese technical keywords (2-6 chars)
	const chineseKeywords = [
		'零配置',
		'退出码',
		'致命错误',
		'验收关键词',
		'无改动',
		'机械检查',
		'硬超时',
		'覆盖有限',
		'执行目录',
		'超时',
		'工作区',
		'只读',
		'审查',
		'返工',
		'状态机',
	];
	for (const ck of chineseKeywords) {
		if (text.includes(ck)) {
			keywords.add(ck);
		}
	}

	return Object.freeze(Array.from(keywords));
}

/**
 * Checks whether any of the required keywords are hit in the diff text or modified file paths (AC 1).
 */
export function matchesAcceptanceKeywords(
	keywords: readonly string[],
	diffText: string,
	filePaths?: readonly string[],
): { readonly hit: boolean; readonly matched: readonly string[] } {
	if (!keywords || keywords.length === 0) {
		return Object.freeze({ hit: true, matched: Object.freeze([]) });
	}

	const matched = new Set<string>();
	const lowerDiff = diffText.toLowerCase();
	const normalizedPaths = (filePaths ?? []).map((p) => p.toLowerCase());

	for (const kw of keywords) {
		const isAscii = kw.split('').every((c) => c.charCodeAt(0) <= 127);
		if (isAscii) {
			const kwLower = kw.toLowerCase();
			if (lowerDiff.includes(kwLower)) {
				matched.add(kw);
			}
			if (normalizedPaths.some((p) => p.includes(kwLower))) {
				matched.add(kw);
			}
		} else {
			if (diffText.includes(kw)) {
				matched.add(kw);
			}
			if ((filePaths ?? []).some((p) => p.includes(kw))) {
				matched.add(kw);
			}
		}
	}

	return Object.freeze({
		hit: matched.size > 0,
		matched: Object.freeze(Array.from(matched)),
	});
}

/**
 * Parses command-line string into executable and arguments preserving quotes.
 */
export function parseCommandString(commandStr: string): {
	readonly file: string;
	readonly args: readonly string[];
} {
	const trimmed = commandStr.trim();
	if (trimmed.length === 0) {
		throw new AppError('E_VALIDATION', 'Command string must not be empty');
	}

	const args: string[] = [];
	let current = '';
	let inQuote: '"' | "'" | null = null;

	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (char === '\\' && i + 1 < trimmed.length && inQuote !== "'") {
			current += trimmed[++i];
			continue;
		}
		if (char === '"' || char === "'") {
			if (inQuote === null) {
				inQuote = char;
			} else if (inQuote === char) {
				inQuote = null;
			} else {
				current += char;
			}
			continue;
		}
		if ((char === ' ' || char === '\t') && inQuote === null) {
			if (current.length > 0) {
				args.push(current);
				current = '';
			}
			continue;
		}
		current += char;
	}

	if (current.length > 0) {
		args.push(current);
	}

	if (args.length === 0 || !args[0]) {
		throw new AppError('E_VALIDATION', `Failed to parse command string: ${commandStr}`);
	}

	return Object.freeze({
		file: args[0],
		args: Object.freeze(args.slice(1)),
	});
}

/**
 * Normalizes any ProjectCheckCommandSpec to CheckCommandObject.
 */
export function normalizeCommandSpec(spec: ProjectCheckCommandSpec): CheckCommandObject {
	if (typeof spec === 'string') {
		const parsed = parseCommandString(spec);
		return Object.freeze({
			file: parsed.file,
			args: parsed.args,
			label: spec,
		});
	}
	if (Array.isArray(spec)) {
		const arr = spec as readonly string[];
		if (arr.length === 0 || typeof arr[0] !== 'string') {
			throw new AppError('E_VALIDATION', 'Command argv array must contain at least an executable');
		}
		return Object.freeze({
			file: arr[0],
			args: Object.freeze(arr.slice(1)),
			label: arr.join(' '),
		});
	}
	if (typeof spec === 'object' && spec !== null && 'file' in spec) {
		const cmdObj = spec as CheckCommandObject;
		if (typeof cmdObj.file !== 'string' || cmdObj.file.trim().length === 0) {
			throw new AppError('E_VALIDATION', 'CheckCommandObject file must be a non-empty string');
		}
		return Object.freeze({
			file: cmdObj.file,
			args: cmdObj.args ?? Object.freeze([]),
			timeoutMs: cmdObj.timeoutMs,
			label: cmdObj.label ?? `${cmdObj.file} ${(cmdObj.args ?? []).join(' ')}`.trim(),
			envOverrides: cmdObj.envOverrides,
		});
	}
	throw new AppError('E_VALIDATION', 'Invalid command specification');
}

/**
 * Validates that the worktree directory is an accessible directory and strictly
 * not the user's primary project workspace (E-67).
 */
export async function assertWorktreeDirectory(
	worktreePath: string,
	mainRepoPath?: string,
): Promise<string> {
	if (!worktreePath || typeof worktreePath !== 'string' || worktreePath.trim().length === 0) {
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			'Task worktree path must be a non-empty string (E-67)',
		);
	}

	const resolvedWorktree = nodeResolve(worktreePath.trim());

	// E-67: Execute directory MUST ALWAYS be the task's worktree, NEVER the user main workspace
	if (mainRepoPath && typeof mainRepoPath === 'string' && mainRepoPath.trim().length > 0) {
		const resolvedMain = nodeResolve(mainRepoPath.trim());
		const isSame =
			resolvedWorktree.toLowerCase() === resolvedMain.toLowerCase() ||
			resolvedWorktree === resolvedMain;

		if (isSame) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Mechanical check execution directory must be a task worktree, never the user main workspace: ${resolvedWorktree} (E-67)`,
				{ details: { worktreePath: resolvedWorktree, mainRepoPath: resolvedMain } },
			);
		}
	}

	try {
		const stat = await nodeFs.stat(resolvedWorktree);
		if (!stat.isDirectory()) {
			throw new AppError(
				'E_WORKSPACE_UNAVAILABLE',
				`Worktree path is not a directory: ${resolvedWorktree}`,
				{ details: { worktreePath: resolvedWorktree } },
			);
		}
	} catch (cause) {
		if (cause instanceof AppError) throw cause;
		throw new AppError(
			'E_WORKSPACE_UNAVAILABLE',
			`Worktree path is inaccessible: ${resolvedWorktree}`,
			{ cause, details: { worktreePath: resolvedWorktree } },
		);
	}

	return resolvedWorktree;
}

function resolveEffectiveHostInputs(deps: MechanicalCheckDeps): PlatformHostInputs {
	if (deps.hostInputs) {
		return deps.hostInputs;
	}
	const hostResult = takePlatformHostInputs({});
	if (hostResult.ok) {
		return {
			...hostResult.value,
			platform: deps.platform ?? hostResult.value.platform,
		};
	}
	return {
		platform: deps.platform ?? 'linux',
		homedir: '',
	};
}

type ResolvedCommand =
	| { readonly ok: true; readonly file: string; readonly argsPrefix: readonly string[] }
	| { readonly ok: false; readonly error: { readonly code: ErrorCode; readonly message: string } };

/**
 * Resolves an executable name or relative path to an absolute path for spawnManaged (E-130, E-42, R1, R2).
 */
async function resolveCommandExecutable(
	commandFile: string,
	cwd: string,
	deps: MechanicalCheckDeps,
): Promise<ResolvedCommand> {
	// If already an absolute path, verify and return
	if (commandFile.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(commandFile)) {
		try {
			const stat = await nodeFs.stat(commandFile);
			if (stat.isFile()) {
				return { ok: true, file: commandFile, argsPrefix: Object.freeze([]) };
			}
			return {
				ok: false,
				error: {
					code: 'E_AGENT_EXEC_INVALID_TARGET',
					message: `The executable path does not resolve to a regular file: ${commandFile}`,
				},
			};
		} catch {
			return {
				ok: false,
				error: {
					code: 'E_AGENT_EXEC_NOT_FOUND',
					message: `The executable file does not exist: ${commandFile}`,
				},
			};
		}
	}

	// If relative path like './bin/test.sh', resolve against cwd
	if (commandFile.startsWith('./') || commandFile.startsWith('.\\')) {
		const resolved = nodeResolve(cwd, commandFile);
		try {
			const stat = await nodeFs.stat(resolved);
			if (stat.isFile()) {
				return { ok: true, file: resolved, argsPrefix: Object.freeze([]) };
			}
			return {
				ok: false,
				error: {
					code: 'E_AGENT_EXEC_INVALID_TARGET',
					message: `The executable path does not resolve to a regular file: ${resolved}`,
				},
			};
		} catch {
			return {
				ok: false,
				error: {
					code: 'E_AGENT_EXEC_NOT_FOUND',
					message: `The executable file does not exist: ${resolved}`,
				},
			};
		}
	}

	const hostInputs = resolveEffectiveHostInputs(deps);
	const platform = hostInputs.platform;

	const resolution = await resolveExecutable({
		hostInputs,
		executableName: commandFile,
	});
	if (resolution.ok) {
		// R1: USE resolution.executable.sourcePath (validated .cmd/.bat path) instead of file (cmd.exe)
		// spawnManaged expects .cmd/.bat in spec.file so it can wrap it with ComSpec and /d /s /c
		return {
			ok: true,
			file: resolution.executable.sourcePath,
			argsPrefix: resolution.executable.argsPrefix,
		};
	}

	// Check platform adapter candidate paths
	try {
		const adapter = platformPathAdapter(platform);
		const candidates = adapter.executableCandidatePaths(commandFile, hostInputs);
		for (const candidate of candidates) {
			try {
				const stat = await nodeFs.stat(candidate);
				if (stat.isFile()) {
					return { ok: true, file: candidate, argsPrefix: Object.freeze([]) };
				}
			} catch {
				// Continue to next candidate
			}
		}
	} catch {
		// Ignore and fallback
	}

	// R2: Return structured resolution error, do NOT proceed to spawnManaged or fallback to bare name
	return {
		ok: false,
		error: {
			code: resolution.error.code,
			message: resolution.error.message,
		},
	};
}

/**
 * Creates the default command runner backed by spawnManaged and killTree (E-66, E-67, R1, R2).
 */
export function createDefaultCommandRunner(deps: MechanicalCheckDeps): CommandRunner {
	const spawnImpl = deps.spawnManaged ?? spawnManaged;
	const hostInputs = resolveEffectiveHostInputs(deps);
	const platform: SupportedPlatform = hostInputs.platform;
	const ids = deps.ids ?? {
		newId: () => Math.random().toString(36).slice(2, 10),
	};

	return async function runCommand(
		command: CheckCommandObject,
		cwd: string,
		timeouts?: LaunchTimeouts,
	): Promise<CheckCommandResult> {
		const timeoutMs = command.timeoutMs ?? timeouts?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
		const startTime = Date.now();
		const runId = `check_${ids.newId()}`;

		const resolved = await resolveCommandExecutable(command.file, cwd, deps);
		if (!resolved.ok) {
			// R2: Do NOT proceed to spawnManaged. Expose resolution error code directly!
			return Object.freeze({
				command: command.label ?? `${command.file} ${(command.args ?? []).join(' ')}`.trim(),
				file: command.file,
				args: Object.freeze(command.args ?? []),
				exitCode: null,
				signal: null,
				stdout: '',
				stderr: resolved.error.message,
				timedOut: false,
				durationMs: 0,
				errorCode: resolved.error.code,
			});
		}

		const resolvedExecutableFile = resolved.file;
		const fullArgs = [...resolved.argsPrefix, ...(command.args ?? [])];

		const spec: LaunchSpec = {
			runId,
			file: resolvedExecutableFile,
			args: fullArgs,
			cwd,
			envOverrides: command.envOverrides,
			timeouts: {
				checkTimeoutMs: timeoutMs,
			},
			label: command.label ?? 'mechanical-check',
		};

		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];

		return new Promise<CheckCommandResult>((resolve) => {
			let settled = false;

			function settle(result: {
				exitCode: number | null;
				signal: NodeJS.Signals | null;
				timedOut: boolean;
			}) {
				if (settled) return;
				settled = true;
				const durationMs = Date.now() - startTime;
				resolve(
					Object.freeze({
						command: command.label ?? `${command.file} ${(command.args ?? []).join(' ')}`.trim(),
						file: resolvedExecutableFile,
						args: Object.freeze(fullArgs),
						exitCode: result.exitCode,
						signal: result.signal,
						stdout: stdoutLines.join('\n'),
						stderr: stderrLines.join('\n'),
						timedOut: result.timedOut,
						durationMs,
					}),
				);
			}

			try {
				spawnImpl(spec, {
					platform,
					onLine: (line) => stdoutLines.push(line.text),
					onStderr: (line) => stderrLines.push(line.text),
					onExit: (exitResult: ProcessExitResult) => {
						const isTimeout = exitResult.reason === 'check-timeout';
						settle({
							exitCode: exitResult.exitCode,
							signal: exitResult.signal,
							timedOut: isTimeout,
						});
					},
					onError: (err) => {
						stderrLines.push(`Spawn error: ${err.message}`);
						settle({
							exitCode: 127,
							signal: null,
							timedOut: false,
						});
					},
				});
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				stderrLines.push(`Spawn exception: ${message}`);
				settle({
					exitCode: 127,
					signal: null,
					timedOut: false,
				});
			}
		});
	};
}

/**
 * Runs the two-layer mechanical check (AC 1-4, E-23, E-60, E-61, E-66, E-67).
 *
 * 1. 零配置层恒执行：diff 非空、退出码为 0、会话无致命错误、验收关键词命中。
 * 2. 退出码为 0 但 diff 为空时直接判失败，不派审查 agent，标「无改动」转人（E-61、E-23）。
 * 3. 执行目录恒为该任务的 worktree，绝不在用户主工作区跑（E-67）。
 * 4. 项目命令层留空则跳过并在 UI 明示「机械检查覆盖有限」（E-60）。
 * 5. build/test 命令 10 分钟硬超时后杀掉，标「机械检查超时」转人，不重试（E-66）。
 */
export async function runMechanicalCheck(
	input: MechanicalCheckInput,
	deps: MechanicalCheckDeps = {},
): Promise<MechanicalCheckResult> {
	// 1. Validate worktree directory (AC 3, E-67: 绝不在主工作区跑)
	const worktreePath = await assertWorktreeDirectory(input.worktreePath, input.mainRepoPath);

	// 2. Obtain git diff (M5-T3 integration)
	let diffStat: DiffStatResult;
	let diffText: string;

	const hostInputs = resolveEffectiveHostInputs(deps);
	const effectiveWorktreeDeps: WorktreeManagerDeps = deps.worktreeDeps ?? {
		platform: hostInputs.platform,
		ids: deps.ids ?? { newId: () => Math.random().toString(36).slice(2, 10) },
		spawnManaged: deps.spawnManaged,
	};

	if (input.diffStat) {
		diffStat = input.diffStat;
		diffText = input.diffText ?? '';
	} else {
		diffStat = await getDiffStat(worktreePath, {
			baseRef: input.baseRef,
			runner: deps.gitRunner,
			deps: effectiveWorktreeDeps,
		});
		diffText =
			input.diffText ??
			(await getDiffText(worktreePath, {
				baseRef: input.baseRef,
				runner: deps.gitRunner,
				deps: effectiveWorktreeDeps,
			}));
	}

	const hasChanges = diffStat.hasChanges && diffStat.filesChanged > 0;
	const exitCode = input.exitCode;
	const isExitCodeProvided = typeof exitCode === 'number';
	const isExitCodeZero = isExitCodeProvided && exitCode === 0;

	// R4: exitCode missing, null, or undefined MUST NOT fall back to 0 (E-23)
	if (!isExitCodeProvided) {
		const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
			passed: false,
			diffCheck: Object.freeze({
				passed: hasChanges,
				hasChanges,
				filesChanged: diffStat.filesChanged,
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			}),
			exitCodeCheck: Object.freeze({
				passed: false,
				exitCode: null,
			}),
			sessionErrorCheck: Object.freeze({
				passed: !input.hasFatalError,
				hasFatalError: Boolean(input.hasFatalError),
				errorDetail: input.errorDetail ?? 'Exit code is missing or null',
			}),
			keywordsCheck: Object.freeze({
				passed: true,
				requiredKeywords: Object.freeze([]),
				matchedKeywords: Object.freeze([]),
			}),
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
		});

		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: false,
			executed: false,
			coverageLimited: false,
			commands: Object.freeze([]),
			timedOut: false,
			reason: 'skipped_due_to_missing_exit_code',
		});

		return Object.freeze({
			passed: false,
			targetState: 'awaiting_human',
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			tag: EXIT_CODE_FAILED_TAG,
			canDispatchReviewAgent: false,
			retryable: false,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// E-61, E-23: 退出码为 0 但 diff 为空时机械层直接判失败，不派审查 agent，标「无改动」转人
	if (isExitCodeZero && !hasChanges) {
		const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
			passed: false,
			diffCheck: Object.freeze({
				passed: false,
				hasChanges: false,
				filesChanged: 0,
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			}),
			exitCodeCheck: Object.freeze({
				passed: true,
				exitCode,
			}),
			sessionErrorCheck: Object.freeze({
				passed: !input.hasFatalError,
				hasFatalError: Boolean(input.hasFatalError),
				errorDetail: input.errorDetail,
			}),
			keywordsCheck: Object.freeze({
				passed: false,
				requiredKeywords: Object.freeze([]),
				matchedKeywords: Object.freeze([]),
			}),
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
		});

		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: false,
			executed: false,
			coverageLimited: false,
			commands: Object.freeze([]),
			timedOut: false,
			reason: 'skipped_due_to_empty_diff',
		});

		return Object.freeze({
			passed: false,
			targetState: 'awaiting_human',
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			tag: NO_CHANGES_TAG,
			canDispatchReviewAgent: false,
			retryable: false,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// Non-zero exit code check
	if (!isExitCodeZero) {
		const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
			passed: false,
			diffCheck: Object.freeze({
				passed: hasChanges,
				hasChanges,
				filesChanged: diffStat.filesChanged,
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			}),
			exitCodeCheck: Object.freeze({
				passed: false,
				exitCode,
			}),
			sessionErrorCheck: Object.freeze({
				passed: !input.hasFatalError,
				hasFatalError: Boolean(input.hasFatalError),
				errorDetail: input.errorDetail,
			}),
			keywordsCheck: Object.freeze({
				passed: true,
				requiredKeywords: Object.freeze([]),
				matchedKeywords: Object.freeze([]),
			}),
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
		});

		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: false,
			executed: false,
			coverageLimited: false,
			commands: Object.freeze([]),
			timedOut: false,
			reason: 'skipped_due_to_exit_code',
		});

		return Object.freeze({
			passed: false,
			targetState: 'awaiting_human',
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			tag: EXIT_CODE_FAILED_TAG,
			canDispatchReviewAgent: false,
			retryable: false,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// Session fatal error check (E-23)
	const isSessionFatal =
		Boolean(input.hasFatalError) ||
		input.exitReason === 'spawn-failed' ||
		input.exitReason === 'startup-timeout';

	if (isSessionFatal) {
		const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
			passed: false,
			diffCheck: Object.freeze({
				passed: hasChanges,
				hasChanges,
				filesChanged: diffStat.filesChanged,
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			}),
			exitCodeCheck: Object.freeze({
				passed: isExitCodeZero,
				exitCode,
			}),
			sessionErrorCheck: Object.freeze({
				passed: false,
				hasFatalError: true,
				errorDetail: input.errorDetail ?? input.exitReason,
			}),
			keywordsCheck: Object.freeze({
				passed: true,
				requiredKeywords: Object.freeze([]),
				matchedKeywords: Object.freeze([]),
			}),
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
		});

		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: false,
			executed: false,
			coverageLimited: false,
			commands: Object.freeze([]),
			timedOut: false,
			reason: 'skipped_due_to_session_error',
		});

		return Object.freeze({
			passed: false,
			targetState: 'awaiting_human',
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			tag: SESSION_ERROR_TAG,
			canDispatchReviewAgent: false,
			retryable: false,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// Acceptance criteria keywords hit check (AC 1)
	const requiredKeywords =
		input.acceptanceKeywords && input.acceptanceKeywords.length > 0
			? input.acceptanceKeywords
			: extractAcceptanceKeywords(input.acceptText);

	const changedPaths = diffStat.files.map((f) => f.path);
	const keywordsMatch = matchesAcceptanceKeywords(requiredKeywords, diffText, changedPaths);

	if (requiredKeywords.length > 0 && !keywordsMatch.hit) {
		const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
			passed: false,
			diffCheck: Object.freeze({
				passed: hasChanges,
				hasChanges,
				filesChanged: diffStat.filesChanged,
				insertions: diffStat.insertions,
				deletions: diffStat.deletions,
			}),
			exitCodeCheck: Object.freeze({
				passed: true,
				exitCode,
			}),
			sessionErrorCheck: Object.freeze({
				passed: true,
				hasFatalError: false,
			}),
			keywordsCheck: Object.freeze({
				passed: false,
				requiredKeywords,
				matchedKeywords: Object.freeze([]),
			}),
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
		});

		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: false,
			executed: false,
			coverageLimited: false,
			commands: Object.freeze([]),
			timedOut: false,
			reason: 'skipped_due_to_keywords_missed',
		});

		return Object.freeze({
			passed: false,
			targetState: 'awaiting_human',
			reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			tag: KEYWORDS_MISSED_TAG,
			canDispatchReviewAgent: false,
			retryable: false,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// Zero-config layer has fully passed!
	const zeroConfigLayer: ZeroConfigLayerResult = Object.freeze({
		passed: true,
		diffCheck: Object.freeze({
			passed: true,
			hasChanges: true,
			filesChanged: diffStat.filesChanged,
			insertions: diffStat.insertions,
			deletions: diffStat.deletions,
		}),
		exitCodeCheck: Object.freeze({
			passed: true,
			exitCode,
		}),
		sessionErrorCheck: Object.freeze({
			passed: true,
			hasFatalError: false,
		}),
		keywordsCheck: Object.freeze({
			passed: true,
			requiredKeywords,
			matchedKeywords: keywordsMatch.matched,
		}),
	});

	// 3. Layer 2: Project Command Layer (AC 1, E-60, E-66)
	const rawCommands = input.projectCommands ?? [];
	const normalizedCommands = rawCommands
		.map((cmd) => (typeof cmd === 'string' && cmd.trim().length === 0 ? null : cmd))
		.filter((cmd): cmd is ProjectCheckCommandSpec => cmd !== null);

	// E-60: Project command layer empty -> skip and clearly display '机械检查覆盖有限' in UI
	if (normalizedCommands.length === 0) {
		const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
			passed: true,
			executed: false,
			coverageLimited: true,
			notice: MECHANICAL_COVERAGE_LIMITED_TAG,
			commands: Object.freeze([]),
			timedOut: false,
		});

		return Object.freeze({
			passed: true,
			targetState: 'reviewing',
			reason: 'zero_config_passed_limited_coverage',
			tag: MECHANICAL_COVERAGE_LIMITED_TAG,
			canDispatchReviewAgent: true,
			retryable: true,
			worktreePath,
			zeroConfigLayer,
			projectCommandLayer,
			diffStat,
		});
	}

	// Execute project build/test commands sequentially in worktreePath (E-67)
	const runner = deps.commandRunner ?? createDefaultCommandRunner(deps);
	const executedResults: CheckCommandResult[] = [];
	const defaultTimeoutMs = input.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

	for (const cmdSpec of normalizedCommands) {
		const cmdObj = normalizeCommandSpec(cmdSpec);
		const result = await runner(cmdObj, worktreePath, {
			checkTimeoutMs: cmdObj.timeoutMs ?? defaultTimeoutMs,
		});
		executedResults.push(result);

		// R2: Executable resolution failure (e.g. E_AGENT_EXEC_NOT_FOUND)
		if (result.errorCode) {
			const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
				passed: false,
				executed: true,
				coverageLimited: false,
				commands: Object.freeze(executedResults),
				timedOut: false,
				failedCommand: result.command,
				reason: result.errorCode,
			});

			return Object.freeze({
				passed: false,
				targetState: 'awaiting_human',
				reason: result.errorCode,
				tag:
					result.errorCode === 'E_AGENT_EXEC_NOT_FOUND'
						? COMMAND_NOT_FOUND_TAG
						: COMMAND_FAILED_TAG,
				canDispatchReviewAgent: false,
				retryable: false,
				worktreePath,
				zeroConfigLayer,
				projectCommandLayer,
				diffStat,
			});
		}

		// E-66: Hard timeout reached -> kill, mark '机械检查超时' and transition to human, DO NOT RETRY
		if (result.timedOut) {
			const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
				passed: false,
				executed: true,
				coverageLimited: false,
				commands: Object.freeze(executedResults),
				timedOut: true,
				failedCommand: result.command,
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_TIMEOUT,
			});

			return Object.freeze({
				passed: false,
				targetState: 'awaiting_human',
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_TIMEOUT,
				tag: MECHANICAL_CHECK_TIMEOUT_TAG,
				canDispatchReviewAgent: false,
				retryable: false, // E-66: 不重试
				worktreePath,
				zeroConfigLayer,
				projectCommandLayer,
				diffStat,
			});
		}

		// Non-zero exit code failure
		if (result.exitCode !== 0) {
			const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
				passed: false,
				executed: true,
				coverageLimited: false,
				commands: Object.freeze(executedResults),
				timedOut: false,
				failedCommand: result.command,
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
			});

			return Object.freeze({
				passed: false,
				targetState: 'awaiting_human',
				reason: RUN_TRANSITION_REASONS.MECHANICAL_CHECK_FAILED,
				tag: COMMAND_FAILED_TAG,
				canDispatchReviewAgent: false,
				retryable: false,
				worktreePath,
				zeroConfigLayer,
				projectCommandLayer,
				diffStat,
			});
		}
	}

	// All commands succeeded!
	const projectCommandLayer: ProjectCommandLayerResult = Object.freeze({
		passed: true,
		executed: true,
		coverageLimited: false,
		commands: Object.freeze(executedResults),
		timedOut: false,
	});

	return Object.freeze({
		passed: true,
		targetState: 'reviewing',
		reason: 'mechanical_check_passed',
		tag: MECHANICAL_CHECK_PASSED_TAG,
		canDispatchReviewAgent: true,
		retryable: true,
		worktreePath,
		zeroConfigLayer,
		projectCommandLayer,
		diffStat,
	});
}

/**
 * Creates the ReviewService instance (composition root DI compatible, M7-T1).
 */
export function createReviewService(deps: ReviewServiceDeps = {}): ReviewService {
	const clock = deps.clock ?? { now: () => new Date().toISOString() };
	const ids = deps.ids ?? {
		newId: () => Math.random().toString(36).slice(2, 10),
	};

	async function performCheck(input: MechanicalCheckInput): Promise<MechanicalCheckResult> {
		return runMechanicalCheck(input, deps);
	}

	async function evaluateMechanicalCheck(
		input: EvaluateMechanicalCheckInput,
	): Promise<EvaluateMechanicalCheckResult> {
		let run: ReviewRunRecord | null = null;
		if (deps.runsRepo) {
			run = deps.runsRepo.findById(input.runId);
			if (!run) {
				throw new AppError('E_NOT_FOUND', `Run not found: ${input.runId}`, {
					details: { runId: input.runId },
				});
			}
		}

		const previousState: RunState = run && isValidRunState(run.state) ? run.state : 'exited';
		const worktreePath = input.worktreePath ?? run?.worktree_path ?? run?.worktreePath ?? '';
		// R4: exitCode from input or run; do NOT default to 0!
		const exitCode =
			input.exitCode !== undefined
				? input.exitCode
				: run && 'exitCode' in run
					? (run as { exitCode?: number | null }).exitCode
					: undefined;

		// 1. 机械检查在事务外先执行算结论（08节事务边界，R3）
		const checkResult = await performCheck({
			worktreePath,
			mainRepoPath: input.mainRepoPath,
			exitCode,
			hasFatalError: input.hasFatalError,
			exitReason: input.exitReason,
			acceptText: input.acceptText,
			acceptanceKeywords: input.acceptanceKeywords,
			projectCommands: input.projectCommands,
			baseRef: input.baseRef,
			diffStat: input.diffStat,
			diffText: input.diffText,
			timeoutMs: input.timeoutMs,
		});

		let currentState: RunState = previousState;
		let gateCreated = false;

		// 2. 两次迁移收进同一个 unitOfWork.run，且每次迁移显式传 clock.now()（R3）
		const applyTransitions = () => {
			const now = clock.now();

			if (previousState === 'exited') {
				assertValidTransition('exited', 'reviewing', {
					reason: RUN_TRANSITION_REASONS.PROCESS_EXITED,
				});
				deps.runsRepo?.updateState({
					id: input.runId,
					fromState: 'exited',
					toState: 'reviewing',
					endedAt: now,
				});
				currentState = 'reviewing';

				if (!checkResult.passed) {
					assertValidTransition('reviewing', 'awaiting_human', {
						reason: checkResult.reason,
					});
					deps.runsRepo?.updateState({
						id: input.runId,
						fromState: 'reviewing',
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: checkResult.reason,
					});
					currentState = 'awaiting_human';

					if (deps.gatesRepo) {
						deps.gatesRepo.insert({
							id: `gate_${ids.newId()}`,
							taskId: input.taskId ?? run?.task_id ?? run?.taskId ?? '',
							runId: input.runId,
							kind: 'review',
							state: 'waiting',
							comment: checkResult.tag,
							createdAt: now,
						});
						gateCreated = true;
					}
				}
			} else if (previousState === 'reviewing') {
				if (!checkResult.passed) {
					assertValidTransition('reviewing', 'awaiting_human', {
						reason: checkResult.reason,
					});
					deps.runsRepo?.updateState({
						id: input.runId,
						fromState: 'reviewing',
						toState: 'awaiting_human',
						endedAt: now,
						queuedReason: checkResult.reason,
					});
					currentState = 'awaiting_human';

					if (deps.gatesRepo) {
						deps.gatesRepo.insert({
							id: `gate_${ids.newId()}`,
							taskId: input.taskId ?? run?.task_id ?? run?.taskId ?? '',
							runId: input.runId,
							kind: 'review',
							state: 'waiting',
							comment: checkResult.tag,
							createdAt: now,
						});
						gateCreated = true;
					}
				}
			}
		};

		if (deps.runsRepo) {
			if (deps.unitOfWork) {
				deps.unitOfWork.run(() => {
					applyTransitions();
				});
			} else {
				applyTransitions();
			}
		}

		return Object.freeze({
			result: checkResult,
			previousState,
			currentState,
			gateCreated,
		});
	}

	return Object.freeze({
		runMechanicalCheck: performCheck,
		async startReviewRound(input: StartReviewRoundInput): Promise<string> {
			const { taskId, reworkItems, isBugHuntFix } = input;

			if (!deps.runsRepo) throw new Error('runsRepo missing');

			const findLatestReview = deps.runsRepo.findLatestReview;
			const insertRun = deps.runsRepo.insert;
			const updateReviewRound = deps.runsRepo.updateReviewRound;
			if (!findLatestReview || !insertRun || !updateReviewRound) {
				throw new Error('runsRepo missing review-round methods');
			}

			const prevReview = findLatestReview(taskId);
			if (!prevReview) {
				throw new AppError('E_VALIDATION', 'No previous review run found for task');
			}
			// AC 4 / E-302：目标会话已归档，先拒绝。
			if (prevReview.session_archived_at) {
				throw new AppError('E_SESSION_ARCHIVED', 'Session archived');
			}
			// AC 1 / 决策 89：续接目标必须是同一任务的 review 行。
			if (prevReview.task_id !== taskId || prevReview.kind !== 'review') {
				throw new AppError(
					'E_VALIDATION',
					'continued_from_run_id must point to a review run of the same task',
				);
			}

			// AC 1：parent_run_id 指向被审的实施运行（M7-T5 新开的返工运行之后就不再是第 N 轮那一条）；
			// AC 5：review_round = rework_count + 1 写死，rework_count 来自实施运行行。
			const implRun = deps.runsRepo.findById(input.implRunId);
			if (implRun && (implRun.task_id ?? implRun.taskId ?? taskId) !== taskId) {
				throw new AppError('E_VALIDATION', 'implRunId must belong to the same task', {
					details: { taskId, implRunId: input.implRunId },
				});
			}
			const parentRunId = implRun ? implRun.id : prevReview.parent_run_id;
			const implReworkCount = implRun
				? (implRun.rework_count ?? implRun.reworkCount ?? null)
				: null;
			// AC 6：拿不到实施行计数时（老库 / 假仓储）退回「上一轮 + 1」，旧行 review_round 为 NULL 读作 1、不回填。
			const reviewRound =
				implReworkCount !== null ? implReworkCount + 1 : (prevReview.review_round ?? 1) + 1;
			// `UNIQUE (task_id, attempt_no)`：新一轮是同任务的新一次尝试，不能照抄上一轮的 attempt_no。
			const nextAttemptNo = deps.runsRepo.listByTaskId
				? Math.max(0, ...deps.runsRepo.listByTaskId(taskId).map((row) => row.attempt_no)) + 1
				: prevReview.attempt_no + 1;

			const nextId = () => (deps.ids?.newId ?? (() => Math.random().toString(36).slice(2, 10)))();
			const promptPrefix = assembleReviewRoundPrompt({
				round: reviewRound,
				previousReviewRunId: prevReview.id,
				reworkItems,
				isBugHuntFix,
			});
			const startedAt = clock.now();

			const insertRoundRow = (runId: string, vendorSessionRef: string | null) => {
				const row: RunInsertRow = {
					id: runId,
					task_id: taskId,
					attempt_no: nextAttemptNo,
					kind: 'review',
					parent_run_id: parentRunId,
					state: 'starting',
					agent_id: prevReview.agent_id,
					model_name: prevReview.model_name,
					effort_tier: prevReview.effort_tier,
					effort_vendor: prevReview.effort_vendor,
					permission_tier: 'readOnly',
					snapshot_id: prevReview.snapshot_id,
					worktree_path: prevReview.worktree_path,
					branch_name: prevReview.branch_name,
					vendor_session_ref: vendorSessionRef,
					lane_no: prevReview.lane_no,
					review_round: reviewRound,
					continued_from_run_id: prevReview.id,
					started_at: startedAt,
				};
				insertRun(row);
			};

			// 08 节：写入收在一次事务里，spawn / 投递 / publish 都在事务返回之后。
			const persistRound = (runId: string, vendorSessionRef: string | null) => {
				if (deps.unitOfWork) {
					deps.unitOfWork.run(() => insertRoundRow(runId, vendorSessionRef));
				} else {
					insertRoundRow(runId, vendorSessionRef);
				}
			};

			const publishStarted = (runId: string) => {
				if (!deps.bus || !deps.envelopeFactory) return;
				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'run.started',
						runId,
						taskId,
						payload: {
							runId,
							taskId,
							attemptNo: nextAttemptNo,
							kind: 'review',
							agentId: prevReview.agent_id,
							model: prevReview.model_name,
							effortTier: prevReview.effort_tier,
							parentRunId,
							isPartialDiff: false,
						},
					}),
				);
			};

			// AC 2 的 new_session 分支：独立新会话，vendor_session_ref 为空，提示词头部自带轮次与 R 条目。
			const spawnNewSession = (runId: string, prompt: string) => {
				const spawn = deps.spawnManagedFn ?? deps.spawnManaged;
				if (!spawn) return;
				const assignment: ReviewAgentAssignment = {
					agentId: prevReview.agent_id,
					modelName: prevReview.model_name,
					effortTier: prevReview.effort_tier as EffortTier | null,
					...(prevReview.effort_vendor ? { effortVendor: prevReview.effort_vendor } : {}),
				};
				const launchSpec = buildReviewLaunchSpec({
					runId,
					taskId,
					worktreePath: prevReview.worktree_path ?? '',
					assignment,
					prompt,
				});
				const hostResult = takePlatformHostInputs({});
				const platform = deps.platform ?? (hostResult.ok ? hostResult.value.platform : 'win32');
				deps.processRegistry?.register(spawn(launchSpec, { platform }));
			};

			// AC 2：按能力位选路，不试了再降级。
			const caps = deps.messageService?.getCapabilities(prevReview.agent_id);
			const processAlive = deps.processRegistry?.has(prevReview.id) ?? false;
			const canReply = processAlive && (caps?.canReply ?? false);
			const canResume =
				!processAlive && (caps?.canResume ?? false) && Boolean(prevReview.vendor_session_ref);

			if (!canReply && !canResume) {
				const newRunId = nextId();
				persistRound(newRunId, null);
				spawnNewSession(newRunId, promptPrefix);
				publishStarted(newRunId);
				return newRunId;
			}

			const runId = nextId();
			let exhausted = false;
			if (canReply) {
				persistRound(runId, prevReview.vendor_session_ref ?? null);
				deps.processRegistry?.reassign(prevReview.id, runId);
				publishStarted(runId);
				const delivered = await deps.messageService?.deliverMessage({
					runId,
					text: promptPrefix,
					kind: 'reply',
				});
				if (delivered?.delivered === true && deps.bus) {
					// E-330：投递后、该轮首条内容事件前出现失败类事件 → 判撑爆，只降级一次。
					exhausted =
						(await waitForContinuationState(deps.bus, runId, CONTINUATION_TIMEOUT_MS)) ===
						'exhausted';
				} else if (delivered?.delivered !== true) {
					exhausted = true;
				}
			} else {
				persistRound(runId, prevReview.vendor_session_ref ?? null);
				publishStarted(runId);
				if (deps.resumeSession) {
					const resumed = await deps.resumeSession({
						runId,
						taskId,
						agentId: prevReview.agent_id,
						text: promptPrefix,
						kind: 'reply',
					});
					if (resumed.delivered && deps.bus) {
						exhausted =
							(await waitForContinuationState(
								deps.bus,
								resumed.newRunId,
								CONTINUATION_TIMEOUT_MS,
							)) === 'exhausted';
					} else if (!resumed.delivered) {
						exhausted = true;
					}
				} else {
					exhausted = true;
				}
			}

			if (!exhausted) return runId;

			// E-330：降级恰一次——恢复分支的失败行标 failed + continuation_exhausted，不计入 review_round，
			// 并把它的续接指针清掉：`ux_runs_continued` 只允许一行指向第 N 轮，那一行必须是新开的会话。
			const fallbackRunId = nextId();
			const persistFallback = () => {
				deps.runsRepo?.updateState({
					id: runId,
					fromState: 'starting',
					toState: 'failed',
					endedAt: clock.now(),
					queuedReason: 'continuation_exhausted',
				});
				updateReviewRound(runId, null, null);
				insertRoundRow(fallbackRunId, null);
			};
			if (deps.unitOfWork) {
				deps.unitOfWork.run(persistFallback);
			} else {
				persistFallback();
			}
			spawnNewSession(fallbackRunId, promptPrefix);
			publishStarted(fallbackRunId);

			// E-330 末句：新开的会话再次在内容前失败 → 不再新开，转人并在闸门 comment 写 review_continuation_failed。
			// 观察在事务外异步进行，函数本身立即返回新行 id。
			if (deps.bus) {
				const bus = deps.bus;
				void waitForContinuationState(bus, fallbackRunId, CONTINUATION_TIMEOUT_MS)
					.then((state) => {
						if (state !== 'exhausted') return;
						handOverContinuationFailure(fallbackRunId, parentRunId ?? null);
					})
					.catch(() => undefined);
			}
			return fallbackRunId;

			function handOverContinuationFailure(
				failedReviewRunId: string,
				implRunId: string | null,
			): void {
				const now = clock.now();
				const implRow = implRunId ? deps.runsRepo?.findById(implRunId) : null;
				const pendingEnvelopes: EventEnvelope[] = [];
				const persist = () => {
					deps.runsRepo?.updateState({
						id: failedReviewRunId,
						fromState: 'starting',
						toState: 'failed',
						endedAt: now,
						queuedReason: REVIEW_CONTINUATION_FAILED,
					});
					if (implRow && implRow.state === 'reviewing') {
						assertValidTransition('reviewing', 'awaiting_human', {
							reason: REVIEW_CONTINUATION_FAILED,
						});
						deps.runsRepo?.updateState({
							id: implRow.id,
							fromState: 'reviewing',
							toState: 'awaiting_human',
							endedAt: now,
							queuedReason: REVIEW_CONTINUATION_FAILED,
						});
						if (deps.envelopeFactory) {
							pendingEnvelopes.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'run.state_changed',
									runId: implRow.id,
									taskId,
									payload: {
										from: 'reviewing',
										to: 'awaiting_human',
										reason: REVIEW_CONTINUATION_FAILED,
									},
								}),
							);
						}
					}
					if (deps.gatesRepo) {
						deps.gatesRepo.insert({
							id: `gate_${ids.newId()}`,
							taskId,
							runId: implRow?.id ?? failedReviewRunId,
							kind: 'review',
							state: 'waiting',
							comment: REVIEW_CONTINUATION_FAILED,
							createdAt: now,
						});
						if (deps.envelopeFactory) {
							pendingEnvelopes.push(
								deps.envelopeFactory.createEnvelope({
									kind: 'task.gate_waiting',
									runId: implRow?.id ?? failedReviewRunId,
									taskId,
									payload: { gate: 'review', comment: REVIEW_CONTINUATION_FAILED },
								}),
							);
						}
					}
				};
				if (deps.unitOfWork) {
					deps.unitOfWork.run(persist);
				} else {
					persist();
				}
				for (const envelope of pendingEnvelopes) {
					deps.bus?.publish(envelope);
				}
			}
		},

		evaluateMechanicalCheck,

		async finalizeReviewRun(input: FinalizeReviewRunInput): Promise<FinalizeReviewRunResult> {
			if (!deps.runsRepo) throw new Error('runsRepo missing');

			const reviewRun = deps.runsRepo.findById(input.reviewRunId);
			if (!reviewRun) {
				throw new AppError('E_NOT_FOUND', `Review run not found: ${input.reviewRunId}`);
			}
			const implRunId = reviewRun.parent_run_id ?? reviewRun.id;
			const implRun = deps.runsRepo.findById(implRunId);
			if (!implRun) {
				throw new AppError('E_NOT_FOUND', `Implementation run not found: ${implRunId}`);
			}
			const taskId =
				implRun.task_id ?? reviewRun.task_id ?? implRun.taskId ?? reviewRun.taskId ?? '';

			if (input.verdict === 'pass') {
				// AC 1: finalizeReviewRun() 判 pass 后读 settings.pipeline.bughunt（每次读库、不缓存、不进快照）
				let bughuntEnabled = false;
				if (deps.settingsService) {
					const pipeline = deps.settingsService.getPipeline();
					bughuntEnabled = pipeline.bughunt === 1;
				} else if (deps.settingsRepo) {
					const row = deps.settingsRepo.get('pipeline');
					if (row) {
						try {
							const parsed = JSON.parse(row.value_json);
							bughuntEnabled = parsed.bughunt === 1;
						} catch {
							bughuntEnabled = false;
						}
					}
				}

				// 为 1 且该实施运行尚无 bughunt 行 → 事务内插入 kind='bughunt' 行，实施行保持 reviewing
				const existingBughunt = deps.runsRepo.findByParentRunIdAndKind
					? deps.runsRepo.findByParentRunIdAndKind(implRun.id, 'bughunt')
					: null;

				if (bughuntEnabled && !existingBughunt && deps.bughuntService) {
					const dispatchResult = await deps.bughuntService.dispatchBughunt({
						implRunId: implRun.id,
						actorDeviceId: input.actorDeviceId,
					});
					if (dispatchResult.action === 'dispatched') {
						return {
							action: 'bughunt_dispatched',
							bughuntRunId: dispatchResult.bughuntRun?.id,
						};
					}
					if (dispatchResult.action === 'agent_unavailable') {
						return {
							action: 'awaiting_human',
							gateId: dispatchResult.gateId,
						};
					}
				}

				// 为 0 或已有 bughunt 行 → 走既有落地闸门
				if (deps.gatesService) {
					await deps.gatesService.resolveAfterReviewAndApply({
						taskId,
						runId: implRun.id,
						reviewVerdict: 'pass',
					});
					return { action: 'landing_gate' };
				}

				return { action: 'landing_gate' };
			}

			return {
				action:
					input.verdict === 'rework'
						? 'rework'
						: input.verdict === 'doc_issue'
							? 'doc_issue'
							: 'awaiting_human',
			};
		},
	});
}
