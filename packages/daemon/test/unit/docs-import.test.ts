import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import { AppError } from '../../src/errors/app-error.ts';
import { createDocumentsRepo } from '../../src/repo/documents.ts';
import {
	type DocsFileSystem,
	createDocsService,
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
	accept?: string;
	est?: number;
	edges?: string[];
}

interface DocDispatchItem {
	contractHash: string;
	implementation: unknown;
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

describe('service/docs parser (AC 1, AC 2, E-16, E-17, E-82, E-246)', () => {
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

	it('AC 2 throws E_DOC_SOURCE_UNREADABLE if schemaVersion is not 1', () => {
		const payload = makeValidDocPayload({ schemaVersion: 2 });
		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}
	});

	it('AC 2 / E-17 throws E_DOC_SOURCE_UNREADABLE if three hashes mismatch', () => {
		const payload = makeValidDocPayload();
		const contracts = {
			...payload.handoff.contracts,
			'T-1': { hash: 'mismatched-hash', effectivePaths: ['src/a.ts'] },
		};
		payload.handoff = { ...payload.handoff, contracts };

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
			expect((err as AppError).message).toContain('Contract hash mismatch');
		}
	});

	it('AC 2 / E-17 throws E_DOC_SOURCE_UNREADABLE if readiness hash mismatches dispatch hash', () => {
		const payload = makeValidDocPayload();
		const readiness = {
			...payload.handoff.readiness,
			'T-1': { ready: true, contractHash: 'readiness-different', reasons: [] },
		};
		payload.handoff = { ...payload.handoff, readiness };

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
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

	it('throws E_DOC_SOURCE_UNREADABLE when required fields or task dispatch is missing', () => {
		const payload = makeValidDocPayload();
		const t1 = payload.dispatch['T-1'];
		if (!t1) throw new Error('T-1 dispatch item missing');
		payload.dispatch = {
			'T-1': t1,
		};

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
			expect((err as AppError).message).toContain('Missing dispatch package');
		}
	});

	it('throws E_DOC_SOURCE_UNREADABLE when prompts are missing or not strings', () => {
		const payload = makeValidDocPayload();
		const t1 = payload.dispatch['T-1'];
		if (!t1) throw new Error('T-1 dispatch item missing');
		payload.dispatch['T-1'] = {
			...t1,
			implementation: 12345,
		};

		try {
			parseDocsDataContent(`window.DOCS = ${JSON.stringify(payload)};`);
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}
	});
});

