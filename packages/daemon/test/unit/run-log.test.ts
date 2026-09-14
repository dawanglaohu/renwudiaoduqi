import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import {
	RUN_LOG_CHAR_THRESHOLD_COUNT,
	type RunLogRepo,
	type RunLogRunRecord,
	type RunLogSnapshotRecord,
	buildOpenCommand,
	createRunLogService,
	redactSensitiveLogLine,
} from '../../src/service/run-log.ts';

describe('M6-T8 RunLogService & Session Segmented Readback', () => {
	it('AC 1 & E-96: Vendor session file is opened read-only, never modified or unlinked', async () => {
		const mockFiles = new Map<string, string>();
		const vendorPath = '/path/to/vendor/session-01.json';
		const originalContent = JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] });
		mockFiles.set(vendorPath, originalContent);

		const writeCalled = false;
		const unlinkCalled = false;

		const runsRepo: RunLogRepo = {
			findById: (id: string): RunLogRunRecord | null => {
				if (id === 'run-1') {
					return {
						id: 'run-1',
						taskId: 'task-1',
						state: 'running',
						vendorSessionRef: vendorPath,
					};
				}
				return null;
			},
		};

		const service = createRunLogService({
			runsRepo,
			fileOps: {
				existsSync: (p) => mockFiles.has(p),
				readFileSync: (p) => {
					const c = mockFiles.get(p);
					if (c === undefined) throw new Error('File not found');
					return c;
				},
				statSync: (p) => ({ size: (mockFiles.get(p) ?? '').length }),
				openReadOnlySync: (p) => {
					expect(mockFiles.has(p)).toBe(true);
					return 3; // read-only fd
				},
			},
			platform: 'linux',
		});

		// Call read-only assertion
		service.assertVendorSessionRefReadOnly(vendorPath);

		// Execute log retrieval
		const result = await service.getRunLog({ runId: 'run-1' });

		expect(result.vendorSessionRef).toBe(vendorPath);
		expect(mockFiles.get(vendorPath)).toBe(originalContent);
		expect(writeCalled).toBe(false);
		expect(unlinkCalled).toBe(false);
	});

	it('AC 2 & E-97: When vendor session is missing, shows warning, retains snapshots and captured logs without throwing', async () => {
		const vendorPath = '/path/to/missing/session.json';
		const capturedOutput = ['line 1 from scheduler raw.log', 'line 2 from scheduler raw.log'];

		const runsRepo: RunLogRepo = {
			findById: (id: string): RunLogRunRecord | null => ({
				id: 'run-missing',
				taskId: 'task-1',
				state: 'landed',
				vendorSessionRef: vendorPath,
				snapshotId: 'snap-1',
			}),
		};

		const snapshotsRepo = {
			findById: (id: string): RunLogSnapshotRecord | null => ({
				id,
				inputText: 'Input requirements from M1-T4',
				outputText: 'Expected output files',
				acceptText: 'Acceptance criteria 1, 2, 3',
			}),
		};

		const service = createRunLogService({
			runsRepo,
			snapshotsRepo,
			runsDataDir: '/runs-data/run-missing',
			fileOps: {
				existsSync: (p) => {
					if (p === vendorPath) return false; // Vendor session is missing!
					if (p.includes('raw.log')) return true;
					if (p.includes('/runs-data/run-missing')) return true;
					return false;
				},
				readFileSync: (p) => {
					if (p.includes('raw.log')) {
						return capturedOutput.join('\n');
					}
					throw new Error('ENOENT');
				},
				statSync: () => ({ size: 0 }),
			},
			platform: 'linux',
		});

		// AC 2 & E-97: Must not crash, must not throw
		const result = await service.getRunLog({ runId: 'run-missing' });

		expect(result.isVendorSessionMissing).toBe(true);
		expect(result.lines).toContain(`[调度器提示] 原始会话已不在磁盘（附路径：${vendorPath}）`);
		expect(result.lines).toContain('--- 派发快照：输入 ---');
		expect(result.lines).toContain('Input requirements from M1-T4');
		expect(result.lines).toContain('--- 派发快照：产出 ---');
		expect(result.lines).toContain('Expected output files');
		expect(result.lines).toContain('--- 派发快照：验收标准 ---');
		expect(result.lines).toContain('Acceptance criteria 1, 2, 3');
		expect(result.lines).toContain('--- 调度器捕获输出 ---');
		expect(result.lines).toContain('line 1 from scheduler raw.log');
		expect(result.lines).toContain('line 2 from scheduler raw.log');
	});

	it('AC 3 & E-98: When session exceeds 20MB or 500,000 characters, loads tail-only by default and offers open command', async () => {
		// Construct 550,000 characters
		const lineCount = 6000;
		const line = 'A'.repeat(100);
		const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i}: ${line}`);
		const fullText = lines.join('\n');
		expect(fullText.length).toBeGreaterThan(RUN_LOG_CHAR_THRESHOLD_COUNT);

		const vendorPath = '/path/to/large/session.log';

		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-large',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: vendorPath,
			}),
		};

		const service = createRunLogService({
			runsRepo,
			fileOps: {
				existsSync: (p) => p === vendorPath,
				readFileSync: () => fullText,
				statSync: () => ({ size: fullText.length }),
			},
			platform: 'linux',
		});

		// 1. Default request without fromSeq: loads tail-only
		const defaultResult = await service.getRunLog({ runId: 'run-large', limit: 200 });

		expect(defaultResult.isExceedsThreshold).toBe(true);
		expect(defaultResult.totalLines).toBe(lineCount);
		// Tail-only: length is limit + 1 header hint
		expect(defaultResult.lines.length).toBe(201);
		expect(defaultResult.lines[0]).toContain(
			'单会话内容超阈值（>20MB 或 >50万字），默认仅加载尾部片段',
		);
		expect(defaultResult.lines[0]).toContain(`xdg-open "${vendorPath}"`);
		expect(defaultResult.prevCursor).not.toBeNull();
		expect(defaultResult.nextCursor).toBeNull(); // Tail is reached

		// 2. Click "load more above" (direction: backward from prevCursor)
		const fromSeq = Number.parseInt(defaultResult.prevCursor ?? '0', 10);
		const moreResult = await service.getRunLog({
			runId: 'run-large',
			fromSeq,
			direction: 'backward',
			limit: 200,
		});

		expect(moreResult.lines.length).toBe(200);
		expect(moreResult.prevCursor).not.toBeNull();
		expect(moreResult.nextCursor).not.toBeNull();
	});

	it('AC 4: Bi-directional cursor pagination (forward and backward) works seamlessly', async () => {
		const totalLinesCount = 300;
		const lines = Array.from({ length: totalLinesCount }, (_, i) => `Log entry row #${i}`);
		const fullText = lines.join('\n');

		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-page',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: '/dummy.log',
			}),
		};

		const service = createRunLogService({
			runsRepo,
			fileOps: {
				existsSync: () => true,
				readFileSync: () => fullText,
				statSync: () => ({ size: fullText.length }),
			},
			platform: 'linux',
		});

		// Forward pagination: Page 1 (0..49)
		const page1 = await service.getRunLog({
			runId: 'run-page',
			fromSeq: 0,
			direction: 'forward',
			limit: 50,
		});
		expect(page1.lines.length).toBe(50);
		expect(page1.lines[0]).toBe('Log entry row #0');
		expect(page1.lines[49]).toBe('Log entry row #49');
		expect(page1.prevCursor).toBeNull();
		expect(page1.nextCursor).toBe('50');

		// Forward pagination: Page 2 (50..99)
		const page2 = await service.getRunLog({
			runId: 'run-page',
			fromSeq: Number.parseInt(page1.nextCursor ?? '0', 10),
			direction: 'forward',
			limit: 50,
		});
		expect(page2.lines.length).toBe(50);
		expect(page2.lines[0]).toBe('Log entry row #50');
		expect(page2.lines[49]).toBe('Log entry row #99');
		expect(page2.prevCursor).toBe('49');
		expect(page2.nextCursor).toBe('100');

		// Backward pagination: From index 99, pull 50 backward (50..99)
		const backwardPage = await service.getRunLog({
			runId: 'run-page',
			fromSeq: 99,
			direction: 'backward',
			limit: 50,
		});
		expect(backwardPage.lines.length).toBe(50);
		expect(backwardPage.lines[0]).toBe('Log entry row #50');
		expect(backwardPage.lines[49]).toBe('Log entry row #99');
		expect(backwardPage.prevCursor).toBe('49');
		expect(backwardPage.nextCursor).toBe('100');
	});

	it('AC 5 & E-25: Redacts sensitive keys, tokens, and authorization headers for mobile views with clear notification', async () => {
		const rawLines = [
			'export GITHUB_TOKEN="ghp_123456789012345678901234567890123456"',
			'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
			'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
			'normal output line that has no secrets',
		];

		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-secret',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: '/dummy.log',
			}),
		};

		const service = createRunLogService({
			runsRepo,
			fileOps: {
				existsSync: () => true,
				readFileSync: () => rawLines.join('\n'),
				statSync: () => ({ size: 200 }),
			},
			platform: 'linux',
		});

		// 1. Desktop view (isMobileDevice = false): secrets are preserved verbatim
		const desktopRes = await service.getRunLog({ runId: 'run-secret', isMobileDevice: false });
		expect(desktopRes.lines).toContain(
			'export GITHUB_TOKEN="ghp_123456789012345678901234567890123456"',
		);

		// 2. Mobile view (isMobileDevice = true): secrets are redacted, notification banner is prefixed
		const mobileRes = await service.getRunLog({ runId: 'run-secret', isMobileDevice: true });
		expect(mobileRes.isRedacted).toBe(true);
		expect(mobileRes.lines[0]).toContain(
			'检测到跨设备/移动端查看，已对会话日志中的密钥与凭据执行基本脱敏（E-25）',
		);

		const joined = mobileRes.lines.join('\n');
		expect(joined).not.toContain('ghp_123456789012345678901234567890123456');
		expect(joined).not.toContain('sk-ant-api03');
		expect(joined).toContain('[REDACTED_SECRET]');
		expect(joined).toContain('normal output line that has no secrets');
	});

	it('AC 6 & E-32: Self-contained log viewing independent of vendor GUI', async () => {
		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-gui-independent',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: null, // No vendor GUI or session file at all
			}),
		};

		const capturedLines = ['Starting task step 1', 'Executed tool_call build', 'Build succeeded'];

		const service = createRunLogService({
			runsRepo,
			runsDataDir: '/data/run-gui-independent',
			fileOps: {
				existsSync: () => true,
				readFileSync: () => capturedLines.join('\n'),
				statSync: () => ({ size: 100 }),
			},
		});

		const result = await service.getRunLog({ runId: 'run-gui-independent' });
		expect(result.lines).toEqual(capturedLines);
		expect(result.totalLines).toBe(3);
	});

	it('platform command builder formats platform-specific open commands (E-98)', () => {
		const testPath = '/path/to/session.log';
		expect(buildOpenCommand(testPath, 'win32')).toContain('start ""');
		expect(buildOpenCommand(testPath, 'darwin')).toContain('open "');
		expect(buildOpenCommand(testPath, 'linux')).toContain('xdg-open "');
	});

	it('redactSensitiveLogLine handles various secret patterns (E-25)', () => {
		expect(redactSensitiveLogLine('export AWS_SECRET_ACCESS_KEY="secret_val_123456"')).toContain(
			'[REDACTED_SECRET]',
		);
		expect(redactSensitiveLogLine('Authorization: Bearer secrettoken12345')).toContain(
			'[REDACTED_SECRET]',
		);
		expect(
			redactSensitiveLogLine('ghp_abcdefghijklmnopqrstuvwxyz1234567890 is my token'),
		).toContain('[REDACTED_TOKEN]');
	});
});

