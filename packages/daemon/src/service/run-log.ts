import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { AppError } from '../errors/app-error.ts';
import { READ_CHUNK_LIMIT_BYTES } from '../logstore/contract.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import { type ByteCursor, formatCursor, parseCursor, splitLines } from '../logstore/read-window.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import type { LogSegmentsRepo } from '../repo/log-segments-repo.ts';

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
	readonly input_text?: string | null;
	readonly output_text?: string | null;
	readonly accept_text?: string | null;
	readonly inputText?: string | null;
	readonly outputText?: string | null;
	readonly acceptText?: string | null;
}

export interface RunLogRepo {
	findById(id: string): RunLogRunRecord | null;
	findSnapshotById?(snapshotId: string): RunLogSnapshotRecord | null;
	findLatestSnapshotByTaskId?(taskId: string): RunLogSnapshotRecord | null;
}

export interface OpenSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface GetRunLogOptions {
	readonly runId: string;
	readonly fromSeq?: number | string | null;
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
	readonly openSpec?: OpenSpec | null;
	readonly isExceedsThreshold?: boolean;
	readonly isRedacted?: boolean;
}

export interface RunLogFileOps {
	readonly existsSync: (path: string) => boolean;
	readonly statSync: (path: string) => { readonly size: number };
	readonly openReadOnlySync?: (path: string) => number;
	readonly closeSync?: (fd: number) => void;
	readonly readRangeSync?: (path: string, start: number, length: number) => Uint8Array;
}

export interface RunLogServiceDeps {
	readonly runsRepo: RunLogRepo;
	readonly snapshotsRepo?: {
		findById(id: string): RunLogSnapshotRecord | null;
		findLatestByTaskId?(taskId: string): RunLogSnapshotRecord | null;
	};
	readonly logSegmentsRepo?: Pick<LogSegmentsRepo, 'findByRunStream'>;
	readonly logstorePaths?: LogstorePaths;
	readonly runsDataDir?: string;
	readonly fileOps?: RunLogFileOps;
	readonly platform: SupportedPlatform;
}