describe('DocsService document lifecycle and repository sync (AC 3, AC 4, AC 6, E-79, E-82, E-247)', () => {
	it('AC 6 / E-247 imports new document with lane_count=2 and preserves it on re-import', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);

		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		const ids = {
			counter: 0,
			newId() {
				return `doc-${++this.counter}`;
			},
		};

		const payload = makeValidDocPayload();
		const mockFs: DocsFileSystem = {
			async readFile() {
				return `window.DOCS = ${JSON.stringify(payload)};`;
			},
		};

		const service = createDocsService({
			documentsRepo,
			clock,
			ids,
			fs: mockFs,
		});

		// First import
		const res1 = await service.importDocument('/path/to/docs-data.js');
		expect(res1.isNew).toBe(true);
		expect(res1.hasChanged).toBe(true);
		expect(res1.document.laneCount).toBe(2);
		expect(res1.document.isSourceReadable).toBe(true);
		expect(res1.document.importedAt).toBe('2026-09-08T10:00:00.000Z');

		// User updates lane_count to 4 in our system
		service.updateLaneCount(res1.document.id, 4);
		const updated = service.getDocumentById(res1.document.id);
		expect(updated?.laneCount).toBe(4);

		// Re-import with same content: laneCount must remain 4, not reset (E-247)
		clock.current = '2026-09-08T11:00:00.000Z';
		const res2 = await service.importDocument('/path/to/docs-data.js');
		expect(res2.isNew).toBe(false);
		expect(res2.hasChanged).toBe(false);
		expect(res2.document.laneCount).toBe(4);
		expect(res2.document.lastSeenAt).toBe('2026-09-08T11:00:00.000Z');
	});

	it('E-247 rejects invalid lane_count with E_VALIDATION', () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const service = createDocsService({
			documentsRepo,
			clock: { now: () => '2026-09-08T00:00:00.000Z' },
			ids: { newId: () => 'id' },
		});

		expect(() => service.updateLaneCount('unused', 0)).toThrowError(AppError);
		expect(() => service.updateLaneCount('unused', 7)).toThrowError(AppError);
	});

	it('AC 3 / E-79 does not report change when only timestamp or ready/reasons change, but refreshes metadata', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		const ids = {
			counter: 0,
			newId() {
				return `doc-${++this.counter}`;
			},
		};

		let currentPayload = makeValidDocPayload({ generated: '2026-09-08T10:00:00.000Z' });
		const mockFs: DocsFileSystem = {
			async readFile() {
				return `window.DOCS = ${JSON.stringify(currentPayload)};`;
			},
		};

		const service = createDocsService({
			documentsRepo,
			clock,
			ids,
			fs: mockFs,
		});

		const res1 = await service.importDocument('/app/docs-data.js');
		const initialFingerprint = res1.document.contentFingerprint;

		// Document rebuilt with updated timestamp and T-2 became ready, but contract hashes are identical!
		clock.current = '2026-09-08T12:00:00.000Z';
		const updatedReadiness = {
			...currentPayload.handoff.readiness,
			'T-2': { ready: true, contractHash: 'hash-t2', reasons: [] },
		};
		currentPayload = makeValidDocPayload({
			generated: '2026-09-08T12:00:00.000Z',
			handoff: {
				...currentPayload.handoff,
				readiness: updatedReadiness,
			},
		});

		const res2 = await service.importDocument('/app/docs-data.js');
		// E-79: Fingerprint is identical -> hasChanged is false!
		expect(res2.hasChanged).toBe(false);
		expect(res2.document.contentFingerprint).toBe(initialFingerprint);
		// But document metadata refreshed with current timestamp
		expect(res2.document.lastSeenAt).toBe('2026-09-08T12:00:00.000Z');
		expect(res2.parsed.taskMap.get('T-2')?.isContractReady).toBe(true);
	});

	it('AC 4 / E-82 marks source unreadable, retains records and clears nothing when file fails', async () => {
		const db = createTestDatabase();
		const documentsRepo = createDocumentsRepo(db);
		const clock = {
			current: '2026-09-08T10:00:00.000Z',
			now() {
				return this.current;
			},
		};
		const ids = {
			counter: 0,
			newId() {
				return `doc-${++this.counter}`;
			},
		};

		let shouldFail = false;
		const mockFs: DocsFileSystem = {
			async readFile() {
				if (shouldFail) {
					const err = new Error('ENOENT: no such file or directory');
					Object.assign(err, { code: 'ENOENT' });
					throw err;
				}
				return `window.DOCS = ${JSON.stringify(makeValidDocPayload())};`;
			},
		};

		const service = createDocsService({
			documentsRepo,
			clock,
			ids,
			fs: mockFs,
		});

		// Successful initial import
		const res1 = await service.importDocument('/app/docs-data.js');
		expect(res1.document.isSourceReadable).toBe(true);

		// Now file becomes unreadable / deleted
		shouldFail = true;
		clock.current = '2026-09-08T14:00:00.000Z';

		try {
			await service.importDocument('/app/docs-data.js');
			expect.unreachable('Should have thrown');
		} catch (err) {
			expect((err as AppError).code).toBe('E_DOC_SOURCE_UNREADABLE');
		}

		// Check DB: document still exists (not deleted), but is_source_readable is 0
		const docAfterFailure = service.getDocumentById(res1.document.id);
		expect(docAfterFailure).not.toBeNull();
		expect(docAfterFailure?.isSourceReadable).toBe(false);
		expect(docAfterFailure?.lastSeenAt).toBe('2026-09-08T14:00:00.000Z');

		// File is restored: re-import succeeds and restores is_source_readable = 1
		shouldFail = false;
		clock.current = '2026-09-08T15:00:00.000Z';
		const res3 = await service.importDocument('/app/docs-data.js');
		expect(res3.document.isSourceReadable).toBe(true);
		expect(res3.document.lastSeenAt).toBe('2026-09-08T15:00:00.000Z');
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
