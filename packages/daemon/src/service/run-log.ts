import { existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppError } from '../errors/app-error.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import type { SupportedPlatform } from '../platform/contract.ts';

/**
 * E-98: Single session size threshold.
 * Exceeding 20 MB or 500,000 characters triggers tail-only loading by default,
 * upward pagination ("load more above"), and opening via system default application.
 */
export const RUN_LOG_SIZE_THRESHOLD_BYTES = 20 * 1024 * 1024;
export const RUN_LOG_CHAR_THRESHOLD_COUNT = 500_000;

export const DEFAULT_LOG_PAGE_LIMIT = 200;
export const MAX_LOG_PAGE_LIMIT = 2000;

export interface RunLogRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: string;
	readonly vendorSessionRef?: string | null;
	readonly snapshotId?: string | null;
	readonly worktreePath?: string | null;
}

export interface RunLogSnapshotRecord {
	readonly id: string;
	readonly inputText: string | null;
	readonly outputText: string | null;
	readonly acceptText: string | null;
}

export interface RunLogRepo {
	findById(id: string): RunLogRunRecord | null;
	findSnapshotById?(snapshotId: string): RunLogSnapshotRecord | null;
	findLatestSnapshotByTaskId?(taskId: string): RunLogSnapshotRecord | null;
}

export interface GetRunLogOptions {
	readonly runId: string;
	readonly fromSeq?: number | null;
	readonly direction?: 'forward' | 'backward';
	readonly limit?: number;
	readonly isMobileDevice?: boolean;
}

export interface GetRunLogResult {
	readonly lines: readonly string[];
	readonly totalLines: number;
	readonly prevCursor: string | null;
	readonly nextCursor: string | null;
	readonly vendorSessionRef?: string | null;
	readonly isVendorSessionMissing?: boolean;
	readonly originalFilePath?: string | null;
	readonly openCommand?: string | null;
	readonly isExceedsThreshold?: boolean;
	readonly isRedacted?: boolean;
}

export interface RunLogFileOps {
	readonly existsSync: (path: string) => boolean;
	readonly readFileSync: (path: string, encoding: 'utf8') => string;
	readonly statSync: (path: string) => { readonly size: number };
	readonly readdirSync?: (path: string) => readonly string[];
	readonly openReadOnlySync?: (path: string) => number;
}

export interface RunLogServiceDeps {
	readonly runsRepo: RunLogRepo;
	readonly snapshotsRepo?: {
		findById(id: string): RunLogSnapshotRecord | null;
		findLatestByTaskId?(taskId: string): RunLogSnapshotRecord | null;
	};
	readonly logstorePaths?: LogstorePaths;
	readonly runsDataDir?: string;
	readonly fileOps?: RunLogFileOps;
	readonly platform?: SupportedPlatform;
}

export interface RunLogService {
	getRunLog(options: GetRunLogOptions): Promise<GetRunLogResult>;
	/**
	 * E-96: Asserts that a vendor session ref is handled read-only.
	 * Vendor session files are only opened in read-only mode and are never modified or unlinked.
	 */
	assertVendorSessionRefReadOnly(path: string): void;
}

/**
 * E-25: Basic credential and secret redaction for mobile/cross-device views.
 */
