import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { type DocumentRow, createDocumentsRepo } from '../../src/repo/documents.ts';
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