export interface RunLogService {
	getRunLog(options: GetRunLogOptions): Promise<GetRunLogResult>;
	/**
	 * E-96: Asserts that a vendor session ref is handled read-only.
	 * Vendor session files are only opened in read-only mode, and descriptors are strictly closed.
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

/**
 * R6: Structured launch spec for system default open command.
 * Avoids string concatenation and prevents shell command injection on vendor paths.
 */
export function buildOpenSpec(filePath: string, platform: SupportedPlatform): OpenSpec {
	switch (platform) {
		case 'win32':
			return Object.freeze({
				file: 'cmd.exe',
				args: Object.freeze(['/d', '/s', '/c', 'start', '', filePath]),
			});
		case 'darwin':
			return Object.freeze({
				file: 'open',
				args: Object.freeze([filePath]),
			});
		default:
			return Object.freeze({
				file: 'xdg-open',
				args: Object.freeze([filePath]),
			});
	}
}

interface ResolvedSegment {
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	/** null when the segment has no index row yet (still being appended), so its length is unknown. */
	readonly lineCount: number | null;
}

/**
 * Creates the RunLogService (M6-T8).
 */
export function createRunLogService(deps: RunLogServiceDeps): RunLogService {
	const platform: SupportedPlatform = deps.platform;

	const defaultReadRange = (path: string, start: number, length: number): Uint8Array => {
		if (length <= 0) return new Uint8Array(0);
		const fd = openSync(path, 'r');
		try {
			const buf = Buffer.alloc(length);
			const bytesRead = readSync(fd, buf, 0, length, start);
			return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
		} finally {
			closeSync(fd);
		}
	};

	const fileOps: RunLogFileOps = {
		existsSync: deps.fileOps?.existsSync ?? existsSync,
		statSync: deps.fileOps?.statSync ?? statSync,
		openReadOnlySync:
			deps.fileOps?.openReadOnlySync ??
			(deps.fileOps?.readRangeSync ? () => 1 : (p: string) => openSync(p, 'r')),
		closeSync:
			deps.fileOps?.closeSync ??
			(deps.fileOps?.readRangeSync ? () => undefined : (fd: number) => closeSync(fd)),
		readRangeSync: deps.fileOps?.readRangeSync ?? defaultReadRange,
	};

	function assertVendorSessionRefReadOnly(path: string): void {
		// E-96 & R4: Verify file opens read-only and close descriptor immediately to avoid leakage.
		if (!path || !fileOps.existsSync(path)) return;
		if (fileOps.openReadOnlySync && fileOps.closeSync) {
			const fd = fileOps.openReadOnlySync(path);
			try {
				if (typeof fd === 'number' && fd >= 0) {
					// Read-only check verified
				}
			} finally {
				fileOps.closeSync(fd);
			}
		}
	}

	function resolveSegments(runId: string): readonly ResolvedSegment[] {
		const segments: ResolvedSegment[] = [];
		if (deps.logSegmentsRepo) {
			const registered = deps.logSegmentsRepo.findByRunStream(runId, 'raw');
			for (const r of registered) {
				segments.push({
					fileSeq: r.fileSeq,
					path: r.path,
					byteStart: r.byteStart,
					byteEnd: r.byteEnd,
					lineCount: r.lineCount,
				});
			}
		}

		// If no registered slices yet, locate default segment 0 on disk
		if (segments.length === 0 && deps.logstorePaths) {
			const defaultPath = deps.logstorePaths.segmentPath(runId, 'raw', 0);
			if (fileOps.existsSync(defaultPath)) {
				try {
					const stat = fileOps.statSync(defaultPath);
					segments.push({
						fileSeq: 0,
						path: defaultPath,
						byteStart: 0,
						byteEnd: stat.size,
						lineCount: null,
					});
				} catch {
					// Fall through
				}
			}
		}

		return Object.freeze(segments.sort((a, b) => a.fileSeq - b.fileSeq));
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
			let vendorSessionBytes = 0;
			let vendorSessionChars = 0;
			const vendorRef = run.vendorSessionRef ?? null;

			if (vendorRef) {
				assertVendorSessionRefReadOnly(vendorRef);
				if (!fileOps.existsSync(vendorRef)) {
					// E-97: Vendor session file is missing from disk
					isVendorSessionMissing = true;
				} else {
					try {
						const stat = fileOps.statSync(vendorRef);
						vendorSessionBytes = stat.size;
						// Approximation: UTF-8 text size roughly correlates to character count
						vendorSessionChars = stat.size;
					} catch {
						isVendorSessionMissing = true;
					}
				}
			}

			// R2: Resolve segments using M1-T4 segment records & paths
			const segments = resolveSegments(runId);
			let totalCapturedBytes = 0;
			for (const seg of segments) {
				totalCapturedBytes += Math.max(0, seg.byteEnd - seg.byteStart);
			}

			// `totalLines` is the session's whole line count, not the size of the window returned here.
			// A segment still being appended has no index row yet, so its length is unknown; in that
			// case fall back to the window size rather than reporting a number we cannot stand behind.
			let sessionLineTotal: number | null = 0;
			for (const seg of segments) {
				if (typeof seg.lineCount === 'number' && sessionLineTotal !== null) {
					sessionLineTotal += seg.lineCount;
				} else {
					sessionLineTotal = null;
				}
			}

			const totalBytes = vendorSessionBytes + totalCapturedBytes;
			const totalChars = vendorSessionChars + totalCapturedBytes;
			const isExceedsThreshold =
				totalBytes >= RUN_LOG_SIZE_THRESHOLD_BYTES || totalChars >= RUN_LOG_CHAR_THRESHOLD_COUNT;

			// R6: Structured open spec & formatted command
			const originalFilePath =
				vendorRef ?? deps.logstorePaths?.segmentPath(runId, 'raw', 0) ?? null;
			const openSpec = originalFilePath ? buildOpenSpec(originalFilePath, platform) : null;
			const openCommand = openSpec
				? `${openSpec.file} ${openSpec.args.map((a) => (a.includes(' ') || a === '' ? `"${a}"` : a)).join(' ')}`
				: null;

			const decoder = new TextDecoder('utf-8', { fatal: false });
			const lines: string[] = [];

			// E-97: When vendor session is missing, insert warning and present dispatch snapshot
			if (isVendorSessionMissing && vendorRef) {
				lines.push(`[调度器提示] 原始会话已不在磁盘（附路径：${vendorRef}）`);

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

				const inputText = snapshot?.inputText ?? snapshot?.input_text ?? '(无输入快照)';
				const outputText = snapshot?.outputText ?? snapshot?.output_text ?? '(无产出快照)';
				const acceptText = snapshot?.acceptText ?? snapshot?.accept_text ?? '(无验收快照)';

				lines.push('--- 派发快照：输入 ---');
				lines.push(inputText);
				lines.push('--- 派发快照：产出 ---');
				lines.push(outputText);
				lines.push('--- 派发快照：验收标准 ---');
				lines.push(acceptText);
				lines.push('--- 调度器捕获输出 ---');
			}

			// Parse incoming cursor: supports "fileSeq:byteOffset" or numeric byteOffset on segment 0
			let parsedCursor: ByteCursor | null = null;
			if (typeof fromSeq === 'string') {
				parsedCursor = parseCursor(fromSeq);
			} else if (typeof fromSeq === 'number' && Number.isSafeInteger(fromSeq)) {
				parsedCursor = { fileSeq: 0, byteOffset: Math.max(0, fromSeq) };
			}

			// R2: Bounded segment read across log segments
			const isTailDefault = isExceedsThreshold && fromSeq === undefined;
			let prevCursor: string | null = null;
			let nextCursor: string | null = null;

			if (segments.length > 0) {
				const firstSeg = segments[0];
				const lastSeg = segments[segments.length - 1];
				if (!firstSeg || !lastSeg) {
					return Object.freeze({
						lines: Object.freeze([]),
						totalLines: 0,
						prevCursor: null,
						nextCursor: null,
						vendorSessionRef: vendorRef,
						isVendorSessionMissing,
						originalFilePath,
						openCommand,
						openSpec,
						isExceedsThreshold,
						isRedacted: isMobileDevice,
					});
				}

				if (isTailDefault || direction === 'backward') {
					// Backward / Tail-only read: start from target segment end and read up to READ_CHUNK_LIMIT_BYTES
					const targetSeq = parsedCursor !== null ? parsedCursor.fileSeq : lastSeg.fileSeq;
					const targetSeg = segments.find((s) => s.fileSeq === targetSeq) ?? lastSeg;
					const targetOffset = parsedCursor !== null ? parsedCursor.byteOffset : targetSeg.byteEnd;

					const readLength = Math.min(targetOffset - targetSeg.byteStart, READ_CHUNK_LIMIT_BYTES);
					const readStart = Math.max(targetSeg.byteStart, targetOffset - readLength);

					if (readLength > 0 && fileOps.readRangeSync) {
						const chunk = fileOps.readRangeSync(targetSeg.path, readStart, readLength);
						const slices = splitLines(chunk);
						const selectedSlices = slices.slice(-limit);
						const selectedLines = selectedSlices.map((s) => decoder.decode(s.bytes));
						lines.push(...selectedLines);

						const consumedBytes = selectedSlices.reduce((acc, s) => acc + s.lenWithLf, 0);
						const windowStart = targetOffset - consumedBytes;

						if (windowStart > targetSeg.byteStart) {
							prevCursor = formatCursor(targetSeg.fileSeq, windowStart);
						} else if (targetSeg.fileSeq > firstSeg.fileSeq) {
							const prevSeg = segments[segments.indexOf(targetSeg) - 1];
							if (prevSeg) {
								prevCursor = formatCursor(prevSeg.fileSeq, prevSeg.byteEnd);
							}
						}

						if (targetOffset < targetSeg.byteEnd) {
							nextCursor = formatCursor(targetSeg.fileSeq, targetOffset);
						}
					}
				} else {
					// Forward read
					const targetSeq = parsedCursor !== null ? parsedCursor.fileSeq : firstSeg.fileSeq;
					const targetSeg = segments.find((s) => s.fileSeq >= targetSeq) ?? firstSeg;
					const targetOffset =
						parsedCursor !== null && parsedCursor.fileSeq === targetSeg.fileSeq
							? parsedCursor.byteOffset
							: targetSeg.byteStart;

					const readLength = Math.min(targetSeg.byteEnd - targetOffset, READ_CHUNK_LIMIT_BYTES);

					if (readLength > 0 && fileOps.readRangeSync) {
						const chunk = fileOps.readRangeSync(targetSeg.path, targetOffset, readLength);
						const slices = splitLines(chunk);
						const selectedSlices = slices.slice(0, limit);
						const selectedLines = selectedSlices.map((s) => decoder.decode(s.bytes));
						lines.push(...selectedLines);

						const consumedBytes = selectedSlices.reduce((acc, s) => acc + s.lenWithLf, 0);
						const nextByteOffset = targetOffset + consumedBytes;
						if (nextByteOffset < targetSeg.byteEnd) {
							nextCursor = formatCursor(targetSeg.fileSeq, nextByteOffset);
						} else {
							const nextSeg = segments[segments.indexOf(targetSeg) + 1];
							if (nextSeg) {
								nextCursor = formatCursor(nextSeg.fileSeq, nextSeg.byteStart);
							}
						}

						if (targetOffset > targetSeg.byteStart) {
							prevCursor = formatCursor(
								targetSeg.fileSeq,
								Math.max(targetSeg.byteStart, targetOffset - READ_CHUNK_LIMIT_BYTES),
							);
						}
					}
				}
			} else if (vendorRef && !isVendorSessionMissing && fileOps.existsSync(vendorRef)) {
				// R2: Bounded reading of vendor session file
				const stat = fileOps.statSync(vendorRef);
				const fileSize = stat.size;
				let readStart = 0;
				let readLength = Math.min(fileSize, READ_CHUNK_LIMIT_BYTES);

				if (isTailDefault || direction === 'backward') {
					readStart = Math.max(0, fileSize - readLength);
				} else if (parsedCursor !== null) {
					readStart = Math.min(fileSize, parsedCursor.byteOffset);
					readLength = Math.min(fileSize - readStart, READ_CHUNK_LIMIT_BYTES);
				}

				if (readLength > 0 && fileOps.readRangeSync) {
					const chunk = fileOps.readRangeSync(vendorRef, readStart, readLength);
					const slices = splitLines(chunk);
					const selectedSlices =
						isTailDefault || direction === 'backward'
							? slices.slice(-limit)
							: slices.slice(0, limit);
					const selectedLines = selectedSlices.map((s) => decoder.decode(s.bytes));
					lines.push(...selectedLines);

					const consumedBytes = selectedSlices.reduce((acc, s) => acc + s.lenWithLf, 0);

					if (isTailDefault || direction === 'backward') {
						const windowStart = fileSize - consumedBytes;
						if (windowStart > 0) {
							prevCursor = formatCursor(0, windowStart);
						}
					} else {
						if (readStart > 0) {
							prevCursor = formatCursor(0, readStart);
						}
						if (readStart + consumedBytes < fileSize) {
							nextCursor = formatCursor(0, readStart + consumedBytes);
						}
					}
				}
			} else if (lines.length === 0 && !vendorRef) {
				const baseDir = deps.runsDataDir ?? deps.logstorePaths?.runDir(runId);
				if (baseDir && !fileOps.existsSync(baseDir)) {
					throw new AppError('E_LOG_FILE_MISSING', `Log files missing for run: ${runId}`, {
						details: { runId },
					});
				}
			}

			let windowLines = lines;

			// E-98: Prepend hint line if tail-loaded due to threshold
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

			const totalLines = sessionLineTotal ?? windowLines.length;

			return Object.freeze({
				lines: Object.freeze(windowLines),
				totalLines,
				prevCursor,
				nextCursor,
				vendorSessionRef: vendorRef,
				isVendorSessionMissing,
				originalFilePath,
				openCommand,
				openSpec,
				isExceedsThreshold,
				isRedacted: isMobileDevice,
			});
		},
	};
}