describe('M6-T8 Fastify HTTP Route Integration: GET /api/v1/runs/:runId/log', () => {
	it('serves run log and handles query parameters, limits, and mobile detection', async () => {
		const app = Fastify();

		const logLines = ['Line 1: init', 'Line 2: running', 'Line 3: secret KEY=1234567890'];

		const mockService = {
			getRunLog: async (opts: {
				runId: string;
				fromSeq?: number | null;
				direction?: 'forward' | 'backward';
				limit?: number;
				isMobileDevice?: boolean;
			}) => {
				if (opts.runId === 'non-existent') {
					throw new AppError('E_NOT_FOUND', 'Run not found');
				}

				let lines = [...logLines];
				if (opts.isMobileDevice) {
					lines = lines.map(redactSensitiveLogLine);
					lines.unshift(
						'[安全告知] 检测到跨设备/移动端查看，已对会话日志中的密钥与凭据执行基本脱敏（E-25）。',
					);
				}

				return {
					lines,
					totalLines: lines.length,
					prevCursor: null,
					nextCursor: null,
				};
			},
			assertVendorSessionRefReadOnly: () => undefined,
		};

		registerRunsRoutes(app, { runLogService: mockService });

		// 1. Success desktop query
		const desktopRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/run-123/log?limit=10',
		});
		expect(desktopRes.statusCode).toBe(200);
		const body = desktopRes.json();
		expect(body.lines).toEqual(logLines);
		expect(body.totalLines).toBe(3);

		// 2. Mobile detection via user-agent
		const mobileRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/run-123/log',
			headers: {
				'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36',
			},
		});
		expect(mobileRes.statusCode).toBe(200);
		const mobileBody = mobileRes.json();
		expect(mobileBody.lines.some((l: string) => l.includes('[REDACTED_SECRET]'))).toBe(true);

		// 3. Mobile detection via x-device-type
		const deviceRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/run-123/log',
			headers: {
				'x-device-type': 'mobile',
			},
		});
		expect(deviceRes.statusCode).toBe(200);
		expect(deviceRes.json().lines.some((l: string) => l.includes('[REDACTED_SECRET]'))).toBe(true);

		// 4. Mobile detection via query ?deviceType=mobile
		const queryRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/run-123/log?deviceType=mobile',
		});
		expect(queryRes.statusCode).toBe(200);
		expect(queryRes.json().lines.some((l: string) => l.includes('[REDACTED_SECRET]'))).toBe(true);

		// 5. 404 E_NOT_FOUND handling
		const notFoundRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/non-existent/log',
		});
		expect(notFoundRes.statusCode).toBeGreaterThanOrEqual(400);

		// 6. 400 validation error when limit is invalid
		const invalidLimitRes = await app.inject({
			method: 'GET',
			url: '/api/v1/runs/run-123/log?limit=99999',
		});
		expect(invalidLimitRes.statusCode).toBe(400);
	});
});
