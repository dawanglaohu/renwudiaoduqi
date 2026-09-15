import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { errorHandlerPlugin } from '../../src/http/plugins/90-error-handler.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import { createLogstorePaths } from '../../src/logstore/paths.ts';
import {
	type PurgeRunLogsResult,
	type RetentionFileOps,
	type RetentionRunRecord,
	type RetentionRunsRepo,
	type RetentionService,
	type SearchInRunResult,
	createRetentionService,
} from '../../src/service/retention.ts';

describe('M6-T9 Session Retention Policy and Full-Text Search', () => {
	let testDir: string;
	let logstorePaths: ReturnType<typeof createLogstorePaths>;
	let runsData: Map<string, RetentionRunRecord>;
	let runsRepo: RetentionRunsRepo;

	beforeEach(() => {
		testDir = join(
			tmpdir(),
			`retention-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(testDir, { recursive: true });
		logstorePaths = createLogstorePaths(testDir);
		runsData = new Map();

		runsRepo = {
			findById(id: string): RetentionRunRecord | null {
				return runsData.get(id) ?? null;
			},
			findByTaskId(taskId: string): readonly RetentionRunRecord[] {
				return [...runsData.values()]
					.filter((r) => r.taskId === taskId)
					.sort((a, b) => (b.attemptNo ?? 0) - (a.attemptNo ?? 0));
			},
			findCompletedRuns(): readonly RetentionRunRecord[] {
				return [...runsData.values()]
					.filter((r) => r.state === 'landed' || r.state === 'failed' || r.state === 'aborted')
					.sort((a, b) => Date.parse(a.endedAt ?? '0') - Date.parse(b.endedAt ?? '0'));
			},
		};
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Clean up
		}
	});

	function createService(depsOverride?: {
		readonly fileOps?: RetentionFileOps;
		readonly clock?: { readonly now: () => string; readonly nowMs?: () => number };
	}): RetentionService {
		return createRetentionService({
			runsRepo,
			logstorePaths,
			fileOps: depsOverride?.fileOps,
			clock: depsOverride?.clock,
		});
	}

	function writeRunFile(runId: string, fileName: string, content: string): string {
		const runDir = logstorePaths.runDir(runId);
		mkdirSync(runDir, { recursive: true });
		const filePath = join(runDir, fileName);
		writeFileSync(filePath, content, 'utf8');
		return filePath;
	}

	describe('AC 1 & E-105: Log purging clears only captured log text while preserving records', () => {
		it('purges captured log text files and writes tombstone marker', async () => {
			const runId = 'run-term-1';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-1',
				state: 'landed',
				attemptNo: 1,
				snapshotId: 'snap-1',
				startedAt: '2026-09-01T10:00:00.000Z',
				endedAt: '2026-09-01T10:10:00.000Z',
			});

			const rawFile = writeRunFile(runId, 'raw.log', 'line 1\nline 2\n');
			const eventsFile = writeRunFile(runId, 'events.ndjson', '{"seq":0}\n{"seq":1}\n');

			const service = createService();
			const result: PurgeRunLogsResult = await service.purgeRunLogs({ runId });

			expect(result.runId).toBe(runId);
			expect(result.purgedBytes).toBeGreaterThan(0);

			// Tombstone marker created
			expect(service.isLogPurged(runId)).toBe(true);

			// Database metadata is intact and queryable
			const record = runsRepo.findById(runId);
			expect(record).not.toBeNull();
			expect(record?.taskId).toBe('task-1');
			expect(record?.snapshotId).toBe('snap-1');
			expect(record?.state).toBe('landed');
		});

		it('never touches or deletes external vendor session file (E-105, E-96)', async () => {
			const runId = 'run-vendor-1';
			const vendorDir = join(testDir, 'external-vendor');
			mkdirSync(vendorDir, { recursive: true });
			const vendorFile = join(vendorDir, 'claude-session.jsonl');
			writeFileSync(vendorFile, '{"vendor":true}\n', 'utf8');

			runsData.set(runId, {
				id: runId,
				taskId: 'task-2',
				state: 'failed',
				vendorSessionRef: vendorFile,
				snapshotId: 'snap-2',
			});

			writeRunFile(runId, 'raw.log', 'captured raw output\n');

			const service = createService();
			await service.purgeRunLogs({ runId });

			// Vendor session file remains intact
			const fs = await import('node:fs');
			expect(fs.existsSync(vendorFile)).toBe(true);
			expect(fs.readFileSync(vendorFile, 'utf8')).toBe('{"vendor":true}\n');
		});

		it('refuses to purge logs of active runs with E_VALIDATION', async () => {
			const runId = 'run-active-1';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-3',
				state: 'running',
			});
			writeRunFile(runId, 'raw.log', 'in flight log\n');

			const service = createService();
			await expect(service.purgeRunLogs({ runId })).rejects.toThrowError(
				/Cannot purge logs of active run/,
			);
		});

		it('is idempotent on subsequent purge calls', async () => {
			const runId = 'run-idem-1';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-4',
				state: 'landed',
			});
			writeRunFile(runId, 'raw.log', 'data\n');

			const service = createService();
			const res1 = await service.purgeRunLogs({ runId });
			expect(res1.purgedBytes).toBeGreaterThan(0);

			const res2 = await service.purgeRunLogs({ runId });
			expect(res2.purgedBytes).toBe(0);
		});
	});

	describe('AC 2 & E-219: Streaming full-text search with limits, timeouts, and cancellation', () => {
		it('searches line by line and returns matches with line numbers and sequence', async () => {
			const runId = 'run-search-1';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-5',
				state: 'landed',
			});

			const logContent = [
				'2026-09-14 10:00:00 [info] Starting task execution',
				'2026-09-14 10:00:01 [debug] Processing AST node',
				'2026-09-14 10:00:02 [error] Connection failed to repository',
				'2026-09-14 10:00:03 [info] Retrying connection',
				'2026-09-14 10:00:04 [error] Secondary failure detected',
			].join('\n');

			writeRunFile(runId, 'raw.log', logContent);

			const service = createService();
			const result: SearchInRunResult = await service.searchInRun({
				runId,
				query: '[error]',
			});

			expect(result.truncated).toBe(false);
			expect(result.canceled).toBe(false);
			expect(result.hits).toHaveLength(2);
			expect(result.hits[0]?.line).toContain('Connection failed to repository');
			expect(result.hits[0]?.lineNo).toBe(3);
			expect(result.hits[1]?.line).toContain('Secondary failure detected');
			expect(result.hits[1]?.lineNo).toBe(5);
			expect(result.scannedUntilSeq).toBe(5);
		});

		it('enforces search limit of 500 (or custom limit) and sets truncated: true', async () => {
			const runId = 'run-search-limit';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-limit',
				state: 'landed',
			});

			const lines: string[] = [];
			for (let i = 1; i <= 600; i++) {
				lines.push(`Log entry ${i}: keyword match here`);
			}
			writeRunFile(runId, 'raw.log', lines.join('\n'));

			const service = createService();
			// Default max is 500
			const result = await service.searchInRun({
				runId,
				query: 'keyword match',
			});

			expect(result.hits).toHaveLength(500);
			expect(result.truncated).toBe(true);
			expect(result.scannedUntilSeq).toBe(500);

			// Custom lower limit
			const result2 = await service.searchInRun({
				runId,
				query: 'keyword match',
				limit: 25,
			});
			expect(result2.hits).toHaveLength(25);
			expect(result2.truncated).toBe(true);
		});

		it('handles hard timeout by returning partial hits found so far + truncated: true (E-219)', async () => {
			const runId = 'run-search-timeout';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-timeout',
				state: 'landed',
			});

			const lines: string[] = [];
			for (let i = 1; i <= 300; i++) {
				lines.push(`Row ${i}: error occurred in worker process`);
			}
			writeRunFile(runId, 'raw.log', lines.join('\n'));

			let elapsed = 0;
			const nativeFs = await import('node:fs');
			const service = createService({
				clock: {
					now: () => '2026-09-14T12:00:00.000Z',
					nowMs: () => elapsed,
				},
				fileOps: {
					existsSync: nativeFs.existsSync,
					statSync: nativeFs.statSync,
					readRangeSync(path, start, length) {
						elapsed += 80;
						const fd = nativeFs.openSync(path, 'r');
						try {
							const buf = Buffer.alloc(length);
							const bytesRead = nativeFs.readSync(fd, buf, 0, length, start);
							return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
						} finally {
							nativeFs.closeSync(fd);
						}
					},
				},
			});
			const result = await service.searchInRun({
				runId,
				query: 'error',
				timeoutMs: 50,
			});

			expect(result.truncated).toBe(true);
			expect(result.canceled).toBe(false);
			expect(result.hits.length).toBeGreaterThan(0);
		});

		it('allows cancellation via AbortSignal and returns partial hits + canceled: true (E-219)', async () => {
			const runId = 'run-search-cancel';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-cancel',
				state: 'landed',
			});

			const lines: string[] = [];
			for (let i = 1; i <= 500; i++) {
				lines.push(`Line ${i} target match`);
			}
			writeRunFile(runId, 'raw.log', lines.join('\n'));

			const controller = new AbortController();
			const service = createService();

			// Abort immediately
			controller.abort();

			const result = await service.searchInRun({
				runId,
				query: 'target',
				signal: controller.signal,
			});

			expect(result.canceled).toBe(true);
			expect(result.truncated).toBe(true);
		});
	});

	describe('AC 3 & E-220: Snapshot scan at start moment without chasing concurrent writes', () => {
		it('scans only up to the file offset at invocation time and ignores later writes', async () => {
			const runId = 'run-concurrent-1';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-concurrent',
				state: 'running',
			});

			const initialLines = ['Initial line 1: match-target', 'Initial line 2: match-target'].join(
				'\n',
			);
			const filePath = writeRunFile(runId, 'raw.log', initialLines);

			// Mock fileOps that simulates concurrent append during search
			const fs = await import('node:fs');
			let hasAppended = false;
			const customFileOps: RetentionFileOps = {
				existsSync: fs.existsSync,
				statSync: fs.statSync,
				readRangeSync(path, start, length) {
					// Simulate process writing new lines after initial snapshot was taken
					if (!hasAppended) {
						hasAppended = true;
						fs.appendFileSync(
							filePath,
							'\nConcurrent line 3: match-target\nConcurrent line 4: match-target\n',
						);
					}
					const fd = fs.openSync(path, 'r');
					try {
						const buf = Buffer.alloc(length);
						const bytesRead = fs.readSync(fd, buf, 0, length, start);
						return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
					} finally {
						fs.closeSync(fd);
					}
				},
			};

			const service = createService({ fileOps: customFileOps });
			const result = await service.searchInRun({
				runId,
				query: 'match-target',
			});

			// Snapshot only included line 1 and line 2
			expect(result.hits).toHaveLength(2);
			expect(result.hits.every((h) => h.line.startsWith('Initial line'))).toBe(true);
			expect(result.scannedUntilSeq).toBe(2);
		});
	});

	describe('AC 4 & E-221, E-207: Explicit response when log is purged or missing (no 500, no false empty)', () => {
		it('throws E_LOG_PURGED (410) when target session was purged by retention policy (E-221)', async () => {
			const runId = 'run-purged-check';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-purged',
				state: 'landed',
			});
			writeRunFile(runId, 'raw.log', 'something\n');

			const service = createService();
			await service.purgeRunLogs({ runId });

			await expect(service.searchInRun({ runId, query: 'something' })).rejects.toMatchObject({
				code: 'E_LOG_PURGED',
				message: expect.stringContaining('该会话正文已清理'),
			});
		});

		it('throws E_LOG_FILE_MISSING (404) when target log files are missing externally (E-207)', async () => {
			const runId = 'run-missing-external';
			runsData.set(runId, {
				id: runId,
				taskId: 'task-missing',
				state: 'landed',
			});
			// No log files created on disk

			const service = createService();
			await expect(service.searchInRun({ runId, query: 'target' })).rejects.toMatchObject({
				code: 'E_LOG_FILE_MISSING',
			});
		});

		it('throws E_NOT_FOUND (404) when run does not exist', async () => {
			const service = createService();
			await expect(
				service.searchInRun({ runId: 'non-existent', query: 'target' }),
			).rejects.toMatchObject({
				code: 'E_NOT_FOUND',
			});
		});

		it('validates query parameter and rejects empty or oversized query with E_VALIDATION', async () => {
			const runId = 'run-val-1';
			runsData.set(runId, { id: runId, taskId: 't1', state: 'landed' });
			writeRunFile(runId, 'raw.log', 'content\n');

			const service = createService();
			await expect(service.searchInRun({ runId, query: '' })).rejects.toMatchObject({
				code: 'E_VALIDATION',
			});

			await expect(service.searchInRun({ runId, query: 'a'.repeat(201) })).rejects.toMatchObject({
				code: 'E_VALIDATION',
			});
		});
	});

	describe('AC 5 & E-27: Task retries and reruns isolate runs and do not mix streams', () => {
		it('separates latest run from historical runs in task runs summary', () => {
			const taskId = 'task-multirun';
			runsData.set('run-1', {
				id: 'run-1',
				taskId,
				attemptNo: 1,
				state: 'failed',
				startedAt: '2026-09-14T08:00:00.000Z',
			});
			runsData.set('run-2', {
				id: 'run-2',
				taskId,
				attemptNo: 2,
				state: 'failed',
				startedAt: '2026-09-14T09:00:00.000Z',
			});
			runsData.set('run-3', {
				id: 'run-3',
				taskId,
				attemptNo: 3,
				state: 'running',
				startedAt: '2026-09-14T10:00:00.000Z',
			});

			const service = createService();
			const summary = service.getTaskRunsSummary(taskId);

			expect(summary.latestRun?.id).toBe('run-3');
			expect(summary.latestRun?.attemptNo).toBe(3);
			expect(summary.historicalRuns).toHaveLength(2);
			expect(summary.historicalRuns[0]?.id).toBe('run-2');
			expect(summary.historicalRuns[1]?.id).toBe('run-1');
		});

		it('searches only in target run log without cross-polluting other attempts (E-27)', async () => {
			const taskId = 'task-iso';
			runsData.set('run-att-1', {
				id: 'run-att-1',
				taskId,
				attemptNo: 1,
				state: 'failed',
			});
			runsData.set('run-att-2', {
				id: 'run-att-2',
				taskId,
				attemptNo: 2,
				state: 'landed',
			});

			writeRunFile('run-att-1', 'raw.log', 'error in attempt 1\n');
			writeRunFile('run-att-2', 'raw.log', 'success in attempt 2\n');

			const service = createService();

			const res1 = await service.searchInRun({
				runId: 'run-att-1',
				query: 'attempt',
			});
			expect(res1.hits).toHaveLength(1);
			expect(res1.hits[0]?.line).toContain('attempt 1');

			const res2 = await service.searchInRun({
				runId: 'run-att-2',
				query: 'attempt',
			});
			expect(res2.hits).toHaveLength(1);
			expect(res2.hits[0]?.line).toContain('attempt 2');
		});
	});

	describe('Retention Policy Engine (applyRetentionPolicy)', () => {
		it('purges completed runs older than maxDays while skipping recent runs', async () => {
			const now = Date.now();
			const oldTime = new Date(now - 10 * 86400 * 1000).toISOString(); // 10 days ago
			const recentTime = new Date(now - 2 * 86400 * 1000).toISOString(); // 2 days ago

			runsData.set('run-old', {
				id: 'run-old',
				taskId: 't-old',
				state: 'landed',
				endedAt: oldTime,
			});
			runsData.set('run-recent', {
				id: 'run-recent',
				taskId: 't-recent',
				state: 'landed',
				endedAt: recentTime,
			});

			writeRunFile('run-old', 'raw.log', 'old log data\n');
			writeRunFile('run-recent', 'raw.log', 'recent log data\n');

			const service = createService();
			const report = await service.applyRetentionPolicy({ maxDays: 7 });

			expect(report.purgedRuns).toHaveLength(1);
			expect(report.purgedRuns[0]?.runId).toBe('run-old');
			expect(service.isLogPurged('run-old')).toBe(true);
			expect(service.isLogPurged('run-recent')).toBe(false);
		});

		it('purges oldest completed runs when maxTotalBytes threshold is exceeded', async () => {
			const time1 = '2026-09-01T10:00:00.000Z';
			const time2 = '2026-09-02T10:00:00.000Z';
			const time3 = '2026-09-03T10:00:00.000Z';

			runsData.set('run-cap-1', {
				id: 'run-cap-1',
				taskId: 't1',
				state: 'landed',
				endedAt: time1,
			});
			runsData.set('run-cap-2', {
				id: 'run-cap-2',
				taskId: 't2',
				state: 'landed',
				endedAt: time2,
			});
			runsData.set('run-cap-3', {
				id: 'run-cap-3',
				taskId: 't3',
				state: 'landed',
				endedAt: time3,
			});

			// Write 100 bytes to each
			const chunk = 'x'.repeat(100);
			writeRunFile('run-cap-1', 'raw.log', chunk);
			writeRunFile('run-cap-2', 'raw.log', chunk);
			writeRunFile('run-cap-3', 'raw.log', chunk);

			const service = createService();
			// Limit total to 150 bytes -> oldest (run-cap-1) must be purged first
			const report = await service.applyRetentionPolicy({ maxTotalBytes: 150 });

			expect(report.purgedRuns.length).toBeGreaterThanOrEqual(1);
			expect(report.purgedRuns[0]?.runId).toBe('run-cap-1');
			expect(service.isLogPurged('run-cap-1')).toBe(true);
		});
	});

	describe('Fastify HTTP Endpoints: GET /search and DELETE /logs', () => {
		async function createTestServer(retentionService: RetentionService) {
			const app = Fastify();
			await errorHandlerPlugin(app, {});
			registerRunsRoutes(app, { retentionService });
			await app.ready();
			return app;
		}

		it('GET /api/v1/runs/:runId/search returns 200 with hits', async () => {
			const runId = 'run-http-search';
			runsData.set(runId, { id: runId, taskId: 't-http', state: 'landed' });
			writeRunFile(runId, 'raw.log', 'first line\nmatched query here\nthird line\n');

			const service = createService();
			const app = await createTestServer(service);

			const response = await app.inject({
				method: 'GET',
				url: `/api/v1/runs/${runId}/search?q=matched`,
			});

			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.hits).toHaveLength(1);
			expect(body.hits[0].line).toContain('matched query here');
			expect(body.truncated).toBe(false);
			expect(body.canceled).toBe(false);
			await app.close();
		});

		it('GET /api/v1/runs/:runId/search returns 400 E_VALIDATION when q is missing or invalid', async () => {
			const runId = 'run-http-val';
			runsData.set(runId, { id: runId, taskId: 't-http', state: 'landed' });

			const service = createService();
			const app = await createTestServer(service);

			const response = await app.inject({
				method: 'GET',
				url: `/api/v1/runs/${runId}/search`,
			});

			expect(response.statusCode).toBe(400);
			const body = JSON.parse(response.body);
			expect(body.error.code).toBe('E_VALIDATION');
			await app.close();
		});

		it('GET /api/v1/runs/:runId/search returns 410 E_LOG_PURGED when log was purged (E-221)', async () => {
			const runId = 'run-http-purged';
			runsData.set(runId, { id: runId, taskId: 't-http', state: 'landed' });
			writeRunFile(runId, 'raw.log', 'will be purged\n');

			const service = createService();
			await service.purgeRunLogs({ runId });

			const app = await createTestServer(service);
			const response = await app.inject({
				method: 'GET',
				url: `/api/v1/runs/${runId}/search?q=target`,
			});

			expect(response.statusCode).toBe(410);
			const body = JSON.parse(response.body);
			expect(body.error.code).toBe('E_LOG_PURGED');
			await app.close();
		});

		it('DELETE /api/v1/runs/:runId/logs returns 200 with { purgedBytes }', async () => {
			const runId = 'run-http-delete';
			runsData.set(runId, { id: runId, taskId: 't-http', state: 'landed' });
			writeRunFile(runId, 'raw.log', 'some captured logs to delete\n');

			const service = createService();
			const app = await createTestServer(service);

			const response = await app.inject({
				method: 'DELETE',
				url: `/api/v1/runs/${runId}/logs`,
			});

			expect(response.statusCode).toBe(200);
			const body = JSON.parse(response.body);
			expect(body.purgedBytes).toBeGreaterThan(0);

			expect(service.isLogPurged(runId)).toBe(true);
			await app.close();
		});

		it('DELETE /api/v1/runs/:runId/logs returns 404 E_NOT_FOUND when run does not exist', async () => {
			const service = createService();
			const app = await createTestServer(service);

			const response = await app.inject({
				method: 'DELETE',
				url: '/api/v1/runs/non-existent-run/logs',
			});

			expect(response.statusCode).toBe(404);
			const body = JSON.parse(response.body);
			expect(body.error.code).toBe('E_NOT_FOUND');
			await app.close();
		});
	});
});
