import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RefreshDocumentResponse } from '@agent-scheduler/shared/api/documents';
import type { TaskDto } from '@agent-scheduler/shared/api/tasks';
import type { DatabaseConnection } from '../db/open-database.ts';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { type DocsFingerprintHasher, computeDocsFingerprint } from '../domain/docs-fingerprint.ts';
import { batchNoOf, layerOf } from '../domain/layer-of.ts';
import { deriveTaskState, isTaskState } from '../domain/task-state.ts';
import {
	BUILTIN_WRAPUP_PROMPT,
	PROMPT_SOURCE_BUILTIN,
	PROMPT_SOURCE_DOCS,
	type WrapupPromptSource,
} from '../domain/wrapup-builtin-prompt.ts';
import { AppError } from '../errors/app-error.ts';
import type { EventBus } from '../events/bus.ts';
import type { EnvelopeFactory } from '../events/envelope.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import { type OpenBrowserFn, createOpenBrowser } from '../proc/open-browser.ts';
import { type BatchesRepo, createBatchesRepo } from '../repo/batches.ts';
import {
	type DispatchSnapshotsRepo,
	createDispatchSnapshotsRepo,
} from '../repo/dispatch-snapshots.ts';
import type { DocumentMetadataUpdateRow, DocumentRow, DocumentsRepo } from '../repo/documents.ts';
import {
	type DependencyValidationReport,
	type TaskRow,
	type TasksRepo,
	createTasksRepo,
	importDocTasks,
} from '../repo/tasks.ts';

export interface ParsedDocTask {
	readonly id: string;
	readonly title: string;
	readonly module: string;
	readonly deps: readonly string[];
	readonly input: string | null;
	readonly output: string | null;
	readonly accept: string;
	readonly estDays: number | null;
	readonly edgeIds: readonly string[];
	readonly contractHash: string;
	readonly isContractReady: boolean;
	readonly contractReasons: readonly string[];
	readonly taskPaths: readonly string[];
	readonly implPrompt: string;
	readonly reviewPrompt: string;
	readonly bugPrompt: string | null;
	readonly resumePrompt: string | null;
	readonly layer: number;
	readonly batchNo: number;
}

export interface ParsedDispatchBatch {
	readonly batchNo?: number;
	readonly tasks: readonly string[];
	readonly contractHash?: string | null;
	readonly wrapup: string;
}

export interface ParsedDocData {
	readonly schemaVersion: number;
	readonly projectName: string;
	readonly repoPath: string | null;
	readonly mainBranch: string;
	readonly branchPrefix: string;
	readonly contentFingerprint: string;
	readonly tasks: readonly ParsedDocTask[];
	readonly taskMap: ReadonlyMap<string, ParsedDocTask>;
	readonly dispatchBatches?: readonly ParsedDispatchBatch[];
}

export interface WrapupContext {
	readonly batchId: string;
	readonly batchNo: number;
	readonly wrapup: string;
	readonly wrapupPrompt: string;
	readonly promptSource: WrapupPromptSource;
	readonly tasks: readonly string[];
	readonly contractHash: string | null;
	readonly isSnapshot: true;
	readonly isReadOnly: true;
	readonly docChangedSinceDispatch: boolean;
}

export interface GetWrapupContextOptions {
	readonly database?: DatabaseConnection;
	readonly batchesRepo?: BatchesRepo;
	readonly tasksRepo?: TasksRepo;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly documentsRepo?: DocumentsRepo;
}

export interface DocumentRecord {
	readonly id: string;
	readonly docsPath: string;
	readonly projectName: string;
	readonly repoPath: string | null;
	readonly mainBranch: string;
	readonly branchPrefix: string;
	readonly laneCount: number;
	readonly contentFingerprint: string;
	readonly isSourceReadable: boolean;
	readonly isTakeoverNotified: boolean;
	readonly importedAt: string;
	readonly lastSeenAt: string;
}

