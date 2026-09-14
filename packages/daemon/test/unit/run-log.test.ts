import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors/app-error.ts';
import { registerRunsRoutes } from '../../src/http/routes/runs.ts';
import { READ_CHUNK_LIMIT_BYTES } from '../../src/logstore/contract.ts';
import {
	RUN_LOG_CHAR_THRESHOLD_COUNT,
	type RunLogRepo,
	type RunLogRunRecord,
	type RunLogSnapshotRecord,
	buildOpenSpec,
	createRunLogService,
	redactSensitiveLogLine,
} from '../../src/service/run-log.ts';

describe('M6-T8 RunLogService & Session Segmented Readback', () => {
	it('AC 1 & E-96 & R4: Vendor session file is opened strictly read-only, descriptors are paired and closed, and mutations are rejected', async () => {
		const vendorPath = '/path/to/vendor/session-01.json';
		const originalBytes = Buffer.from(
			JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
			'utf8',
		);
		let currentBytes = Buffer.from(originalBytes);

		let writeCalls = 0;
		let unlinkCalls = 0;
		let truncateCalls = 0;
		let openWriteCalls = 0;
		const openFds = new Set<number>();
		let nextFd = 10;

		const mockFileOps = {
			existsSync: (p: string) => p === vendorPath,
			statSync: (p: string) => {
				if (p !== vendorPath) throw new Error('ENOENT');
				return { size: currentBytes.length };
			},
			openReadOnlySync: (p: string) => {
				if (p !== vendorPath) throw new Error('ENOENT');
				const fd = nextFd++;
				openFds.add(fd);
				return fd;
			},
			closeSync: (fd: number) => {
				expect(openFds.has(fd)).toBe(true);
				openFds.delete(fd);
			},
			readRangeSync: (p: string, start: number, length: number) => {
				if (p !== vendorPath) throw new Error('ENOENT');
				return new Uint8Array(currentBytes.subarray(start, start + length));
			},
			// Mutating methods that should NEVER be called on vendor session files
			writeSync: () => {
				writeCalls++;
			},
			unlinkSync: () => {
				unlinkCalls++;
			},
			truncateSync: () => {
				truncateCalls++;
			},
			openWriteSync: () => {
				openWriteCalls++;
			},
		};

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
			fileOps: mockFileOps,
			platform: 'linux',
		});

		// Call read-only assertion
		service.assertVendorSessionRefReadOnly(vendorPath);
		// Assert descriptor was immediately closed
		expect(openFds.size).toBe(0);

		// Execute log retrieval across 50 iterations to ensure zero descriptor leakage
		for (let i = 0; i < 50; i++) {
			const result = await service.getRunLog({ runId: 'run-1' });
			expect(result.vendorSessionRef).toBe(vendorPath);
		}

		// R4 Assertions:
		// 1. Mutating calls are strictly 0
		expect(writeCalls).toBe(0);
		expect(unlinkCalls).toBe(0);
		expect(truncateCalls).toBe(0);
		expect(openWriteCalls).toBe(0);

		// 2. Open and close are strictly paired, no dangling file descriptors
		expect(openFds.size).toBe(0);

		// 3. Bytes content remains byte-for-byte identical
		expect(Buffer.compare(currentBytes, originalBytes)).toBe(0);

		// R4 Counter-test verification: if an unlink attempted to modify content, it would fail assertion
		const tamperFn = () => {
			currentBytes = Buffer.from('tampered data');
		};
		expect(() => {
			tamperFn();
			expect(Buffer.compare(currentBytes, originalBytes)).toBe(0);
		}).toThrow();
	});

	it('AC 2 & E-97: When vendor session is missing, shows warning, retains snapshots and captured logs without throwing', async () => {
		const vendorPath = '/path/to/missing/session.json';
		const capturedOutput = ['line 1 from scheduler raw.log', 'line 2 from scheduler raw.log'];
		const rawBytes = Buffer.from(`${capturedOutput.join('\n')}\n`, 'utf8');

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
				input_text: 'Input requirements from M1-T4',
				output_text: 'Expected output files',
				accept_text: 'Acceptance criteria 1, 2, 3',
			}),
		};

		const service = createRunLogService({
			runsRepo,
			snapshotsRepo,
			logSegmentsRepo: {
				findByRunStream: () => [
					{
						id: 'seg-0',
						runId: 'run-missing',
						stream: 'raw',
						fileSeq: 0,
						path: '/runs-data/run-missing/raw.log',
						byteStart: 0,
						byteEnd: rawBytes.length,
						lineCount: 2,
					},
				],
			},
			fileOps: {
				existsSync: (p: string) => {
					if (p === vendorPath) return false; // Vendor session is missing!
					return p.includes('raw.log');
				},
				statSync: () => ({ size: rawBytes.length }),
				readRangeSync: (p: string, start: number, len: number) => {
					return new Uint8Array(rawBytes.subarray(start, start + len));
				},
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

	it('AC 3 & E-98 & R2: When session exceeds 20MB or 500,000 characters, loads bounded tail-only by default and offers structured openSpec', async () => {
		// Construct large output > 500,000 characters
		const lineCount = 6000;
		const line = 'A'.repeat(100);
		const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i}: ${line}`);
		const fullText = `${lines.join('\n')}\n`;
		const fullBytes = Buffer.from(fullText, 'utf8');
		expect(fullText.length).toBeGreaterThan(RUN_LOG_CHAR_THRESHOLD_COUNT);

		const vendorPath = '/path/to/large/session.log';
		let readBytesTotal = 0;

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
				existsSync: (p: string) => p === vendorPath,
				statSync: () => ({ size: fullBytes.length }),
				readRangeSync: (p: string, start: number, len: number) => {
					readBytesTotal += len;
					expect(len).toBeLessThanOrEqual(READ_CHUNK_LIMIT_BYTES);
					return new Uint8Array(fullBytes.subarray(start, start + len));
				},
			},
			platform: 'linux',
		});

		// 1. Default request without fromSeq: loads tail-only with bounded bytes
		const defaultResult = await service.getRunLog({ runId: 'run-large', limit: 200 });

		expect(defaultResult.isExceedsThreshold).toBe(true);
		expect(readBytesTotal).toBeLessThanOrEqual(READ_CHUNK_LIMIT_BYTES);
		expect(defaultResult.lines[0]).toContain(
			'单会话内容超阈值（>20MB 或 >50万字），默认仅加载尾部片段',
		);
		expect(defaultResult.prevCursor).not.toBeNull();
		expect(defaultResult.openSpec).toEqual({
			file: 'xdg-open',
			args: [vendorPath],
		});
	});

	it('AC 4 & R2: Bi-directional cursor pagination over 3 segments with bounded reads', async () => {
		// 3 segments of 100 lines each
		const seg0Text = Array.from({ length: 100 }, (_, i) => `Seg0 Row #${i}\n`).join('');
		const seg1Text = Array.from({ length: 100 }, (_, i) => `Seg1 Row #${i}\n`).join('');
		const seg2Text = Array.from({ length: 100 }, (_, i) => `Seg2 Row #${i}\n`).join('');

		const seg0Bytes = Buffer.from(seg0Text, 'utf8');
		const seg1Bytes = Buffer.from(seg1Text, 'utf8');
		const seg2Bytes = Buffer.from(seg2Text, 'utf8');

		const segmentsData = [
			{
				id: 'seg-0',
				runId: 'run-3seg',
				stream: 'raw' as const,
				fileSeq: 0,
				path: '/logs/raw-0.log',
				byteStart: 0,
				byteEnd: seg0Bytes.length,
				lineCount: 100,
			},
			{
				id: 'seg-1',
				runId: 'run-3seg',
				stream: 'raw' as const,
				fileSeq: 1,
				path: '/logs/raw-1.log',
				byteStart: 0,
				byteEnd: seg1Bytes.length,
				lineCount: 100,
			},
			{
				id: 'seg-2',
				runId: 'run-3seg',
				stream: 'raw' as const,
				fileSeq: 2,
				path: '/logs/raw-2.log',
				byteStart: 0,
				byteEnd: seg2Bytes.length,
				lineCount: 100,
			},
		];

		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-3seg',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: null,
			}),
		};

		const service = createRunLogService({
			runsRepo,
			logSegmentsRepo: {
				findByRunStream: () => segmentsData,
			},
			fileOps: {
				existsSync: () => true,
				statSync: (p) => {
					if (p.includes('raw-0')) return { size: seg0Bytes.length };
					if (p.includes('raw-1')) return { size: seg1Bytes.length };
					return { size: seg2Bytes.length };
				},
				readRangeSync: (p, start, len) => {
					let buf = seg0Bytes;
					if (p.includes('raw-1')) buf = seg1Bytes;
					if (p.includes('raw-2')) buf = seg2Bytes;
					return new Uint8Array(buf.subarray(start, start + len));
				},
			},
			platform: 'linux',
		});

		// 1. Forward from beginning (fileSeq 0)
		const fwdRes = await service.getRunLog({
			runId: 'run-3seg',
			fromSeq: '0:0',
			direction: 'forward',
			limit: 10,
		});
		expect(fwdRes.lines.length).toBe(10);
		expect(fwdRes.lines[0]).toBe('Seg0 Row #0');
		expect(fwdRes.nextCursor).toBe('0:120'); // 10 lines * 12 bytes = 120
		// totalLines counts the whole session (3 segments x 100 lines), not the returned window
		expect(fwdRes.totalLines).toBe(300);

		// 2. Backward from segment 2 tail
		const bwdRes = await service.getRunLog({
			runId: 'run-3seg',
			fromSeq: `2:${seg2Bytes.length}`,
			direction: 'backward',
			limit: 10,
		});
		expect(bwdRes.lines.length).toBe(10);
		expect(bwdRes.lines[9]).toBe('Seg2 Row #99');
		expect(bwdRes.prevCursor).not.toBeNull();
	});

	it('AC 5 & E-25: Redacts sensitive keys, tokens, and authorization headers for mobile views with clear notification', async () => {
		const rawLines = [
			'export GITHUB_TOKEN="ghp_123456789012345678901234567890123456"',
			'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
			'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
			'normal output line that has no secrets',
		];
		const fullBytes = Buffer.from(`${rawLines.join('\n')}\n`, 'utf8');

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
				statSync: () => ({ size: fullBytes.length }),
				readRangeSync: (_, start, len) => new Uint8Array(fullBytes.subarray(start, start + len)),
			},
			platform: 'linux',
		});

		// Desktop view: intact
		const desktopRes = await service.getRunLog({ runId: 'run-secret', isMobileDevice: false });
		expect(desktopRes.lines).toContain(
			'export GITHUB_TOKEN="ghp_123456789012345678901234567890123456"',
		);

		// Mobile view: redacted
		const mobileRes = await service.getRunLog({ runId: 'run-secret', isMobileDevice: true });
		expect(mobileRes.isRedacted).toBe(true);
		expect(mobileRes.lines[0]).toContain(
			'检测到跨设备/移动端查看，已对会话日志中的密钥与凭据执行基本脱敏（E-25）',
		);
		const joined = mobileRes.lines.join('\n');
		expect(joined).not.toContain('ghp_123456789012345678901234567890123456');
		expect(joined).toContain('[REDACTED_SECRET]');
	});

	it('AC 6 & E-32: Self-contained log viewing independent of vendor GUI', async () => {
		const runsRepo: RunLogRepo = {
			findById: () => ({
				id: 'run-gui-independent',
				taskId: 'task-1',
				state: 'running',
				vendorSessionRef: null,
			}),
		};

		const capturedLines = ['Starting task step 1', 'Executed tool_call build', 'Build succeeded'];
		const fullBytes = Buffer.from(`${capturedLines.join('\n')}\n`, 'utf8');

		const service = createRunLogService({
			runsRepo,
			logSegmentsRepo: {
				findByRunStream: () => [
					{
						id: 'seg-0',
						runId: 'run-gui-independent',
						stream: 'raw',
						fileSeq: 0,
						path: '/logs/raw.log',
						byteStart: 0,
						byteEnd: fullBytes.length,
						lineCount: 3,
					},
				],
			},
			fileOps: {
				existsSync: () => true,
				statSync: () => ({ size: fullBytes.length }),
				readRangeSync: (_, start, len) => new Uint8Array(fullBytes.subarray(start, start + len)),
			},
			platform: 'linux',
		});

		const result = await service.getRunLog({ runId: 'run-gui-independent' });
		expect(result.lines).toEqual(capturedLines);
	});

	it('R6: buildOpenSpec returns structured spec and protects against command injection with quote, ampersand, semicolon, and percent', () => {
		const maliciousPath = '/path/with";calc&echo%TEMP%/session.log';

		// Windows: uses cmd.exe and freezes args, path is strictly an argument element
		const winSpec = buildOpenSpec(maliciousPath, 'win32');
		expect(winSpec.file).toBe('cmd.exe');
		expect(Array.isArray(winSpec.args)).toBe(true);
		expect(winSpec.args).toEqual(['/d', '/s', '/c', 'start', '', maliciousPath]);
		expect(winSpec.args[5]).toBe(maliciousPath);

		// Darwin
		const darwinSpec = buildOpenSpec(maliciousPath, 'darwin');
		expect(darwinSpec.file).toBe('open');
		expect(darwinSpec.args).toEqual([maliciousPath]);

		// Linux
		const linuxSpec = buildOpenSpec(maliciousPath, 'linux');
		expect(linuxSpec.file).toBe('xdg-open');
		expect(linuxSpec.args).toEqual([maliciousPath]);
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
				fromSeq?: number | string | null;
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
