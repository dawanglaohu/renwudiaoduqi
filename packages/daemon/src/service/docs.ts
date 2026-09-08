import * as nodeFs from 'node:fs/promises';
import { resolve } from 'node:path';
import { computeDocsFingerprint } from '../domain/docs-fingerprint.ts';
import { batchNoOf, layerOf } from '../domain/layer-of.ts';
import { AppError } from '../errors/app-error.ts';
import type { DocumentRecord, DocumentsRepo } from '../repo/documents.ts';

export interface ParsedDocTask {
	readonly id: string;
	readonly title: string;
	readonly module: string;
	readonly deps: readonly string[];
	readonly input: string | null;
	readonly output: string | null;
	readonly accept: string | null;
	readonly estDays: number | null;
	readonly edgeIds: readonly string[];
	readonly contractHash: string;
	readonly isContractReady: boolean;
	readonly contractReasons: readonly string[];
	readonly taskPaths: readonly string[];
	readonly implPrompt: string;
	readonly reviewPrompt: string;
	readonly resumePrompt: string | null;
	readonly layer: number;
	readonly batchNo: number;
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
}

export interface DocsFileSystem {
	readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

export interface DocsServiceDeps {
	readonly documentsRepo: DocumentsRepo;
	readonly clock: { readonly now: () => string };
	readonly ids: { readonly newId: () => string };
	readonly fs?: DocsFileSystem;
}

export interface ImportDocumentResult {
	readonly document: DocumentRecord;
	readonly parsed: ParsedDocData;
	readonly hasChanged: boolean;
	readonly isNew: boolean;
}

export interface DocsService {
	readonly parseContent: (content: string, options?: { docsPath?: string }) => ParsedDocData;
	readonly parseFile: (filePath: string) => Promise<ParsedDocData>;
	readonly importDocument: (docsPath: string) => Promise<ImportDocumentResult>;
	readonly getDocumentById: (id: string) => DocumentRecord | null;
	readonly getDocumentByPath: (docsPath: string) => DocumentRecord | null;
	readonly listDocuments: () => readonly DocumentRecord[];
	readonly updateLaneCount: (id: string, laneCount: number) => void;
	readonly markSourceUnreadable: (id: string) => void;
}

const DEFAULT_FS: DocsFileSystem = Object.freeze({
	async readFile(path: string, encoding: 'utf8'): Promise<string> {
		return nodeFs.readFile(path, encoding);
	},
});

/**
 * 强制按 UTF-8 读取 docs-data.js，剥离固定外壳后 JSON.parse，
 * 校验 schemaVersion=1 与任务包的三处哈希一致，按 deps 计算批次分层（E-16, E-17, E-246）。
 */
export function parseDocsDataContent(
	content: string,
	options: { docsPath?: string } = {},
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
	const depsLookup: Record<string, readonly string[]> = {};

	for (const t of tasksRaw) {
		if (typeof t !== 'object' || t === null) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Invalid task entry in data.tasks', {
				details: { docsPath: options.docsPath },
			});
		}
		const taskId = (t as { id?: unknown }).id;
		if (typeof taskId !== 'string' || taskId.trim().length === 0) {
			throw new AppError('E_DOC_SOURCE_UNREADABLE', 'Task in data.tasks has missing or empty id', {
				details: { docsPath: options.docsPath },
			});
		}
		taskIds.push(taskId);
		const rawDeps = (t as { deps?: unknown }).deps;
		depsLookup[taskId] = Array.isArray(rawDeps)
			? rawDeps.filter((d): d is string => typeof d === 'string')
			: [];
	}

	const parsedTasks: ParsedDocTask[] = [];
	const fingerprintItems: { id: string; contractHash: string }[] = [];

	// 按依赖拓扑分层算出批次（E-246）
	const layers = layerOf(taskIds, depsLookup);

	for (const t of tasksRaw as Record<string, unknown>[]) {
		const taskId = t.id as string;
		const title = typeof t.title === 'string' ? t.title : '';
		const moduleKey = typeof t.module === 'string' ? t.module : '';
		const deps = depsLookup[taskId] ?? [];
		const input = typeof t.input === 'string' ? t.input : null;
		const output = typeof t.output === 'string' ? t.output : null;
		const accept = typeof t.accept === 'string' ? t.accept : null;
		const estDays = typeof t.est === 'number' ? t.est : null;
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

		const taskPathsRaw = effectivePaths[taskId];
		if (!Array.isArray(taskPathsRaw) || !taskPathsRaw.every((p) => typeof p === 'string')) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing or invalid effectivePaths for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		// 校验三处哈希一致性（E-17）
		const dispatchHash = dispatchItem.contractHash;
		const contractsHash = contractItem.hash;
		const readinessHash = readinessItem.contractHash;

		if (
			typeof dispatchHash !== 'string' ||
			typeof contractsHash !== 'string' ||
			typeof readinessHash !== 'string' ||
			dispatchHash !== contractsHash ||
			dispatchHash !== readinessHash
		) {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Contract hash mismatch for task ${taskId}: dispatch=${String(dispatchHash)}, contracts=${String(contractsHash)}, readiness=${String(readinessHash)}`,
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

		const implPrompt = dispatchItem.implementation;
		const reviewPrompt = dispatchItem.review;
		if (typeof implPrompt !== 'string' || typeof reviewPrompt !== 'string') {
			throw new AppError(
				'E_DOC_SOURCE_UNREADABLE',
				`Missing or non-string prompts in dispatch for task: ${taskId}`,
				{ details: { docsPath: options.docsPath, taskId } },
			);
		}

		const resumePrompt = typeof dispatchItem.resume === 'string' ? dispatchItem.resume : null;
		const isContractReady = readinessItem.ready === true;
		const contractReasons = Array.isArray(readinessItem.reasons)
			? Object.freeze(readinessItem.reasons.filter((r): r is string => typeof r === 'string'))
			: Object.freeze([]);

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
				resumePrompt,
				layer,
				batchNo,
			}),
		);

		fingerprintItems.push({ id: taskId, contractHash: dispatchHash });
	}

	const contentFingerprint = computeDocsFingerprint(fingerprintItems);

	const pres = doc.pres as Record<string, unknown> | undefined;
	const presHandoff = pres?.handoff as Record<string, unknown> | undefined;
	const repoPath = typeof presHandoff?.repo === 'string' ? presHandoff.repo : null;
	const mainBranch = typeof presHandoff?.mainBranch === 'string' ? presHandoff.mainBranch : 'main';
	const branchPrefix =
		typeof presHandoff?.branchPrefix === 'string' ? presHandoff.branchPrefix : 'task/';

	const taskMap = new Map(parsedTasks.map((t) => [t.id, t]));

	return Object.freeze({
		schemaVersion: 1,
		projectName: doc.project as string,
		repoPath,
		mainBranch,
		branchPrefix,
		contentFingerprint,
		tasks: Object.freeze(parsedTasks),
		taskMap,
	});
}

export async function parseDocsDataFile(
	filePath: string,
	fs: DocsFileSystem = DEFAULT_FS,
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

	return parseDocsDataContent(content, { docsPath: filePath });
}

export function createDocsService(deps: DocsServiceDeps): DocsService {
	const fileSystem = deps.fs ?? DEFAULT_FS;

	return Object.freeze({
		parseContent(content: string, options?: { docsPath?: string }): ParsedDocData {
			return parseDocsDataContent(content, options);
		},

		async parseFile(filePath: string): Promise<ParsedDocData> {
			return parseDocsDataFile(filePath, fileSystem);
		},

		async importDocument(docsPath: string): Promise<ImportDocumentResult> {
			const resolvedPath = resolve(docsPath);
			const existingDoc = deps.documentsRepo.findByPath(resolvedPath);

			let parsed: ParsedDocData;
			try {
				parsed = await parseDocsDataFile(resolvedPath, fileSystem);
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

				// E-82: 源不可读时保留全部记录与快照，置 is_source_readable=0 并冻结新派发，不清空任何数据
				if (existingDoc) {
					deps.documentsRepo.markSourceUnreadable(existingDoc.id, deps.clock.now());
				}
				throw appError;
			}

			const now = deps.clock.now();

			if (!existingDoc) {
				const newDocId = deps.ids.newId();
				deps.documentsRepo.insert({
					id: newDocId,
					docsPath: resolvedPath,
					projectName: parsed.projectName,
					repoPath: parsed.repoPath,
					mainBranch: parsed.mainBranch,
					branchPrefix: parsed.branchPrefix,
					laneCount: 2, // 默认 2，不读取阅读器 localStorage（E-247）
					contentFingerprint: parsed.contentFingerprint,
					isSourceReadable: true,
					isTakeoverNotified: false,
					importedAt: now,
					lastSeenAt: now,
				});

				const document = deps.documentsRepo.findById(newDocId);
				if (!document) {
					throw new AppError('E_INTERNAL', `Failed to retrieve inserted document ${newDocId}`);
				}
				return Object.freeze({
					document,
					parsed,
					hasChanged: true,
					isNew: true,
				});
			}

			// E-17, E-79: 比对指纹
			const hasChanged = existingDoc.contentFingerprint !== parsed.contentFingerprint;

			// 成功读取时刷新文档复核元数据，恢复 is_source_readable = 1
			deps.documentsRepo.updateMetadata({
				id: existingDoc.id,
				projectName: parsed.projectName,
				repoPath: parsed.repoPath,
				mainBranch: parsed.mainBranch,
				branchPrefix: parsed.branchPrefix,
				contentFingerprint: parsed.contentFingerprint,
				isSourceReadable: true,
				lastSeenAt: now,
			});

			const document = deps.documentsRepo.findById(existingDoc.id);
			if (!document) {
				throw new AppError('E_INTERNAL', `Failed to retrieve updated document ${existingDoc.id}`);
			}
			return Object.freeze({
				document,
				parsed,
				hasChanged,
				isNew: false,
			});
		},

		getDocumentById(id: string): DocumentRecord | null {
			return deps.documentsRepo.findById(id);
		},

		getDocumentByPath(docsPath: string): DocumentRecord | null {
			const resolvedPath = resolve(docsPath);
			return deps.documentsRepo.findByPath(resolvedPath);
		},

		listDocuments(): readonly DocumentRecord[] {
			return deps.documentsRepo.listAll();
		},

		updateLaneCount(id: string, laneCount: number): void {
			deps.documentsRepo.updateLaneCount(id, laneCount);
		},

		markSourceUnreadable(id: string): void {
			deps.documentsRepo.markSourceUnreadable(id, deps.clock.now());
		},
	});
}