export interface DocsFileSystem {
	readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface DocsServiceDeps {
	readonly documentsRepo: DocumentsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly fs?: DocsFileSystem;
	readonly hasher?: DocsFingerprintHasher;
	readonly bus?: EventBus;
	readonly envelopeFactory?: EnvelopeFactory;
	readonly openBrowser?: OpenBrowserFn;
	readonly hostInputs?: PlatformHostInputs;
	readonly fileExists?: (path: string) => Promise<boolean> | boolean;
	readonly batchesRepo?: BatchesRepo;
	readonly tasksRepo?: TasksRepo;
	readonly dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
	readonly db?: DatabaseConnection;
	/** 任务与批次落库走一次事务（08 节：只有 service 层能开事务）；缺省时逐条执行。 */
	readonly unitOfWork?: UnitOfWork;
}

export interface ImportDocumentResult {
	readonly document: DocumentRecord;
	readonly parsed: ParsedDocData;
	readonly hasChanged: boolean;
	readonly isNew: boolean;
	/** 任务与批次是否已写进 tasks / batches 表（容器注入了 db 或两个 repo 时恒为 true）。 */
	readonly tasksImported: boolean;
	/** M3-T2 导入报告：幽灵依赖与成环任务，阻断自动批次派发（E-20、E-241、E-242）。 */
	readonly dependencyReport: DependencyValidationReport | null;
}

export interface OpenReaderResult {
	readonly opened: true;
	readonly readerPath: string;
}

export interface ListTasksQuery {
	readonly batchId?: string;
	readonly state?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface ListTasksResult {
	readonly tasks: readonly TaskDto[];
	readonly nextCursor: string | null;
}

export interface DocsService {
	readonly parseContent: (content: string, options?: { docsPath?: string }) => ParsedDocData;
	readonly parseFile: (filePath: string) => Promise<ParsedDocData>;
	readonly importDocument: (docsPath: string) => Promise<ImportDocumentResult>;
	readonly refreshDocument: (docId: string) => Promise<RefreshDocumentResponse>;
	readonly listTasks: (docId: string, query?: ListTasksQuery) => Promise<ListTasksResult>;
	readonly getDocumentById: (id: string) => DocumentRecord | null;
	readonly getDocumentByPath: (docsPath: string) => DocumentRecord | null;
	readonly listDocuments: () => readonly DocumentRecord[];
	readonly updateLaneCount: (id: string, laneCount: number) => void;
	readonly markSourceUnreadable: (id: string) => void;
	readonly setTakeoverNotified: (id: string, isTakeoverNotified: boolean) => void;
	readonly openReader: (id: string) => Promise<OpenReaderResult>;
	readonly getWrapupContext: (batchId: string, options?: GetWrapupContextOptions) => WrapupContext;
}

const DEFAULT_FS: DocsFileSystem = Object.freeze({
	async readFile(path: string, encoding: 'utf8'): Promise<string> {
		return nodeFs.readFile(path, encoding);
	},
});

interface CachedDocHistoryEntry {
	readonly fingerprint: string;
	readonly dispatchBatches: readonly ParsedDispatchBatch[];
	readonly taskContractHashes: ReadonlyMap<string, string>;
}

/**
 * 集合相等匹配（AC 1, E-296）。
 * 按「tasks 集合与本批当前任务集合相等」匹配（顺序无关，多一个少一个都不匹配）。
 * 不按层号匹配。
 */
export function matchBatchByTasksSet(
	dispatchBatches: readonly ParsedDispatchBatch[] | undefined,
	currentTasks: readonly string[],
): ParsedDispatchBatch | null {
	if (!dispatchBatches || dispatchBatches.length === 0) {
		return null;
	}
	const currentSet = new Set(currentTasks);
	for (const entry of dispatchBatches) {
		if (entry.tasks.length !== currentTasks.length) {
			continue;
		}
		const entrySet = new Set(entry.tasks);
		if (entrySet.size !== currentSet.size) {
			continue;
		}
		let isMatch = true;
		for (const t of currentSet) {
			if (!entrySet.has(t)) {
				isMatch = false;
				break;
			}
		}
		if (isMatch) {
			return entry;
		}
	}
	return null;
}

export function defaultSha256Hasher(payload: string): string {
	return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function mapDocumentRow(row: DocumentRow): DocumentRecord {
	return Object.freeze({
		id: row.id,
		docsPath: row.docs_path,
		projectName: row.project_name,
		repoPath: row.repo_path,
		mainBranch: row.main_branch,
		branchPrefix: row.branch_prefix,
		laneCount: row.lane_count,
		contentFingerprint: row.content_fingerprint,
		isSourceReadable: row.is_source_readable === 1,
		isTakeoverNotified: row.is_takeover_notified === 1,
		importedAt: row.imported_at,
		lastSeenAt: row.last_seen_at,
	});
}

function toTaskDto(row: TaskRow & { derived_state?: string }): TaskDto {
	let deps: readonly string[];
	try {
		const parsed = JSON.parse(row.deps_json);
		deps = Array.isArray(parsed) ? parsed : [];
	} catch {
		deps = [];
	}
	const state = row.derived_state ?? deriveTaskState(row.manual_state, null);
	return Object.freeze({
		id: row.id,
		docId: row.doc_id,
		taskKey: row.task_key,
		title: row.title,
		moduleKey: row.module_key,
		deps: Object.freeze(deps),
		estDays: row.est_days,
		batchId: row.batch_id,
		state,
		hasAcceptChanged: row.has_accept_changed === 1,
		hasPromptChanged: row.has_prompt_changed === 1,
		isRemovedFromDoc: row.is_removed_from_doc === 1,
	});
}

function assertValidEffectivePath(
	taskId: string,
	path: unknown,
	docsPath?: string,
): asserts path is string {
	const globCharacters = ['*', '?', '[', ']', '{', '}'] as const;
	const segments =
		typeof path === 'string' ? path.replace(/\/+$/, '').split('/') : ([] as string[]);
	const isValid =
		typeof path === 'string' &&
		path.length > 0 &&
		path === path.trim() &&
		!path.includes('\\') &&
		!path.includes('\0') &&
		!path.startsWith('/') &&
		!/^[a-zA-Z]:/.test(path) &&
		!segments.some((segment) => segment === '' || segment === '.' || segment === '..') &&
		!globCharacters.some((character) => path.includes(character));

	if (!isValid) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			`Task ${taskId} has invalid effectivePath: ${String(path)}`,
			{ details: { docsPath, taskId, path } },
		);
	}
}

/**
 * 强制按 UTF-8 读取 docs-data.js，剥离固定外壳后 JSON.parse，
 * 严格校验 schemaVersion=1、唯一任务 ID、三处非空哈希一致、ready/reasons 形状与 1.1.0 路径规则（E-16、E-17、E-82、E-246）。
 */
export function parseDocsDataContent(
	content: string,
	options: { docsPath?: string; hasher?: DocsFingerprintHasher } = {},
): ParsedDocData {
	let text = content;
	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}
	text = text.trim();

