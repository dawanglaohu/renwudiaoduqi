import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createBatchesRepo } from '../../src/repo/batches.ts';
import { type DocumentRow, createDocumentsRepo } from '../../src/repo/documents.ts';
import {
	type ParsedDocTaskInput,
	createTasksRepo,
	importDocTasks,
	validateTaskDependencies,
} from '../../src/repo/tasks.ts';
import {
	type DocsFileSystem,
	createDocsService,
	mapDocumentRow,
	parseDocsDataContent,
} from '../../src/service/docs.ts';

const openDatabases: DatabaseConnection[] = [];
const temporaryDirectories: string[] = [];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDirectory = resolve(__dirname, '../../migrations');

afterEach(() => {
	for (const db of openDatabases.splice(0)) {
		if (db.open) db.close();
	}
	for (const dir of temporaryDirectories.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function createTestDatabase(): DatabaseConnection {
	const dir = mkdtempSync(join(tmpdir(), 'agent-scheduler-docs-test-'));
	temporaryDirectories.push(dir);
	const db = openDatabase(join(dir, 'test.db'));
	openDatabases.push(db);

	const runner = createMigrationRunner({
		clock: { now: () => '2026-09-08T00:00:00.000Z' },
		database: db,
		fileSystem: {
			readDirectory: (path) => readdirSync(path),
			readFile: (path) => readFileSync(path, 'utf8'),
		},
	});
	runner.run(migrationsDirectory);
	return db;
}

interface DocTask {
	id: string;
	title: string;
	module: string;
	deps: string[];
	input?: string;
	output?: string;
	accept: string;
	est?: number;
	edges?: string[];
}

interface DocDispatchItem {
	contractHash: string;
	implementation: string;
	review: string;
	resume?: string;
}

interface DocPayload {
	schemaVersion: number;
	project: string;
	generated?: string;
	pres: {
		handoff: {
			repo: string;
			mainBranch: string;
			branchPrefix: string;
		};
	};
	handoff: {
		version: string;
		schemaVersion: number;
		contracts: Record<string, { hash: string; effectivePaths: string[] }>;
		readiness: Record<string, { ready: boolean; contractHash: string; reasons: string[] }>;
		effectivePaths: Record<string, string[]>;
	};
	data: {
		tasks: DocTask[];
	};
	dispatch: Record<string, DocDispatchItem>;
}

function makeValidDocPayload(overrides: Partial<DocPayload> = {}): DocPayload {
	const base: DocPayload = {
		schemaVersion: 1,
		project: '测试项目',
		pres: {
			handoff: {
				repo: 'test-repo',
				mainBranch: 'main',
				branchPrefix: 'task/',
			},
		},
		handoff: {
			version: '1.1.0',
			schemaVersion: 1,
			contracts: {
				'T-1': {
					hash: 'hash-t1',
					effectivePaths: ['src/a.ts'],
				},
				'T-2': {
					hash: 'hash-t2',
					effectivePaths: ['src/b.ts'],
				},
			},
			readiness: {
				'T-1': {
					ready: true,
					contractHash: 'hash-t1',
					reasons: [],
				},
				'T-2': {
					ready: false,
					contractHash: 'hash-t2',
					reasons: ['待复核条款 3'],
				},
			},
			effectivePaths: {
				'T-1': ['src/a.ts'],
				'T-2': ['src/b.ts'],
			},
		},
		data: {
			tasks: [
				{
					id: 'T-1',
					title: '第一个任务',
					module: 'M1',
					deps: [],
					input: '输入文本',
					output: '产出文本',
					accept: '1) 验收第一条 2) 验收第二条',
					est: 1.0,
					edges: ['E-16'],
				},
				{
					id: 'T-2',
					title: '第二个任务',
					module: 'M1',
					deps: ['T-1'],
					input: '输入2',
					output: '产出2',
					accept: '1) 验收2',
					est: 2.0,
					edges: ['E-17'],
				},
			],
		},
		dispatch: {
			'T-1': {
				contractHash: 'hash-t1',
				implementation: '请实现 T-1',
				review: '请审查 T-1',
				resume: '请继续 T-1',
			},
			'T-2': {
				contractHash: 'hash-t2',
				implementation: '请实现 T-2',
				review: '请审查 T-2',
			},
		},
	};

	return { ...base, ...overrides };
}

describe('service/docs protocol validation (E-16, E-17, E-82, E-246)', () => {
	it('E-16 parses UTF-8 content with Chinese characters, strips window.DOCS prefix and semicolon', () => {
		const payload = makeValidDocPayload();
		const jsContent = `window.DOCS = ${JSON.stringify(payload)};\n`;

		const parsed = parseDocsDataContent(jsContent);
		expect(parsed.schemaVersion).toBe(1);
		expect(parsed.projectName).toBe('测试项目');
		expect(parsed.repoPath).toBe('test-repo');
		expect(parsed.tasks.length).toBe(2);
		expect(parsed.tasks[0]?.title).toBe('第一个任务');
		expect(parsed.tasks[0]?.accept).toBe('1) 验收第一条 2) 验收第二条');
		expect(parsed.tasks[0]?.batchNo).toBe(1);
		expect(parsed.tasks[1]?.batchNo).toBe(2);
	});

	it('E-16 strips UTF-8 BOM if present without corrupting content', () => {
		const payload = makeValidDocPayload();
		const bomContent = `\uFEFFwindow.DOCS = ${JSON.stringify(payload)};`;

		const parsed = parseDocsDataContent(bomContent);
		expect(parsed.projectName).toBe('测试项目');
	});

	it('E-16 throws E_DOC_SOURCE_UNREADABLE if window.DOCS prefix is missing', () => {
		const invalidContent = 'const data = { schemaVersion: 1 };';
		expect(() => parseDocsDataContent(invalidContent)).toThrowError(AppError);
		try {
			parseDocsDataContent(invalidContent);
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}
	});

	it('E-16 throws E_DOC_SOURCE_UNREADABLE on malformed JSON payload', () => {
		const malformedContent = 'window.DOCS = { schemaVersion: 1, broken json ';
		try {
			parseDocsDataContent(malformedContent);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}
	});

	it('E-82 rejects protocol versions other than schemaVersion 1', () => {
		const payload = makeValidDocPayload({ schemaVersion: 2 });
		expect(() => parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`)).toThrowError(
			AppError,
		);
	});

	it('E-82 rejects duplicate task IDs in data.tasks with E_DOC_SOURCE_UNREADABLE', () => {
		const payload = makeValidDocPayload();
		payload.data.tasks.push({
			id: 'T-1',
			title: '重复的任务',
			module: 'M1',
			deps: [],
			accept: '1) 验收',
		});

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown for duplicate task id');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
			expect((err as AppError).message).toContain('Duplicate task id in data.tasks');
		}
	});

	it('E-82 rejects tasks with missing required title, module, or acceptance fields', () => {
		const payloadNoTitle = makeValidDocPayload();
		const t0 = payloadNoTitle.data.tasks[0];
		expect(t0).toBeDefined();
		if (!t0) return;
		payloadNoTitle.data.tasks[0] = {
			...t0,
			title: '   ',
		};
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadNoTitle)};`),
		).toThrowError(AppError);

		const payloadNoAccept = makeValidDocPayload();
		const tAccept0 = payloadNoAccept.data.tasks[0];
		expect(tAccept0).toBeDefined();
		if (!tAccept0) return;
		payloadNoAccept.data.tasks[0] = {
			...tAccept0,
			accept: '',
		};
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadNoAccept)};`),
		).toThrowError(AppError);

		const payloadNoModule = makeValidDocPayload();
		const tModule0 = payloadNoModule.data.tasks[0];
		expect(tModule0).toBeDefined();
		if (!tModule0) return;
		payloadNoModule.data.tasks[0] = {
			...tModule0,
			module: '',
		};
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadNoModule)};`),
		).toThrowError(AppError);

		const payloadInvalidDeps = makeValidDocPayload();
		const tDeps0 = payloadInvalidDeps.data.tasks[0];
		expect(tDeps0).toBeDefined();
		if (!tDeps0) return;
		payloadInvalidDeps.data.tasks[0] = {
			...tDeps0,
			deps: 'T-0' as unknown as string[],
		};
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadInvalidDeps)};`),
		).toThrowError(AppError);
	});

	it('E-17 rejects empty or mismatched hashes across all three task packages', () => {
		const payloadEmpty = makeValidDocPayload();
		const d1 = payloadEmpty.dispatch['T-1'];
		const c1 = payloadEmpty.handoff.contracts['T-1'];
		const r1 = payloadEmpty.handoff.readiness['T-1'];
		expect(d1).toBeDefined();
		expect(c1).toBeDefined();
		expect(r1).toBeDefined();
		if (!d1 || !c1 || !r1) return;

		payloadEmpty.dispatch['T-1'] = {
			...d1,
			contractHash: '',
		};
		payloadEmpty.handoff.contracts['T-1'] = {
			...c1,
			hash: '',
		};
		payloadEmpty.handoff.readiness['T-1'] = {
			...r1,
			contractHash: '',
		};

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadEmpty)};`);
			expect.unreachable('Should have thrown for empty contract hash');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
			expect((err as AppError).message).toContain('Contract hash missing or mismatch');
		}

		const payloadMismatch = makeValidDocPayload();
		const mismatchContract = payloadMismatch.handoff.contracts['T-1'];
		expect(mismatchContract).toBeDefined();
		if (!mismatchContract) return;
		payloadMismatch.handoff.contracts['T-1'] = {
			...mismatchContract,
			hash: 'mismatched-hash',
		};

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadMismatch)};`);
			expect.unreachable('Should have thrown for hash mismatch');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
			expect((err as AppError).message).toContain('Contract hash missing or mismatch');
		}
	});

	it('E-82 rejects invalid ready and reasons shapes', () => {
		const payloadInvalidReady = makeValidDocPayload();
		const readiness1 = {
			...payloadInvalidReady.handoff.readiness,
			'T-1': {
				ready: 'true' as unknown as boolean,
				contractHash: 'hash-t1',
				reasons: [],
			},
		};
		payloadInvalidReady.handoff = {
			...payloadInvalidReady.handoff,
			readiness: readiness1,
		};

		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadInvalidReady)};`),
		).toThrowError(AppError);

		const payloadInvalidReasons = makeValidDocPayload();
		const readiness2 = {
			...payloadInvalidReasons.handoff.readiness,
			'T-1': {
				ready: true,
				contractHash: 'hash-t1',
				reasons: 'not-an-array' as unknown as string[],
			},
		};
		payloadInvalidReasons.handoff = {
			...payloadInvalidReasons.handoff,
			readiness: readiness2,
		};

		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadInvalidReasons)};`),
		).toThrowError(AppError);
	});

	it('E-82 rejects missing task packages and empty implementation or review prompts', () => {
		const missingDispatch = makeValidDocPayload();
		const t1Dispatch = missingDispatch.dispatch['T-1'];
		expect(t1Dispatch).toBeDefined();
		if (!t1Dispatch) return;
		missingDispatch.dispatch = { 'T-1': t1Dispatch };
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(missingDispatch)};`),
		).toThrowError(AppError);

		const emptyImplementation = makeValidDocPayload();
		const dispatch = emptyImplementation.dispatch['T-1'];
		expect(dispatch).toBeDefined();
		if (!dispatch) return;
		emptyImplementation.dispatch['T-1'] = { ...dispatch, implementation: ' ' };
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(emptyImplementation)};`),
		).toThrowError(AppError);
	});

	it('E-82 rejects effectivePaths that violate the 1.1.0 producer rules', () => {
		const payloadEmpty = makeValidDocPayload();
		payloadEmpty.handoff.effectivePaths['T-1'] = [];
		expect(() =>
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payloadEmpty)};`),
		).toThrowError(AppError);

		const invalidPaths: unknown[] = [
			42,
			'',
			' src/file.ts',
			'src/file.ts ',
			'src\\file.ts',
			'/etc/passwd',
			'C:relative.ts',
			'C:\\absolute.ts',
			'src/../secret.ts',
			'src/./file.ts',
			'src//file.ts',
			'src/\0bad.ts',
			'src/*.ts',
			'src/file?.ts',
			'src/[file].ts',
			'src/{file}.ts',
		];
		for (const invalidPath of invalidPaths) {
			const payload = makeValidDocPayload();
			payload.handoff.effectivePaths['T-1'] = [invalidPath as string];
			expect(
				() => parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`),
				`expected ${JSON.stringify(invalidPath)} to be rejected`,
			).toThrowError(AppError);
		}
	});

	it('E-82 task with ready=false is valid for import but records isContractReady=false', () => {
		const payload = makeValidDocPayload();
		const parsed = parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);

		const task1 = parsed.taskMap.get('T-1');
		const task2 = parsed.taskMap.get('T-2');

		expect(task1?.isContractReady).toBe(true);
		expect(task1?.contractReasons).toEqual([]);

		expect(task2?.isContractReady).toBe(false);
		expect(task2?.contractReasons).toEqual(['待复核条款 3']);
	});
});

describe('E-82 document preservation after a valid source becomes corrupt', () => {
	it('retains existing document record and sets is_source_readable=0 when input becomes corrupted', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);

		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		let idCounter = 0;
		const ids = {
			newId() {
				return `doc-${++idCounter}`;
			},
		};

		let currentContent = `window.DOCS = ${JSON.stringify(makeValidDocPayload())};`;
		const mockFs: DocsFileSystem = {
			async readFile() {
				return currentContent;
			},
		};

		const service = createDocsService({
			documentsRepo,
			clock,
			ids,
			fs: mockFs,
		});

		const initial = await service.importDocument('/app/docs-data.js');
		expect(initial.isNew).toBe(true);
		expect(initial.document.isSourceReadable).toBe(true);
		const docId = initial.document.id;

		const corruptedDuplicateId = makeValidDocPayload();
		corruptedDuplicateId.data.tasks.push({
			id: 'T-1',
			title: 'dup',
			module: 'M1',
			deps: [],
			accept: '1) acc',
		});
		currentContent = `window.DOCS = ${JSON.stringify(corruptedDuplicateId)};`;
		clock.current = '2026-09-08T11:00:00.000Z';

		try {
			await service.importDocument('/app/docs-data.js');
			expect.unreachable('Should have thrown on duplicate task ID');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}

		let doc = service.getDocumentById(docId);
		expect(doc).not.toBeNull();
		expect(doc?.isSourceReadable).toBe(false);
		expect(doc?.lastSeenAt).toBe('2026-09-08T11:00:00.000Z');

		const corruptedHashMismatch = makeValidDocPayload();
		const corruptContract = corruptedHashMismatch.handoff.contracts['T-1'];
		expect(corruptContract).toBeDefined();
		if (!corruptContract) return;
		corruptedHashMismatch.handoff.contracts['T-1'] = {
			...corruptContract,
			hash: 'bad-hash',
		};
		currentContent = `window.DOCS = ${JSON.stringify(corruptedHashMismatch)};`;
		clock.current = '2026-09-08T12:00:00.000Z';

		try {
			await service.importDocument('/app/docs-data.js');
			expect.unreachable('Should have thrown on hash mismatch');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}

		doc = service.getDocumentById(docId);
		expect(doc?.isSourceReadable).toBe(false);
		expect(doc?.lastSeenAt).toBe('2026-09-08T12:00:00.000Z');

		const corruptedPath = makeValidDocPayload();
		corruptedPath.handoff.effectivePaths['T-1'] = ['../outside.ts'];
		currentContent = `window.DOCS = ${JSON.stringify(corruptedPath)};`;
		clock.current = '2026-09-08T13:00:00.000Z';

		try {
			await service.importDocument('/app/docs-data.js');
			expect.unreachable('Should have thrown on path traversal');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}

		doc = service.getDocumentById(docId);
		expect(doc?.isSourceReadable).toBe(false);
		expect(doc?.lastSeenAt).toBe('2026-09-08T13:00:00.000Z');

		currentContent = `window.DOCS = ${JSON.stringify(makeValidDocPayload())};`;
		clock.current = '2026-09-08T14:00:00.000Z';
		const recovered = await service.importDocument('/app/docs-data.js');
		expect(recovered.document.isSourceReadable).toBe(true);
		expect(recovered.document.lastSeenAt).toBe('2026-09-08T14:00:00.000Z');
	});
});

describe('documents repository Row and error boundary', () => {
	it('repo/documents only operates on snake_case DocumentRow and wraps SQLite errors as AppError', () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);

		const row1: DocumentRow = {
			id: 'doc-row-1',
			docs_path: '/path/row1.js',
			project_name: '测试行',
			repo_path: 'repo1',
			main_branch: 'main',
			branch_prefix: 'task/',
			lane_count: 2,
			content_fingerprint: 'fp-1',
			is_source_readable: 1,
			is_takeover_notified: 0,
			imported_at: '2026-09-08T00:00:00.000Z',
			last_seen_at: '2026-09-08T00:00:00.000Z',
		};

		documentsRepo.insert(row1);

		const fetched = documentsRepo.findById('doc-row-1');
		expect(fetched).not.toBeNull();
		expect(fetched?.docs_path).toBe('/path/row1.js');
		expect(fetched?.project_name).toBe('测试行');
		expect(fetched?.is_source_readable).toBe(1);

		let error: unknown;
		try {
			documentsRepo.insert(row1);
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(AppError);
		expect((error as AppError).code).toBe('E_INTERNAL');
		expect((error as AppError).cause).toBeDefined();

		expect(() =>
			documentsRepo.insert({
				...row1,
				id: 'doc-row-2',
				docs_path: '/path/row2.js',
				lane_count: 0,
			}),
		).toThrowError(AppError);

		expect(() => documentsRepo.updateLaneCount('doc-row-1', 99)).toThrowError(AppError);

		expect(fetched).not.toBeNull();
		if (!fetched) return;
		const mapped = mapDocumentRow(fetched);
		expect(mapped.docsPath).toBe('/path/row1.js');
		expect(mapped.projectName).toBe('测试行');
		expect(mapped.isSourceReadable).toBe(true);
		expect(mapped.isTakeoverNotified).toBe(false);
	});
});

describe('DocsService document lifecycle (E-79, E-82, E-247)', () => {
	it('uses product lane_count defaults and preserves user changes across imports', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		const payload = makeValidDocPayload();
		const service = createDocsService({
			documentsRepo,
			clock,
			ids: { newId: () => 'doc-lanes' },
			fs: {
				async readFile() {
					return `window.DOCS = ${JSON.stringify(payload)};`;
				},
			},
		});

		const first = await service.importDocument('/app/lanes/docs-data.js');
		expect(first.document.laneCount).toBe(2);
		service.updateLaneCount(first.document.id, 4);
		clock.current = '2026-09-08T11:00:00.000Z';

		const second = await service.importDocument('/app/lanes/docs-data.js');
		expect(second.isNew).toBe(false);
		expect(second.hasChanged).toBe(false);
		expect(second.document.laneCount).toBe(4);
	});

	it('refreshes readiness metadata without reporting a contract change', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		let currentPayload = makeValidDocPayload({ generated: '2026-09-08T10:00:00.000Z' });
		const service = createDocsService({
			documentsRepo,
			clock,
			ids: { newId: () => 'doc-readiness' },
			fs: {
				async readFile() {
					return `window.DOCS = ${JSON.stringify(currentPayload)};`;
				},
			},
		});

		const first = await service.importDocument('/app/readiness/docs-data.js');
		const initialFingerprint = first.document.contentFingerprint;
		const t2Readiness = currentPayload.handoff.readiness['T-2'];
		expect(t2Readiness).toBeDefined();
		if (!t2Readiness) return;
		currentPayload = makeValidDocPayload({
			generated: '2026-09-08T12:00:00.000Z',
			handoff: {
				...currentPayload.handoff,
				readiness: {
					...currentPayload.handoff.readiness,
					'T-2': { ...t2Readiness, ready: true, reasons: [] },
				},
			},
		});
		clock.current = '2026-09-08T12:00:00.000Z';

		const second = await service.importDocument('/app/readiness/docs-data.js');
		expect(second.hasChanged).toBe(false);
		expect(second.document.contentFingerprint).toBe(initialFingerprint);
		expect(second.document.lastSeenAt).toBe('2026-09-08T12:00:00.000Z');
		expect(second.parsed.taskMap.get('T-2')?.isContractReady).toBe(true);
	});

	it('marks an existing document unreadable when the source file disappears', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		let isMissing = false;
		const service = createDocsService({
			documentsRepo,
			clock,
			ids: { newId: () => 'doc-missing' },
			fs: {
				async readFile() {
					if (isMissing) throw { code: 'ENOENT' };
					return `window.DOCS = ${JSON.stringify(makeValidDocPayload())};`;
				},
			},
		});

		const first = await service.importDocument('/app/missing/docs-data.js');
		isMissing = true;
		clock.current = '2026-09-08T14:00:00.000Z';
		await expect(service.importDocument('/app/missing/docs-data.js')).rejects.toMatchObject({
			code: 'E_DOC_SOURCE_UNREADABLE',
		});

		const retained = service.getDocumentById(first.document.id);
		expect(retained).not.toBeNull();
		expect(retained?.isSourceReadable).toBe(false);
		expect(retained?.lastSeenAt).toBe('2026-09-08T14:00:00.000Z');
	});
});

describe('DocsService real repository docs-data.js integration', () => {
	it('parses and imports real repository docs-data.js with all 78 tasks', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);

		let counter = 0;
		const service = createDocsService({
			documentsRepo,
			clock: { now: () => '2026-09-08T12:00:00.000Z' },
			ids: {
				newId() {
					return `doc-${++counter}`;
				},
			},
		});

		const realDocsPath = resolve(
			__dirname,
			'../../../../docs/Agent任务调度器-开发文档/docs-data.js',
		);
		const result = await service.importDocument(realDocsPath);

		expect(result.isNew).toBe(true);
		expect(result.hasChanged).toBe(true);
		expect(result.document.projectName).toBe('Agent 任务调度器');
		expect(result.document.repoPath).toBe('agent-scheduler');
		expect(result.document.laneCount).toBe(2);
		expect(result.document.isSourceReadable).toBe(true);
		expect(result.parsed.tasks.length).toBe(78);

		// Verify task M1-T1
		const m1t1 = result.parsed.taskMap.get('M1-T1');
		expect(m1t1).toBeDefined();
		expect(m1t1?.batchNo).toBe(1);
		expect(m1t1?.layer).toBe(0);
		expect(m1t1?.deps).toEqual([]);
		expect(m1t1?.implPrompt.length).toBeGreaterThan(50);
		expect(m1t1?.reviewPrompt.length).toBeGreaterThan(50);

		// Verify M3-T1
		const m3t1 = result.parsed.taskMap.get('M3-T1');
		expect(m3t1).toBeDefined();
		expect(m3t1?.batchNo).toBe(3);
		expect(m3t1?.deps).toEqual(['M1-T2']);

		// Re-importing should result in hasChanged: false
		const reimport = await service.importDocument(realDocsPath);
		expect(reimport.isNew).toBe(false);
		expect(reimport.hasChanged).toBe(false);
	});
});

function makeTestTaskInput(overrides: Partial<ParsedDocTaskInput> = {}): ParsedDocTaskInput {
	return {
		id: overrides.id ?? 'M1-T1',
		title: overrides.title ?? '测试任务',
		module: overrides.module ?? 'M1',
		deps: overrides.deps ?? [],
		input: overrides.input ?? '输入说明',
		output: overrides.output ?? '产出说明',
		accept: overrides.accept ?? '验收标准',
		estDays: overrides.estDays ?? 1.5,
		edgeIds: overrides.edgeIds ?? ['E-01'],
		contractHash: overrides.contractHash ?? 'hash-12345',
		isContractReady: overrides.isContractReady ?? true,
		contractReasons: overrides.contractReasons ?? [],
		taskPaths: overrides.taskPaths ?? ['packages/daemon/src/index.ts'],
		implPrompt: overrides.implPrompt ?? '实施提示词',
		reviewPrompt: overrides.reviewPrompt ?? '审查提示词',
	};
}

function insertTestDocument(
	db: DatabaseConnection,
	overrides: Partial<DocumentRow> = {},
): DocumentRow {
	const docRepo = createDocumentsRepo(db);
	const docId = overrides.id ?? 'doc-1';
	const row: DocumentRow = {
		id: docId,
		docs_path: overrides.docs_path ?? `/path/to/docs-${docId}.js`,
		project_name: overrides.project_name ?? 'Test Project',
		repo_path: overrides.repo_path ?? 'test-repo',
		main_branch: overrides.main_branch ?? 'main',
		branch_prefix: overrides.branch_prefix ?? 'task/',
		lane_count: overrides.lane_count ?? 2,
		content_fingerprint: overrides.content_fingerprint ?? `fp-${docId}`,
		is_source_readable: overrides.is_source_readable ?? 1,
		is_takeover_notified: overrides.is_takeover_notified ?? 0,
		imported_at: overrides.imported_at ?? '2026-09-08T00:00:00.000Z',
		last_seen_at: overrides.last_seen_at ?? '2026-09-08T00:00:00.000Z',
	};
	docRepo.insert(row);
	return row;
}

describe('validateTaskDependencies (E-20, E-241, E-242)', () => {
	it('reports clean status when there are no dependency issues', () => {
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: [] }),
			makeTestTaskInput({ id: 'T2', deps: ['T1'] }),
			makeTestTaskInput({ id: 'T3', deps: ['T2'] }),
		];

		const report = validateTaskDependencies(tasks);
		expect(report.hasDependencyIssues).toBe(false);
		expect(report.canAutoDispatch).toBe(true);
		expect(report.ghostDependencies).toEqual([]);
		expect(report.ghostKeys).toEqual([]);
		expect(report.cycleTaskKeys).toEqual([]);
		expect(report.cycles).toEqual([]);
		expect(report.reasons).toEqual([]);
	});

	it('identifies ghost dependencies not found in tasks list (E-242)', () => {
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: ['GHOST_A'] }),
			makeTestTaskInput({ id: 'T2', deps: ['T1', 'GHOST_B'] }),
		];

		const report = validateTaskDependencies(tasks);
		expect(report.hasDependencyIssues).toBe(true);
		expect(report.canAutoDispatch).toBe(false);
		expect(report.ghostDependencies).toEqual([
			{ taskId: 'T1', ghostDepKey: 'GHOST_A' },
			{ taskId: 'T2', ghostDepKey: 'GHOST_B' },
		]);
		expect(report.ghostKeys).toEqual(['GHOST_A', 'GHOST_B']);
		expect(report.cycleTaskKeys).toEqual([]);
		expect(report.reasons).toContain('Task "T1" references non-existent dependency "GHOST_A"');
		expect(report.reasons).toContain('Task "T2" references non-existent dependency "GHOST_B"');
	});

	it('identifies dependency cycles between two tasks (E-241)', () => {
		// A -> B -> A
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'A', deps: ['B'] }),
			makeTestTaskInput({ id: 'B', deps: ['A'] }),
		];

		const report = validateTaskDependencies(tasks);
		expect(report.hasDependencyIssues).toBe(true);
		expect(report.canAutoDispatch).toBe(false);
		expect(report.cycleTaskKeys).toEqual(['A', 'B']);
		expect(report.cycles.length).toBeGreaterThanOrEqual(1);
		expect(report.reasons.some((r) => r.includes('cycle detected'))).toBe(true);
	});

	it('identifies self-cycle (E-241)', () => {
		const tasks: ParsedDocTaskInput[] = [makeTestTaskInput({ id: 'A', deps: ['A'] })];

		const report = validateTaskDependencies(tasks);
		expect(report.hasDependencyIssues).toBe(true);
		expect(report.canAutoDispatch).toBe(false);
		expect(report.cycleTaskKeys).toEqual(['A']);
	});

	it('excludes downstream non-cycle tasks from cycleTaskKeys', () => {
		// A <-> B (cycle), C depends on A (not in cycle)
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'A', deps: ['B'] }),
			makeTestTaskInput({ id: 'B', deps: ['A'] }),
			makeTestTaskInput({ id: 'C', deps: ['A'] }),
		];

		const report = validateTaskDependencies(tasks);
		expect(report.cycleTaskKeys).toEqual(['A', 'B']);
		expect(report.cycleTaskKeys).not.toContain('C');
	});
});

describe('importDocTasks AC 1-7 and boundary coverage', () => {
	it('AC 1 & E-17 & E-82: persists tasks, dependencies, batches, effective paths, contract hash, readiness, and prompts correctly', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac1' });

		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({
				id: 'T1',
				title: '任务1',
				module: 'M1',
				deps: [],
				input: '输入1',
				output: '产出1',
				accept: '条款1',
				estDays: 2.0,
				edgeIds: ['E-17', 'E-82'],
				contractHash: 'hash-t1',
				isContractReady: true,
				contractReasons: [],
				taskPaths: ['packages/daemon/src/file1.ts'],
				implPrompt: '实施提示词1',
				reviewPrompt: '审查提示词1',
			}),
			makeTestTaskInput({
				id: 'T2',
				title: '任务2（待复核）',
				module: 'M1',
				deps: ['T1'],
				input: '输入2',
				output: '产出2',
				accept: '条款2',
				estDays: 1.0,
				edgeIds: ['E-20'],
				contractHash: 'hash-t2',
				isContractReady: false,
				contractReasons: ['待人工复核范围'],
				taskPaths: ['packages/daemon/src/file2.ts'],
				implPrompt: '实施提示词2',
				reviewPrompt: '审查提示词2',
			}),
		];

		const result = importDocTasks(db, { docId: doc.id, tasks });

		expect(result.report.hasDependencyIssues).toBe(false);
		expect(result.report.canAutoDispatch).toBe(true);
		expect(result.tasks.length).toBe(2);
		expect(result.batches.length).toBe(2);

		const t1 = result.tasks.find((t) => t.task_key === 'T1');
		expect(t1).toBeDefined();
		expect(t1?.title).toBe('任务1');
		expect(t1?.module_key).toBe('M1');
		expect(JSON.parse(t1?.deps_json ?? '[]')).toEqual([]);
		expect(t1?.input_text).toBe('输入1');
		expect(t1?.output_text).toBe('产出1');
		expect(t1?.accept_text).toBe('条款1');
		expect(JSON.parse(t1?.edge_ids_json ?? '[]')).toEqual(['E-17', 'E-82']);
		expect(JSON.parse(t1?.task_paths_json ?? '[]')).toEqual(['packages/daemon/src/file1.ts']);
		expect(t1?.contract_hash).toBe('hash-t1');
		expect(t1?.is_contract_ready).toBe(1);
		expect(JSON.parse(t1?.contract_reasons_json ?? '[]')).toEqual([]);
		expect(t1?.est_days).toBe(2.0);
		expect(t1?.impl_prompt).toBe('实施提示词1');
		expect(t1?.review_prompt).toBe('审查提示词1');
		expect(t1?.is_removed_from_doc).toBe(0);

		// T2 is contract_ready = 0 (E-82, E-17)
		const t2 = result.tasks.find((t) => t.task_key === 'T2');
		expect(t2).toBeDefined();
		expect(t2?.is_contract_ready).toBe(0);
		expect(JSON.parse(t2?.contract_reasons_json ?? '[]')).toEqual(['待人工复核范围']);

		// Batches are created with idle state
		const batch1 = result.batches.find((b) => b.batch_no === 1);
		const batch2 = result.batches.find((b) => b.batch_no === 2);
		expect(batch1).toBeDefined();
		expect(batch2).toBeDefined();
		expect(batch1?.state).toBe('idle');
		expect(batch2?.state).toBe('idle');

		// T1 is in batch 1, T2 is in batch 2
		expect(t1?.batch_id).toBe(batch1?.id);
		expect(t2?.batch_id).toBe(batch2?.id);
	});

	it('AC 2 & E-20: dependency issues do not fail import or crash handoff console, and canAutoDispatch is false', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac2' });

		// T1 has ghost dep, T2 & T3 form a cycle, T4 is normal
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: ['GHOST_X'] }),
			makeTestTaskInput({ id: 'T2', deps: ['T3'] }),
			makeTestTaskInput({ id: 'T3', deps: ['T2'] }),
			makeTestTaskInput({ id: 'T4', deps: [] }),
		];

		// Does not throw!
		const result = importDocTasks(db, { docId: doc.id, tasks });

		expect(result.report.hasDependencyIssues).toBe(true);
		expect(result.report.canAutoDispatch).toBe(false);
		expect(result.report.ghostKeys).toContain('GHOST_X');
		expect(result.report.cycleTaskKeys).toContain('T2');
		expect(result.report.cycleTaskKeys).toContain('T3');

		// All 4 tasks successfully persisted to DB despite dirty edges
		expect(result.tasks.length).toBe(4);
		const tasksRepo = createTasksRepo(db);
		const dbTasks = tasksRepo.listByDocId(doc.id);
		expect(dbTasks.length).toBe(4);
	});

	it('AC 3 & E-21 & E-87: isolates multiple documents; task keys do not collide across documents', () => {
		const db = createTestDatabase();
		const docA = insertTestDocument(db, { id: 'doc-A', project_name: 'Project A' });
		const docB = insertTestDocument(db, { id: 'doc-B', project_name: 'Project B' });

		// Both docs have task keys 'M1-T1' and 'M1-T2'
		const tasksA: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'M1-T1', title: 'Task A1', deps: [] }),
			makeTestTaskInput({ id: 'M1-T2', title: 'Task A2', deps: ['M1-T1'] }),
		];
		const tasksB: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'M1-T1', title: 'Task B1', deps: [] }),
			makeTestTaskInput({ id: 'M1-T2', title: 'Task B2', deps: [] }), // In Doc B, M1-T2 has no deps
		];

		const resultA = importDocTasks(db, { docId: docA.id, tasks: tasksA });
		const resultB = importDocTasks(db, { docId: docB.id, tasks: tasksB });

		expect(resultA.tasks.length).toBe(2);
		expect(resultB.tasks.length).toBe(2);

		// Distinct primary keys
		const a1 = resultA.tasks.find((t) => t.task_key === 'M1-T1');
		const b1 = resultB.tasks.find((t) => t.task_key === 'M1-T1');
		expect(a1?.id).not.toBe(b1?.id);
		expect(a1?.title).toBe('Task A1');
		expect(b1?.title).toBe('Task B1');

		// Distinct batches
		expect(resultA.batches.length).toBe(2); // Batch 1 and Batch 2 in Doc A
		expect(resultB.batches.length).toBe(1); // Only Batch 1 in Doc B
		expect(resultA.batches[0]?.doc_id).toBe(docA.id);
		expect(resultB.batches[0]?.doc_id).toBe(docB.id);

		// Queries are scoped by docId
		const tasksRepo = createTasksRepo(db);
		expect(tasksRepo.listByDocId(docA.id).map((t) => t.title)).toEqual(['Task A1', 'Task A2']);
		expect(tasksRepo.listByDocId(docB.id).map((t) => t.title)).toEqual(['Task B1', 'Task B2']);
	});

	it('AC 4 & E-241: dependency cycle is truncated in-place to layer 0 (Batch 1) and tasks are listed in report', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac4' });

		// A -> B -> A; C depends on A
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'A', deps: ['B'] }),
			makeTestTaskInput({ id: 'B', deps: ['A'] }),
			makeTestTaskInput({ id: 'C', deps: ['A'] }),
		];

		const result = importDocTasks(db, { docId: doc.id, tasks });

		expect(result.report.cycleTaskKeys).toEqual(['A', 'B']);
		expect(result.report.canAutoDispatch).toBe(false);

		const batch1 = result.batches.find((b) => b.batch_no === 1);
		const batch2 = result.batches.find((b) => b.batch_no === 2);
		expect(batch1).toBeDefined();
		expect(batch2).toBeDefined();

		const taskA = result.tasks.find((t) => t.task_key === 'A');
		const taskB = result.tasks.find((t) => t.task_key === 'B');
		const taskC = result.tasks.find((t) => t.task_key === 'C');

		// A and B truncated to layer 0 -> land in Batch 1!
		expect(taskA?.batch_id).toBe(batch1?.id);
		expect(taskB?.batch_id).toBe(batch1?.id);

		// C depends on A (layer 0) -> layer 1 -> lands in Batch 2!
		expect(taskC?.batch_id).toBe(batch2?.id);
	});

	it('AC 5 & E-242: ghost dependencies are ignored in layer calculation and listed in import report', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac5' });

		// T1 depends on GHOST_TASK (does not exist). T2 depends on T1.
		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: ['GHOST_TASK'] }),
			makeTestTaskInput({ id: 'T2', deps: ['T1'] }),
		];

		const result = importDocTasks(db, { docId: doc.id, tasks });

		expect(result.report.hasDependencyIssues).toBe(true);
		expect(result.report.canAutoDispatch).toBe(false);
		expect(result.report.ghostDependencies).toEqual([{ taskId: 'T1', ghostDepKey: 'GHOST_TASK' }]);
		expect(result.report.ghostKeys).toEqual(['GHOST_TASK']);

		// GHOST_TASK ignored -> T1 has 0 valid deps -> layer 0 (Batch 1)
		// T2 depends on T1 -> layer 1 (Batch 2)
		const batch1 = result.batches.find((b) => b.batch_no === 1);
		const batch2 = result.batches.find((b) => b.batch_no === 2);
		const t1 = result.tasks.find((t) => t.task_key === 'T1');
		const t2 = result.tasks.find((t) => t.task_key === 'T2');

		expect(t1?.batch_id).toBe(batch1?.id);
		expect(t2?.batch_id).toBe(batch2?.id);
	});

	it('AC 6 & E-243: batch numbers are not persistent identifiers; re-import recalculates batches and preserves task id & manual_state', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac6' });

		// Initial import: T1 (Batch 1), T2 (Batch 2)
		const initialTasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', title: 'Task 1', deps: [] }),
			makeTestTaskInput({ id: 'T2', title: 'Task 2', deps: ['T1'] }),
		];

		const firstImport = importDocTasks(db, { docId: doc.id, tasks: initialTasks });
		const initialT2 = firstImport.tasks.find((t) => t.task_key === 'T2');
		expect(initialT2).toBeDefined();
		const originalT2Id = initialT2?.id;
		const originalBatch2Id = firstImport.batches.find((b) => b.batch_no === 2)?.id;
		expect(initialT2?.batch_id).toBe(originalBatch2Id);

		// Set manual_state on T2
		const tasksRepo = createTasksRepo(db);
		if (originalT2Id) {
			tasksRepo.updateManualState(originalT2Id, 'manual_passed');
		}

		// Re-import with changed dependencies: T2 no longer depends on T1!
		// Now both T1 and T2 belong to Batch 1.
		const updatedTasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', title: 'Task 1 Updated', deps: [] }),
			makeTestTaskInput({ id: 'T2', title: 'Task 2 Updated', deps: [] }),
		];

		const secondImport = importDocTasks(db, { docId: doc.id, tasks: updatedTasks });
		const updatedT2 = secondImport.tasks.find((t) => t.task_key === 'T2');

		// Persistent task id is preserved!
		expect(updatedT2?.id).toBe(originalT2Id);

		// manual_state is preserved!
		expect(updatedT2?.manual_state).toBe('manual_passed');

		// Title updated
		expect(updatedT2?.title).toBe('Task 2 Updated');

		// batch_id updated to batch 1!
		const batch1 = secondImport.batches.find((b) => b.batch_no === 1);
		expect(updatedT2?.batch_id).toBe(batch1?.id);

		// Unused batch 2 was deleted
		expect(secondImport.batches.find((b) => b.batch_no === 2)).toBeUndefined();
	});

	it('AC 7 & E-244: all tasks with no dependencies produce only Batch 1 and do not degrade into a no-batch list', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-ac7' });

		const tasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: [] }),
			makeTestTaskInput({ id: 'T2', deps: [] }),
			makeTestTaskInput({ id: 'T3', deps: [] }),
		];

		const result = importDocTasks(db, { docId: doc.id, tasks });

		// Exactly one batch: Batch 1
		expect(result.batches.length).toBe(1);
		expect(result.batches[0]?.batch_no).toBe(1);
		expect(result.batches[0]?.state).toBe('idle');

		// All tasks have non-null batch_id pointing to Batch 1
		const batchId = result.batches[0]?.id;
		for (const task of result.tasks) {
			expect(task.batch_id).toBe(batchId);
		}
	});

	it('marks tasks that disappeared from doc as is_removed_from_doc = 1 without deleting them (E-18, E-77)', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-removal' });

		// Import 3 tasks
		const initialTasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: [] }),
			makeTestTaskInput({ id: 'T2', deps: [] }),
			makeTestTaskInput({ id: 'T3', deps: [] }),
		];
		importDocTasks(db, { docId: doc.id, tasks: initialTasks });

		// Re-import with T2 removed
		const nextTasks: ParsedDocTaskInput[] = [
			makeTestTaskInput({ id: 'T1', deps: [] }),
			makeTestTaskInput({ id: 'T3', deps: [] }),
		];
		importDocTasks(db, { docId: doc.id, tasks: nextTasks });

		const tasksRepo = createTasksRepo(db);
		const allDbTasks = tasksRepo.listByDocId(doc.id);
		expect(allDbTasks.length).toBe(3);

		const t1 = allDbTasks.find((t) => t.task_key === 'T1');
		const t2 = allDbTasks.find((t) => t.task_key === 'T2');
		const t3 = allDbTasks.find((t) => t.task_key === 'T3');

		expect(t1?.is_removed_from_doc).toBe(0);
		expect(t3?.is_removed_from_doc).toBe(0);
		expect(t2?.is_removed_from_doc).toBe(1); // Marked removed, not deleted!
	});

	it('imports all 78 tasks from real repository docs-data.js into tasks and batches tables', async () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-real-78' });

		const realDocsPath = resolve(
			__dirname,
			'../../../../docs/Agent任务调度器-开发文档/docs-data.js',
		);
		const raw = readFileSync(realDocsPath, 'utf8');
		const parsed = parseDocsDataContent(raw, { docsPath: realDocsPath });

		const result = importDocTasks(db, {
			docId: doc.id,
			tasks: parsed.tasks,
		});

		// 78 tasks imported
		expect(result.tasks.length).toBe(78);
		expect(result.report.hasDependencyIssues).toBe(false);
		expect(result.report.canAutoDispatch).toBe(true);
		expect(result.report.ghostDependencies).toEqual([]);
		expect(result.report.cycleTaskKeys).toEqual([]);

		// Verify batches in DB
		const batchesRepo = createBatchesRepo(db);
		const dbBatches = batchesRepo.listByDocId(doc.id);
		expect(dbBatches.length).toBeGreaterThanOrEqual(5);

		// Every task has a valid batch_id pointing to an existing batch
		const batchIdSet = new Set(dbBatches.map((b) => b.id));
		for (const t of result.tasks) {
			expect(t.batch_id).not.toBeNull();
			if (t.batch_id) {
				expect(batchIdSet.has(t.batch_id)).toBe(true);
			}
			expect(t.impl_prompt?.length).toBeGreaterThan(50);
			expect(t.review_prompt?.length).toBeGreaterThan(50);
			expect(t.contract_hash.length).toBeGreaterThan(10);
		}

		// Check specific tasks
		const m1t1 = result.tasks.find((t) => t.task_key === 'M1-T1');
		expect(m1t1).toBeDefined();
		const m1t1Batch = dbBatches.find((b) => b.id === m1t1?.batch_id);
		expect(m1t1Batch?.batch_no).toBe(1);

		const m3t1 = result.tasks.find((t) => t.task_key === 'M3-T1');
		expect(m3t1).toBeDefined();
		const m3t1Batch = dbBatches.find((b) => b.id === m3t1?.batch_id);
		expect(m3t1Batch?.batch_no).toBe(3);
	});
});

describe('BatchesRepo & TasksRepo direct CRUD and validation', () => {
	it('BatchesRepo validates batch_no and state constraints', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-batch-crud' });
		const batchesRepo = createBatchesRepo(db);

		// Invalid batch_no (< 1)
		expect(() =>
			batchesRepo.insert({
				id: 'b-inv',
				doc_id: doc.id,
				batch_no: 0,
				state: 'idle',
			}),
		).toThrowError(/Invalid batch_no/);

		// Invalid state
		expect(() =>
			batchesRepo.insert({
				id: 'b-inv2',
				doc_id: doc.id,
				batch_no: 1,
				state: 'unknown_state' as unknown as 'idle',
			}),
		).toThrowError(/Invalid batch state/);

		// Valid insert and queries
		batchesRepo.insert({
			id: 'b-1',
			doc_id: doc.id,
			batch_no: 1,
			state: 'idle',
		});
		const found = batchesRepo.findById('b-1');
		expect(found?.batch_no).toBe(1);
		expect(found?.state).toBe('idle');

		// Update state
		batchesRepo.updateState({
			id: 'b-1',
			state: 'running',
			started_at: '2026-09-08T10:00:00.000Z',
		});
		const running = batchesRepo.findById('b-1');
		expect(running?.state).toBe('running');
		expect(running?.started_at).toBe('2026-09-08T10:00:00.000Z');

		// findByDocAndBatchNo
		const byNo = batchesRepo.findByDocAndBatchNo(doc.id, 1);
		expect(byNo?.id).toBe('b-1');

		// deleteById
		batchesRepo.deleteById('b-1');
		expect(batchesRepo.findById('b-1')).toBeNull();
	});

	it('TasksRepo provides CRUD operations and query helpers', () => {
		const db = createTestDatabase();
		const doc = insertTestDocument(db, { id: 'doc-task-crud' });
		const tasksRepo = createTasksRepo(db);

		tasksRepo.insert({
			id: 't-1',
			doc_id: doc.id,
			task_key: 'M1-T1',
			title: 'Task 1',
			module_key: 'M1',
			deps_json: '[]',
			contract_hash: 'hash-1',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});

		const found = tasksRepo.findById('t-1');
		expect(found?.task_key).toBe('M1-T1');
		expect(found?.title).toBe('Task 1');

		const byDocAndKey = tasksRepo.findByDocAndKey(doc.id, 'M1-T1');
		expect(byDocAndKey?.id).toBe('t-1');

		// Update manual state
		tasksRepo.updateManualState('t-1', 'passed');
		expect(tasksRepo.findById('t-1')?.manual_state).toBe('passed');

		// Delete by id
		tasksRepo.deleteById('t-1');
		expect(tasksRepo.findById('t-1')).toBeNull();
	});
});