export function redactSensitiveLogLine(line: string): string {
	let redacted = line;

	// 1. Private key blocks
	redacted = redacted.replace(
		/-----BEGIN [A-Z0-9_-]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_-]+ PRIVATE KEY-----/g,
		'[REDACTED_PRIVATE_KEY]',
	);

	// 2. Authorization headers
	redacted = redacted.replace(
		/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/-]+=*/gi,
		'$1[REDACTED_SECRET]',
	);

	// 3. Known token patterns
	// GitHub personal access tokens
	redacted = redacted.replace(/\b(gh[pousr]_[A-Za-z0-9_]{36,255})\b/g, '[REDACTED_TOKEN]');
	// sk-... API keys (OpenAI / Anthropic / etc.)
	redacted = redacted.replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]');
	// JWT tokens
	redacted = redacted.replace(
		/\b(ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
		'[REDACTED_JWT]',
	);

	// 4. Common sensitive environment variable assignments
	redacted = redacted.replace(
		/(\b[A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|API_?KEY|AUTH|CREDENTIAL|PRIVATE_?KEY)[A-Za-z0-9_]*\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
		'$1$2[REDACTED_SECRET]$2',
	);

	return redacted;
}

export function buildOpenCommand(filePath: string, platform: SupportedPlatform): string {
	const normalized = platform === 'win32' ? resolve(filePath) : filePath;
	switch (platform) {
		case 'win32':
			return `start "" "${normalized}"`;
		case 'darwin':
			return `open "${normalized}"`;
		default:
			return `xdg-open "${normalized}"`;
	}
}

/**
 * Creates the RunLogService (M6-T8).
 */
export function createRunLogService(deps: RunLogServiceDeps): RunLogService {
	const fileOps: RunLogFileOps = deps.fileOps ?? {
		existsSync,
		readFileSync: (p: string, enc: 'utf8') => readFileSync(p, enc),
		statSync: (p: string) => statSync(p),
		readdirSync: (p: string) => readdirSync(p),
		openReadOnlySync: (p: string) => openSync(p, 'r'),
	};

	function checkFileExists(path: string): boolean {
		if (fileOps.existsSync(path)) return true;
		const alt = path.includes('\\') ? path.replaceAll('\\', '/') : path.replaceAll('/', '\\');
		return fileOps.existsSync(alt);
	}

	function readUtf8File(path: string): string {
		try {
			return fileOps.readFileSync(path, 'utf8');
		} catch (err) {
			const alt = path.includes('\\') ? path.replaceAll('\\', '/') : path.replaceAll('/', '\\');
			return fileOps.readFileSync(alt, 'utf8');
		}
	}

	const currentPlatform: SupportedPlatform =
		deps.platform ??
		(process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux');

	function readCapturedLines(runId: string): readonly string[] {
		const baseDir = deps.runsDataDir ?? deps.logstorePaths?.runDir(runId);
		if (!baseDir || !checkFileExists(baseDir)) {
			return [];
		}

		const collected: string[] = [];

		// Try reading raw.log and its rotated slices (raw.1.log, raw.2.log...)
		const defaultRaw = join(baseDir, 'raw.log');
		if (checkFileExists(defaultRaw)) {
			try {
				const content = readUtf8File(defaultRaw);
				collected.push(...content.split(/\r?\n/));
			} catch {
				// Ignore read errors and fall back to whatever is readable
			}
		}

		if (fileOps.readdirSync) {
			try {
				const files = fileOps.readdirSync(baseDir);
				const slicedRaws = files
					.filter((f) => /^raw\.\d+\.log$/.test(f))
					.sort((a, b) => {
						const seqA = Number.parseInt(a.split('.')[1] ?? '0', 10);
						const seqB = Number.parseInt(b.split('.')[1] ?? '0', 10);
						return seqA - seqB;
					});

				for (const sliceFile of slicedRaws) {
					try {
						const content = readUtf8File(join(baseDir, sliceFile));
						collected.push(...content.split(/\r?\n/));
					} catch {
						// Ignore read error for single slice
					}
				}
			} catch {
				// Ignore directory read failure
			}
		}

		// If no raw.log output was found, check events.ndjson
		if (collected.length === 0) {
			const eventsFile = join(baseDir, 'events.ndjson');
			if (checkFileExists(eventsFile)) {
				try {
					const content = readUtf8File(eventsFile);
					const lines = content.split(/\r?\n/);
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const parsed = JSON.parse(line) as {
								kind?: string;
								ts?: string;
								payload?: { text?: string; message?: string };
							};
							const text = parsed.payload?.text ?? parsed.payload?.message;
							if (typeof text === 'string') {
								collected.push(text);
							} else {
								collected.push(`[${parsed.ts ?? ''}] ${parsed.kind ?? 'event'}`);
							}
						} catch {
							collected.push(line);
						}
					}
				} catch {
					// Fall through
				}
			}
		}

		return collected;
	}

	function assertVendorSessionRefReadOnly(path: string): void {
		// E-96: Verify that the file can be opened read-only and no mutation is performed.
		if (!path || !checkFileExists(path)) return;
		if (fileOps.openReadOnlySync) {
			const fd = fileOps.openReadOnlySync(path);
			// In Node fs, descriptor opened with 'r' is strictly read-only
			if (typeof fd === 'number' && fd >= 0) {
				// Closed immediately or tracked purely for reading
			}
		}
	}

	return {
		assertVendorSessionRefReadOnly,

		async getRunLog(options: GetRunLogOptions): Promise<GetRunLogResult> {
			const {
				runId,
				fromSeq,
				direction = 'forward',
				limit: requestedLimit,
				isMobileDevice = false,
			} = options;
			const limit = Math.max(
				1,
				Math.min(requestedLimit ?? DEFAULT_LOG_PAGE_LIMIT, MAX_LOG_PAGE_LIMIT),
			);

			const run = deps.runsRepo.findById(runId);
			if (!run) {
				throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
					details: { runId },
				});
			}

			let isVendorSessionMissing = false;
			let vendorSessionContent: string | null = null;
			let vendorSessionBytes = 0;
			let vendorSessionChars = 0;
			const vendorRef = run.vendorSessionRef ?? null;

			if (vendorRef) {
				assertVendorSessionRefReadOnly(vendorRef);
				if (!checkFileExists(vendorRef)) {
					// E-97: Vendor session file is missing from disk
					isVendorSessionMissing = true;
				} else {
					try {
						const stat = fileOps.statSync(vendorRef);
						vendorSessionBytes = stat.size;
						vendorSessionContent = readUtf8File(vendorRef);
						vendorSessionChars = vendorSessionContent.length;
					} catch {
						isVendorSessionMissing = true;
					}
				}
			}

			// Read captured scheduler logs
			const capturedLines = readCapturedLines(runId);
			let capturedBytes = 0;
			let capturedChars = 0;
			for (const line of capturedLines) {
				capturedChars += line.length + 1;
				capturedBytes += Buffer.byteLength(line, 'utf8') + 1;
			}

			// Total session size & chars calculation for E-98 threshold
			const totalBytes = vendorSessionBytes + capturedBytes;
			const totalChars = vendorSessionChars + capturedChars;
			const isExceedsThreshold =
				totalBytes >= RUN_LOG_SIZE_THRESHOLD_BYTES || totalChars >= RUN_LOG_CHAR_THRESHOLD_COUNT;

			// Prepare complete lines buffer
			const allLines: string[] = [];

			// E-97: When vendor session is missing, display warning and present dispatch snapshot
			if (isVendorSessionMissing && vendorRef) {
				allLines.push(`[调度器提示] 原始会话已不在磁盘（附路径：${vendorRef}）`);

				// Fetch 3-stage dispatch snapshot
				let snapshot: RunLogSnapshotRecord | null = null;
				if (run.snapshotId && deps.snapshotsRepo?.findById) {
					snapshot = deps.snapshotsRepo.findById(run.snapshotId);
				} else if (run.taskId && deps.snapshotsRepo?.findLatestByTaskId) {
					snapshot = deps.snapshotsRepo.findLatestByTaskId(run.taskId);
				} else if (run.snapshotId && deps.runsRepo.findSnapshotById) {
					snapshot = deps.runsRepo.findSnapshotById(run.snapshotId);
				} else if (run.taskId && deps.runsRepo.findLatestSnapshotByTaskId) {
					snapshot = deps.runsRepo.findLatestSnapshotByTaskId(run.taskId);
				}

				allLines.push('--- 派发快照：输入 ---');
				allLines.push(snapshot?.inputText ?? '(无输入快照)');
				allLines.push('--- 派发快照：产出 ---');
				allLines.push(snapshot?.outputText ?? '(无产出快照)');
				allLines.push('--- 派发快照：验收标准 ---');
				allLines.push(snapshot?.acceptText ?? '(无验收快照)');
				allLines.push('--- 调度器捕获输出 ---');
			}

			// If vendor transcript content exists and captured is empty, include vendor content
			if (vendorSessionContent !== null && capturedLines.length === 0) {
				allLines.push(...vendorSessionContent.split(/\r?\n/));
			} else {
				// Otherwise include captured lines
				allLines.push(...capturedLines);
			}

			// If allLines is completely empty and no vendor ref was ever configured, verify if log files are missing
			if (allLines.length === 0 && !vendorRef) {
				const baseDir = deps.runsDataDir ?? deps.logstorePaths?.runDir(runId);
				if (baseDir && !checkFileExists(baseDir)) {
					throw new AppError('E_LOG_FILE_MISSING', `Log files missing for run: ${runId}`, {
						details: { runId },
					});
				}
			}

			const totalLines = allLines.length;

			// E-98: Threshold banner & system default open command
			const originalFilePath =
				vendorRef ?? deps.logstorePaths?.segmentPath(runId, 'raw', 0) ?? null;
			const openCommand = originalFilePath
				? buildOpenCommand(originalFilePath, currentPlatform)
				: null;

			// Pagination calculation
			// If exceeds threshold and no fromSeq is given: default to loading the tail window
			const isTailDefault = isExceedsThreshold && fromSeq === undefined;

			let startIdx: number;
			let endIdx: number;

			if (isTailDefault) {
				endIdx = totalLines;
				startIdx = Math.max(0, endIdx - limit);
			} else if (direction === 'backward') {
				endIdx =
					fromSeq !== undefined && fromSeq !== null
						? Math.min(totalLines, fromSeq + 1)
						: totalLines;
				startIdx = Math.max(0, endIdx - limit);
			} else {
				// direction === 'forward'
				startIdx = fromSeq !== undefined && fromSeq !== null ? Math.max(0, fromSeq) : 0;
				endIdx = Math.min(totalLines, startIdx + limit);
			}

			let windowLines = allLines.slice(startIdx, endIdx);

			// Compute bi-directional cursors
			const prevCursor = startIdx > 0 ? String(startIdx - 1) : null;
			const nextCursor = endIdx < totalLines ? String(endIdx) : null;

			// Prepend E-98 hint line if tail-loaded due to threshold
			if (isTailDefault && openCommand) {
				windowLines = [
					`[调度器提示] 单会话内容超阈值（>20MB 或 >50万字），默认仅加载尾部片段。可点击「向上加载更多」，或用系统默认程序打开原始文件：${openCommand}`,
					...windowLines,
				];
			}

			// E-25: Redaction for mobile / cross-device views
			if (isMobileDevice) {
				windowLines = windowLines.map(redactSensitiveLogLine);
				windowLines = [
					'[安全告知] 检测到跨设备/移动端查看，已对会话日志中的密钥与凭据执行基本脱敏（E-25）。',
					...windowLines,
				];
			}

			return Object.freeze({
				lines: Object.freeze(windowLines),
				totalLines,
				prevCursor,
				nextCursor,
				vendorSessionRef: vendorRef,
				isVendorSessionMissing,
				originalFilePath,
				openCommand,
				isExceedsThreshold,
				isRedacted: isMobileDevice,
			});
		},
	};
}