	if (!/^window\.DOCS\s*=\s*/.test(text)) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			'Invalid docs-data.js format: missing window.DOCS assignment prefix',
			{ details: { docsPath: options.docsPath } },
		);
	}

	const jsonPayload = text.replace(/^window\.DOCS\s*=\s*/, '').replace(/;?\s*$/, '');
	let parsedRaw: unknown;
	try {
		parsedRaw = JSON.parse(jsonPayload);
	} catch (cause) {
		throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Failed to parse JSON in docs-data.js', {
			cause,
			details: { docsPath: options.docsPath },
		});
	}

	if (typeof parsedRaw !== 'object' || parsedRaw === null) {
		throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Payload in docs-data.js must be a JSON object', {
			details: { docsPath: options.docsPath },
		});
	}

	const doc = parsedRaw as Record<string, unknown>;

	if (doc.schemaVersion !== 1) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			`Unsupported schemaVersion in docs-data.js: ${String(doc.schemaVersion)}; expected 1`,
			{ details: { docsPath: options.docsPath, schemaVersion: doc.schemaVersion } },
		);
	}

	if (typeof doc.project !== 'string' || doc.project.trim().length === 0) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			'Missing or invalid project name in docs-data.js',
			{ details: { docsPath: options.docsPath } },
		);
	}

	const data = doc.data as Record<string, unknown> | undefined;
	const tasksRaw = data?.tasks;
	if (!Array.isArray(tasksRaw)) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			'Missing or invalid data.tasks array in docs-data.js',
			{ details: { docsPath: options.docsPath } },
		);
	}

	const dispatch = doc.dispatch as Record<string, unknown> | undefined;
	if (typeof dispatch !== 'object' || dispatch === null) {
		throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Missing dispatch section in docs-data.js', {
			details: { docsPath: options.docsPath },
		});
	}

	const handoff = doc.handoff as Record<string, unknown> | undefined;
	if (typeof handoff !== 'object' || handoff === null) {
		throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Missing handoff section in docs-data.js', {
			details: { docsPath: options.docsPath },
		});
	}

	const contracts = handoff.contracts as Record<string, unknown> | undefined;
	const readiness = handoff.readiness as Record<string, unknown> | undefined;
	const effectivePaths = handoff.effectivePaths as Record<string, unknown> | undefined;

	if (
		typeof contracts !== 'object' ||
		contracts === null ||
		typeof readiness !== 'object' ||
		readiness === null ||
		typeof effectivePaths !== 'object' ||
		effectivePaths === null
	) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			'Missing required handoff sub-sections (contracts, readiness, effectivePaths) in docs-data.js',
			{ details: { docsPath: options.docsPath } },
		);
	}

	const taskIds: string[] = [];
	const seenTaskIds = new Set<string>();
	const depsLookup: Record<string, readonly string[]> = {};

	for (const t of tasksRaw) {
		if (typeof t !== 'object' || t === null) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Invalid task entry in data.tasks', {
				details: { docsPath: options.docsPath },
			});
		}

		const taskObj = t as Record<string, unknown>;
		const taskId = taskObj.id;
		if (typeof taskId !== 'string' || taskId.trim().length === 0) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Task in data.tasks has missing or empty id', {
				details: { docsPath: options.docsPath },
			});
		}

		// 任务 ID 是所有任务包映射的连接键，重复值会使后项覆盖前项。
		if (seenTaskIds.has(taskId)) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', `Duplicate task id in data.tasks: ${taskId}`, {
				details: { docsPath: options.docsPath, taskId },
			});
		}
		seenTaskIds.add(taskId);
		taskIds.push(taskId);

		// 这些字段决定展示、分层和验收，不能把损坏值静默降级为空值。
		if (typeof taskObj.title !== 'string' || taskObj.title.trim().length === 0) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} has missing or empty title in data.tasks`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		if (typeof taskObj.module !== 'string' || taskObj.module.trim().length === 0) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} has missing or empty module in data.tasks`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		if (
			!Array.isArray(taskObj.deps) ||
			!taskObj.deps.every((d): d is string => typeof d === 'string')
		) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} has invalid deps; must be array of strings`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		if (typeof taskObj.accept !== 'string' || taskObj.accept.trim().length === 0) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} has missing or empty accept criteria in data.tasks`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		depsLookup[taskId] = taskObj.deps;
	}

	// 核对 dispatch 任务集合与 data.tasks 一致
	const dispatchKeys = Object.keys(dispatch);
	if (dispatchKeys.length !== taskIds.length) {
		throw new AppError(
			'E_DOC_SOURCE_UNREADABLE',
			`Task count mismatch between dispatch (${dispatchKeys.length}) and data.tasks (${taskIds.length})`,
			{ details: { docsPath: options.docsPath } },
		);
	}

	const parsedTasks: ParsedDocTask[] = [];
	const fingerprintItems: { id: string; contractHash: string }[] = [];

	// 按依赖拓扑分层算出批次（E-246）
	const layers = layerOf(taskIds, depsLookup);

	for (const t of tasksRaw as Record<string, unknown>[]) {
		const taskId = t.id as string;
		const title = t.title as string;
		const moduleKey = t.module as string;
		const deps = depsLookup[taskId] ?? [];
		const input = typeof t.input === 'string' ? t.input : null;
		const output = typeof t.output === 'string' ? t.output : null;
		const accept = t.accept as string;
		const estDays =
			typeof t.est === 'number' && Number.isFinite(t.est) && t.est >= 0 ? t.est : null;
		const edgeIds = Array.isArray(t.edges)
			? Object.freeze(t.edges.filter((e): e is string => typeof e === 'string'))
			: Object.freeze([]);

		const dispatchItem = dispatch[taskId] as Record<string, unknown> | undefined;
		if (!dispatchItem || typeof dispatchItem !== 'object') {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing dispatch package for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		const contractItem = contracts[taskId] as Record<string, unknown> | undefined;
		if (!contractItem || typeof contractItem !== 'object') {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing handoff contract for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		const readinessItem = readiness[taskId] as Record<string, unknown> | undefined;
		if (!readinessItem || typeof readinessItem !== 'object') {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing handoff readiness for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		// 有效路径直接参与工作区范围和冲突判断，必须与 1.1.0 生产者使用同一规则。
		const taskPathsRaw = effectivePaths[taskId];
		if (!Array.isArray(taskPathsRaw) || taskPathsRaw.length === 0) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing or empty effectivePaths for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}
		for (const p of taskPathsRaw) {
			assertValidEffectivePath(taskId, p, options.docsPath);
		}

		// 三处非空契约哈希必须逐字一致（E-17）。
		const dispatchHash = dispatchItem.contractHash;
		const contractsHash = contractItem.hash;
		const readinessHash = readinessItem.contractHash;

		if (
			typeof dispatchHash !== 'string' ||
			dispatchHash.trim().length === 0 ||
			typeof contractsHash !== 'string' ||
			contractsHash.trim().length === 0 ||
			typeof readinessHash !== 'string' ||
			readinessHash.trim().length === 0 ||
			dispatchHash !== contractsHash ||
			dispatchHash !== readinessHash
		) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Contract hash missing or mismatch for task ${taskId}: dispatch=${String(dispatchHash)}, contracts=${String(contractsHash)}, readiness=${String(readinessHash)}`,
				{
					details: {
						docsPath: options.docsPath,
						taskId,
						dispatchContractHash: dispatchHash,
						contractsHash,
						readinessContractHash: readinessHash,
					},
				},
			);
		}

		// 提示词必须是非空字符串
		const implPrompt = dispatchItem.implementation;
		const reviewPrompt = dispatchItem.review;
		if (
			typeof implPrompt !== 'string' ||
			implPrompt.trim().length === 0 ||
			typeof reviewPrompt !== 'string' ||
			reviewPrompt.trim().length === 0
		) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing or empty prompts in dispatch for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		// ready/reasons 控制新派发，损坏值不能被当作待复核的合法任务。
		if (typeof readinessItem.ready !== 'boolean') {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} readiness.ready must be boolean`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		if (
			!Array.isArray(readinessItem.reasons) ||
			!readinessItem.reasons.every((r): r is string => typeof r === 'string')
		) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Task ${taskId} readiness.reasons must be array of strings`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		const resumePrompt = typeof dispatchItem.resume === 'string' ? dispatchItem.resume : null;
		// 查 bug 提示词：缺失或不是字符串存 NULL，不冻结派发、不报 E_DOC_SOURCE_UNREADABLE（AC 1、E-19、E-316）
		const bugPrompt = typeof dispatchItem.bug === 'string' ? dispatchItem.bug : null;
		const isContractReady = readinessItem.ready;
		const contractReasons = Object.freeze([...readinessItem.reasons]);

		const layer = layers[taskId] ?? 0;
		const batchNo = batchNoOf(layer);

		parsedTasks.push(
			Object.freeze({
				id: taskId,
				title,
				module: moduleKey,
				deps: Object.freeze([...deps]),
				input,
				output,
				accept,
				estDays,
				edgeIds,
				contractHash: dispatchHash,
				isContractReady,
				contractReasons,
				taskPaths: Object.freeze([...taskPathsRaw]),
				implPrompt,
				reviewPrompt,
				bugPrompt,
				resumePrompt,
				layer,
				batchNo,
			}),
		);

		fingerprintItems.push({ id: taskId, contractHash: dispatchHash });
	}

	// 加密实现属于 service 的外部能力；domain 只规范化输入。
	const hasher = options.hasher ?? defaultSha256Hasher;
	const contentFingerprint = computeDocsFingerprint(fingerprintItems, hasher);

	const pres = doc.pres as Record<string, unknown> | undefined;
	const presHandoff = pres?.handoff as Record<string, unknown> | undefined;
	const repoPath = typeof presHandoff?.repo === 'string' ? presHandoff.repo : null;
	const mainBranch = typeof presHandoff?.mainBranch === 'string' ? presHandoff.mainBranch : 'main';
	const branchPrefix =
		typeof presHandoff?.branchPrefix === 'string' ? presHandoff.branchPrefix : 'task/';

	const taskMap = new Map(parsedTasks.map((t) => [t.id, t]));

	// 解析 dispatchBatches（04 节，AC 1、AC 2、E-296）。
	// 格式形如 dispatchBatches["<层号>"] = { batchNo, tasks, contractHash, wrapup }
	// 键缺失或不是对象时不报错，由下游收口逻辑回落到 builtin（AC 2）。
	// 严格执行决策 73：明令不读取 doc.batchRecords 键。
	const parsedDispatchBatches: ParsedDispatchBatch[] = [];
	const dispatchBatchesRaw = doc.dispatchBatches;
	if (typeof dispatchBatchesRaw === 'object' && dispatchBatchesRaw !== null) {
		const rawEntries = Array.isArray(dispatchBatchesRaw)
			? dispatchBatchesRaw
			: Object.values(dispatchBatchesRaw);
		for (const entry of rawEntries) {
			if (typeof entry === 'object' && entry !== null) {
				const item = entry as Record<string, unknown>;
				if (
					Array.isArray(item.tasks) &&
					item.tasks.every((t): t is string => typeof t === 'string') &&
					typeof item.wrapup === 'string'
				) {
					parsedDispatchBatches.push(
						Object.freeze({
							batchNo: typeof item.batchNo === 'number' ? item.batchNo : undefined,
							tasks: Object.freeze([...item.tasks]),
							contractHash: typeof item.contractHash === 'string' ? item.contractHash : null,
							wrapup: item.wrapup, // 逐字不改写、不截断（AC 3）
						}),
					);
				}
			}
		}
	}

	const frozenBatches = Object.freeze(parsedDispatchBatches);

	return Object.freeze({
		schemaVersion: 1,
		projectName: doc.project as string,
		repoPath,
		mainBranch,
		branchPrefix,
		contentFingerprint,
		tasks: Object.freeze(parsedTasks),
		taskMap,
		dispatchBatches: frozenBatches,
	});
}

export async function parseDocsDataFile(
	filePath: string,
	fs: DocsFileSystem = DEFAULT_FS,
	hasher: DocsFingerprintHasher = defaultSha256Hasher,
): Promise<ParsedDocData> {
	let content: string;
	try {
		content = await fs.readFile(filePath, 'utf8');
	} catch (cause) {
		throw new AppError('E_DOC_SOURCE_UNREADABLE', `Cannot read docs-data.js from ${filePath}`, {
			cause,
			details: { docsPath: filePath },
		});
	}

	return parseDocsDataContent(content, { docsPath: filePath, hasher });
}

/**
 * 把解析出的任务落进 tasks / batches 表（M3-T2 的 importDocTasks），随文档导入一起做。
 * 容器没注入 db 也没注入两个 repo 时（只做解析的单测场景）跳过并如实返回 tasksImported=false。
 */
function persistParsedTasks(
	deps: DocsServiceDeps,
	docId: string,
	parsed: ParsedDocData,
	skipUnitOfWork = false,
): {
	readonly tasksImported: boolean;
	readonly dependencyReport: DependencyValidationReport | null;
} {
	const db = deps.db ?? null;
	const tasksRepo = deps.tasksRepo ?? (db ? createTasksRepo(db) : undefined);
	const batchesRepo = deps.batchesRepo ?? (db ? createBatchesRepo(db) : undefined);
	if (!tasksRepo || !batchesRepo) {
		return { tasksImported: false, dependencyReport: null };
	}
	const taskInputs = parsed.tasks.map((task) => ({
		id: task.id,
		title: task.title,
		module: task.module,
		deps: task.deps,
		input: task.input,
		output: task.output,
		accept: task.accept,
		estDays: task.estDays,
		edgeIds: task.edgeIds,
		contractHash: task.contractHash,
		isContractReady: task.isContractReady,
		contractReasons: task.contractReasons,
		taskPaths: task.taskPaths,
		implPrompt: task.implPrompt,
		reviewPrompt: task.reviewPrompt,
		resumePrompt: task.resumePrompt,
		bugPrompt: task.bugPrompt,
	}));
	const run = () =>
		importDocTasks(
			db,
			{ docId, tasks: taskInputs, idGenerator: () => deps.ids.newId() },
			{ tasksRepo, batchesRepo },
		);
	const result = deps.unitOfWork && !skipUnitOfWork ? deps.unitOfWork.run(run) : run();
	return { tasksImported: true, dependencyReport: result.report };
}

export function createDocsService(deps: DocsServiceDeps): DocsService {
	const fileSystem = deps.fs ?? DEFAULT_FS;
	const hasher = deps.hasher ?? defaultSha256Hasher;

	const docFingerprintBatchesCache = new Map<string, CachedDocHistoryEntry>();
	const lockedBatchWrapups = new Map<string, WrapupContext>();

	function recordParsedDoc(parsed: ParsedDocData): void {
		if (!parsed.dispatchBatches) return;
		const taskHashesMap = new Map(parsed.tasks.map((t) => [t.id, t.contractHash]));
		docFingerprintBatchesCache.set(
			parsed.contentFingerprint,
			Object.freeze({
				fingerprint: parsed.contentFingerprint,
				dispatchBatches: parsed.dispatchBatches,
				taskContractHashes: taskHashesMap,
			}),
		);
	}

	return Object.freeze({
		parseContent(content: string, options?: { docsPath?: string }): ParsedDocData {
			const parsed = parseDocsDataContent(content, { ...options, hasher });
			recordParsedDoc(parsed);
			return parsed;
		},

		async parseFile(filePath: string): Promise<ParsedDocData> {
			const parsed = await parseDocsDataFile(filePath, fileSystem, hasher);
			recordParsedDoc(parsed);
			return parsed;
		},

		async importDocument(docsPath: string): Promise<ImportDocumentResult> {
			const resolvedPath = resolve(docsPath);
			const existingRow = deps.documentsRepo.findByPath(resolvedPath);

			let parsed: ParsedDocData;
			try {
				parsed = await parseDocsDataFile(resolvedPath, fileSystem, hasher);
				recordParsedDoc(parsed);
			} catch (error) {
				const appError =
					error instanceof AppError
						? error
						: new AppError(
								'E_DOC_SOURCE_UNREADABLE',
								`Cannot read docs-data.js from ${resolvedPath}`,
								{
									cause: error,
									details: { docsPath: resolvedPath },
								},
							);

				// E-82：源不可读时只置不可读标记，既有任务和派发快照保持不变。
				if (existingRow) {
					deps.documentsRepo.markSourceUnreadable(existingRow.id, deps.clock.now());
				}
				throw appError;
			}

			const now = deps.clock.now();

			if (!existingRow) {
				const newDocId = deps.ids.newId();
				const newRow: DocumentRow = {
					id: newDocId,
					docs_path: resolvedPath,
					project_name: parsed.projectName,
					repo_path: parsed.repoPath,
					main_branch: parsed.mainBranch,
					branch_prefix: parsed.branchPrefix,
					lane_count: 2, // 默认 2，不读取阅读器 localStorage（E-247）
					content_fingerprint: parsed.contentFingerprint,
					is_source_readable: 1,
					is_takeover_notified: 0,
					imported_at: now,
					last_seen_at: now,
				};
				deps.documentsRepo.insert(newRow);
				const imported = persistParsedTasks(deps, newDocId, parsed);

				const row = deps.documentsRepo.findById(newDocId);
				if (!row) {
					throw new AppError('E_INTERNAL', `Failed to retrieve inserted document ${newDocId}`);
				}

				if (deps.bus && deps.envelopeFactory) {
					deps.bus.publish(
						deps.envelopeFactory.createEnvelope({
							kind: 'system.docs_changed',
							payload: {
								docsPath: row.docs_path,
								fingerprint: row.content_fingerprint,
							},
						}),
					);
				}

				return Object.freeze({
					document: mapDocumentRow(row),
					parsed,
					hasChanged: true,
					isNew: true,
					tasksImported: imported.tasksImported,
					dependencyReport: imported.dependencyReport,
				});
			}

			// E-17, E-79: 比对指纹
			const hasChanged = existingRow.content_fingerprint !== parsed.contentFingerprint;

			// 成功读取时刷新文档复核元数据，恢复 is_source_readable = 1
			const updateRow: DocumentMetadataUpdateRow = {
				id: existingRow.id,
				project_name: parsed.projectName,
				repo_path: parsed.repoPath,
				main_branch: parsed.mainBranch,
				branch_prefix: parsed.branchPrefix,
				content_fingerprint: parsed.contentFingerprint,
				is_source_readable: 1,
				last_seen_at: now,
			};
			deps.documentsRepo.updateMetadata(updateRow);
			// 每次重新导入按当前分层重算批次归属并 upsert 任务行（E-243）；同指纹时也补齐早先漏落库的行。
			const imported = persistParsedTasks(deps, existingRow.id, parsed);

			const row = deps.documentsRepo.findById(existingRow.id);
			if (!row) {
				throw new AppError('E_INTERNAL', `Failed to retrieve updated document ${existingRow.id}`);
			}

			if (hasChanged && deps.bus && deps.envelopeFactory) {
				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'system.docs_changed',
						payload: {
							docsPath: row.docs_path,
							fingerprint: row.content_fingerprint,
						},
					}),
				);
			}

			return Object.freeze({
				document: mapDocumentRow(row),
				parsed,
				hasChanged,
				isNew: false,
				tasksImported: imported.tasksImported,
				dependencyReport: imported.dependencyReport,
			});
		},

		async refreshDocument(docId: string): Promise<RefreshDocumentResponse> {
			const existingRow = deps.documentsRepo.findById(docId);
			if (!existingRow) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${docId}`, {
					details: { docId },
				});
			}

			let parsed: ParsedDocData;
			try {
				parsed = await parseDocsDataFile(existingRow.docs_path, fileSystem, hasher);
				recordParsedDoc(parsed);
			} catch (error) {
				const appError =
					error instanceof AppError
						? error
						: new AppError(
								'E_DOC_SOURCE_UNREADABLE',
								`Cannot read docs-data.js from ${existingRow.docs_path}`,
								{
									cause: error,
									details: { docsPath: existingRow.docs_path },
								},
							);

				// E-82: 源不可读时只置不可读标记，既有任务和派发快照保持不变。
				deps.documentsRepo.markSourceUnreadable(existingRow.id, deps.clock.now());
				throw appError;
			}

			const now = deps.clock.now();
			const hasChanged = existingRow.content_fingerprint !== parsed.contentFingerprint;

			const updateRow: DocumentMetadataUpdateRow = {
				id: existingRow.id,
				project_name: parsed.projectName,
				repo_path: parsed.repoPath,
				main_branch: parsed.mainBranch,
				branch_prefix: parsed.branchPrefix,
				content_fingerprint: parsed.contentFingerprint,
				is_source_readable: 1,
				last_seen_at: now,
			};

			let flags = {
				hasAcceptChanged: false,
				hasPromptChanged: false,
				isRemovedFromDoc: false,
			};

			const performDatabaseRefresh = () => {
				deps.documentsRepo.updateMetadata(updateRow);
				persistParsedTasks(deps, existingRow.id, parsed, true);

				if (deps.dispatchSnapshotsRepo) {
					const banner = deps.dispatchSnapshotsRepo.refreshDocDiff(
						existingRow.id,
						parsed.tasks.map((t) => t.id),
					);
					flags = {
						hasAcceptChanged: banner.acceptChangedCount > 0,
						hasPromptChanged: banner.promptChangedCount > 0,
						isRemovedFromDoc: banner.removedTaskCount > 0,
					};
				}
			};

			if (deps.unitOfWork) {
				deps.unitOfWork.run(performDatabaseRefresh);
			} else {
				performDatabaseRefresh();
			}

			if (hasChanged && deps.bus && deps.envelopeFactory) {
				deps.bus.publish(
					deps.envelopeFactory.createEnvelope({
						kind: 'system.docs_changed',
						payload: {
							docsPath: existingRow.docs_path,
							fingerprint: parsed.contentFingerprint,
						},
					}),
				);
			}

			return Object.freeze({
				changed: hasChanged,
				flags: Object.freeze(flags),
			});
		},

		async listTasks(docId: string, query?: ListTasksQuery): Promise<ListTasksResult> {
			const existing = deps.documentsRepo.findById(docId);
			if (!existing) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${docId}`, {
					details: { docId },
				});
			}

			if (query?.state !== undefined && !isTaskState(query.state)) {
				throw new AppError('E_VALIDATION', `Invalid task state filter: ${query.state}`, {
					details: { state: query.state },
				});
			}

			const rawLimit = query?.limit;
			if (
				rawLimit !== undefined &&
				(!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200)
			) {
				throw new AppError(
					'E_VALIDATION',
					`Invalid limit: ${rawLimit}; must be an integer between 1 and 200`,
					{ details: { limit: rawLimit } },
				);
			}
			const limit = rawLimit ?? 50;

			const tasksRepo = deps.tasksRepo ?? (deps.db ? createTasksRepo(deps.db) : undefined);
			if (!tasksRepo) {
				throw new AppError('E_INTERNAL', 'TasksRepo is not available in DocsService');
			}

			const rows = tasksRepo.listTasksWithDerivedState({
				docId,
				batchId: query?.batchId ?? null,
				state: query?.state ?? null,
				cursor: query?.cursor ?? null,
				limit: limit + 1,
			});

			const hasMore = rows.length > limit;
			const pagedRows = hasMore ? rows.slice(0, limit) : rows;
			const lastRow = pagedRows[pagedRows.length - 1];
			const nextCursor = hasMore && lastRow ? lastRow.task_key : null;
			const tasks = Object.freeze(pagedRows.map(toTaskDto));

			return Object.freeze({
				tasks,
				nextCursor,
			});
		},

		getDocumentById(id: string): DocumentRecord | null {
			const row = deps.documentsRepo.findById(id);
			return row ? mapDocumentRow(row) : null;
		},

		getDocumentByPath(docsPath: string): DocumentRecord | null {
			const resolvedPath = resolve(docsPath);
			const row = deps.documentsRepo.findByPath(resolvedPath);
			return row ? mapDocumentRow(row) : null;
		},

		listDocuments(): readonly DocumentRecord[] {
			return deps.documentsRepo.listAll().map(mapDocumentRow);
		},

		updateLaneCount(id: string, laneCount: number): void {
			deps.documentsRepo.updateLaneCount(id, laneCount);
		},

		markSourceUnreadable(id: string): void {
			deps.documentsRepo.markSourceUnreadable(id, deps.clock.now());
		},

		setTakeoverNotified(id: string, isTakeoverNotified: boolean): void {
			deps.documentsRepo.setTakeoverNotified(id, isTakeoverNotified ? 1 : 0);
		},

		async openReader(id: string): Promise<OpenReaderResult> {
			const row = deps.documentsRepo.findById(id);
			if (!row) {
				throw new AppError('E_NOT_FOUND', `Document not found: ${id}`, {
					details: { id },
				});
			}

			const readerPath = join(dirname(row.docs_path), 'index.html');
			const checkExists =
				deps.fileExists ??
				(async (p: string) => {
					try {
						await nodeFs.access(p);
						return true;
					} catch {
						return false;
					}
				});

			const exists = await checkExists(readerPath);
			if (!exists) {
				// E-86: 文档目录被移动或重命名时提示「文档路径不可用，请重新定位」，
				// 任务记录、快照、会话指针全部保留，只标记源不可读
				deps.documentsRepo.markSourceUnreadable(id, deps.clock.now());
				throw new AppError('E_NOT_FOUND', 'Document reader path is not available', {
					details: {
						docId: id,
						docsPath: row.docs_path,
						readerPath,
					},
				});
			}

			// E-85: 以系统默认浏览器打开原 index.html，不注入脚本、不改磁盘任何文件
			const browserOpener =
				deps.openBrowser ??
				(deps.hostInputs ? createOpenBrowser({ hostInputs: deps.hostInputs }) : undefined);
			if (!browserOpener) {
				throw new AppError('E_INTERNAL', 'Host platform input is required to open browser');
			}
			await browserOpener(readerPath);

			return Object.freeze({
				opened: true,
				readerPath,
			});
		},

		getWrapupContext(batchId: string, options?: GetWrapupContextOptions): WrapupContext {
			return getWrapupContextInternal(
				batchId,
				deps,
				lockedBatchWrapups,
				docFingerprintBatchesCache,
				options,
			);
		},
	});
}

/**
 * 提取指定批次的收口上下文（M3-T6, AC 1-4, E-296, E-50）。
 * 供 M8 组装收口运行提示词。
 */
export function getWrapupContextInternal(
	batchId: string,
	deps: {
		documentsRepo: DocumentsRepo;
		batchesRepo?: BatchesRepo;
		tasksRepo?: TasksRepo;
		dispatchSnapshotsRepo?: DispatchSnapshotsRepo;
		db?: DatabaseConnection;
		fs?: DocsFileSystem;
		hasher?: DocsFingerprintHasher;
	},
	lockedBatchWrapups: Map<string, WrapupContext>,
	docFingerprintBatchesCache: Map<string, CachedDocHistoryEntry>,
	options?: GetWrapupContextOptions,
): WrapupContext {
	if (typeof batchId !== 'string' || batchId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'batchId must be a non-empty string');
	}
	const cleanBatchId = batchId.trim();

	// AC 4 & E-50: 收口途中文档指纹变化时仍取快照那一份，不热改
	const locked = lockedBatchWrapups.get(cleanBatchId);
	if (locked) {
		return locked;
	}

	const db = options?.database ?? deps.db;
	const batchesRepo =
		options?.batchesRepo ?? deps.batchesRepo ?? (db ? createBatchesRepo(db) : undefined);
	const tasksRepo = options?.tasksRepo ?? deps.tasksRepo ?? (db ? createTasksRepo(db) : undefined);
	const snapshotsRepo =
		options?.dispatchSnapshotsRepo ??
		deps.dispatchSnapshotsRepo ??
		(db ? createDispatchSnapshotsRepo(db) : undefined);
	const documentsRepo = options?.documentsRepo ?? deps.documentsRepo;

	if (!batchesRepo || !tasksRepo || !documentsRepo) {
		throw new AppError(
			'E_INTERNAL',
			'Required repositories (batchesRepo, tasksRepo, documentsRepo) are not available to getWrapupContext',
		);
	}

	const batchRow = batchesRepo.findById(cleanBatchId);
	if (!batchRow) {
		throw new AppError('E_NOT_FOUND', `Batch not found: ${cleanBatchId}`, {
			details: { batchId: cleanBatchId },
		});
	}

	const docRow = documentsRepo.findById(batchRow.doc_id);
	if (!docRow) {
		throw new AppError('E_NOT_FOUND', `Document not found for batch: ${cleanBatchId}`, {
			details: { batchId: cleanBatchId, docId: batchRow.doc_id },
		});
	}

	// 查本批任务并提取业务标识 task_key（过滤已从文档移除的任务）
	const batchTasks = tasksRepo.listByBatchId(cleanBatchId);
	const activeTasks = batchTasks.filter((t) => t.is_removed_from_doc !== 1);
	const currentTaskKeys = activeTasks.map((t) => t.task_key);

	// 检查快照与文档变更状态（E-50）
	let docChangedSinceDispatch = false;
	const snapshotHashesByTaskKey = new Map<string, string>();

	if (snapshotsRepo && activeTasks.length > 0) {
		for (const task of activeTasks) {
			const snap = snapshotsRepo.findLatestByTaskId(task.id);
			if (snap) {
				snapshotHashesByTaskKey.set(task.task_key, snap.contract_hash);
				if (
					snap.contract_hash !== task.contract_hash ||
					task.has_accept_changed === 1 ||
					task.has_prompt_changed === 1
				) {
					docChangedSinceDispatch = true;
				}
			}
		}
	}

	// R2 & AC 4 & E-50: 候选批次严格受限：
	// docChangedSinceDispatch=true 时候选只能是用本批任务派发快照 contract_hash 逐版本精确命中的版本；
	// 拿不到就保持 undefined（下游回退 builtin），绝不取任意历史版本，绝不在检出变更后退回当前文档。
	// docChangedSinceDispatch=false（当前文档≡派发时文档）才允许使用当前版本。
	let candidateBatches: readonly ParsedDispatchBatch[] | undefined;

	if (docChangedSinceDispatch) {
		if (snapshotHashesByTaskKey.size > 0) {
			for (const entry of docFingerprintBatchesCache.values()) {
				let allMatch = true;
				for (const [taskKey, snapHash] of snapshotHashesByTaskKey.entries()) {
					const historicalHash = entry.taskContractHashes.get(taskKey);
					if (historicalHash !== snapHash) {
						allMatch = false;
						break;
					}
				}
				if (allMatch) {
					candidateBatches = entry.dispatchBatches;
					break;
				}
			}
		}
	} else {
		candidateBatches = docFingerprintBatchesCache.get(docRow.content_fingerprint)?.dispatchBatches;
	}

	// 执行任务集合相等匹配（AC 1, AC 2, E-296）
	const matchedEntry = matchBatchByTasksSet(candidateBatches, currentTaskKeys);

	let wrapup: string;
	let promptSource: WrapupPromptSource;
	let contractHash: string | null = null;

	if (matchedEntry) {
		// AC 1 & AC 3: 命中返回该批 wrapup 原文（逐字不改写、不截断）与 promptSource='docs'
		wrapup = matchedEntry.wrapup;
		promptSource = PROMPT_SOURCE_DOCS;
		contractHash = matchedEntry.contractHash ?? null;
	} else {
		// AC 2 & E-296: 匹配不到或未导出该键时返回内置通用收口提示词，标 promptSource='builtin'
		wrapup = BUILTIN_WRAPUP_PROMPT;
		promptSource = PROMPT_SOURCE_BUILTIN;
		// 记 warn，不抛错、不让收口停摆（E-296）
		console.warn(
			`[E-296] Document did not provide matching dispatchBatches for batch ${cleanBatchId}, falling back to builtin wrapup prompt`,
		);
	}

	const context: WrapupContext = Object.freeze({
		batchId: cleanBatchId,
		batchNo: batchRow.batch_no,
		wrapup,
		wrapupPrompt: wrapup,
		promptSource,
		tasks: Object.freeze([...currentTaskKeys]),
		contractHash,
		isSnapshot: true,
		isReadOnly: true,
		docChangedSinceDispatch,
	});

	// 锁定该批次快照（AC 4, E-50: 收口途中文档变了仍取快照那一份，不热改）
	lockedBatchWrapups.set(cleanBatchId, context);

	return context;
}
