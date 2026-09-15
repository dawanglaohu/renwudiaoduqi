import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors/app-error.ts';
import type { LogstorePaths } from '../logstore/paths.ts';
import { parseSegmentFileName } from '../logstore/paths.ts';
import { splitLines } from '../logstore/read-window.ts';
import type { LogSegmentsRepo } from '../repo/log-segments-repo.ts';
import { redactSensitiveLogLine } from './run-log.ts';
import type { SystemService } from './system.ts';

/**
 * Hard constraints for full-text search (E-219, 10-接口约定):
 * - Max results: 500 hits
 * - Hard timeout: 10,000 ms (10 seconds)
 * - Yield event loop after each chunk to prevent daemon blocking
 */
export const SEARCH_MAX_HITS_LIMIT = 500;
export const SEARCH_DEFAULT_TIMEOUT_MS = 10_000;
export const SEARCH_CHUNK_SIZE_BYTES = 64 * 1024; // 64 KiB read window

/**
 * Marker file name stored in run directory when logs are purged (E-105, E-221).
 */
export const PURGED_MARKER_FILE_NAME = '.purged';

export interface RetentionRunRecord {
	readonly id: string;
	readonly taskId: string;
	readonly state: string;
	readonly attemptNo?: number | null;
	readonly vendorSessionRef?: string | null;
	readonly snapshotId?: string | null;
	readonly worktreePath?: string | null;
	readonly startedAt?: string | null;
	readonly endedAt?: string | null;
}

export interface RetentionRunsRepo {
	findById(id: string): RetentionRunRecord | null;
	findByTaskId?(taskId: string): readonly RetentionRunRecord[];
	findCompletedRuns?(): readonly RetentionRunRecord[];
}

export interface RetentionFileOps {
	readonly existsSync: (path: string) => boolean;
	readonly statSync: (path: string) => { readonly size: number; readonly mtimeMs?: number };
	readonly openReadOnlySync?: (path: string) => number;
	readonly closeSync?: (fd: number) => void;
	readonly readRangeSync?: (path: string, start: number, length: number) => Uint8Array;
	readonly readdirSync?: (path: string) => readonly string[];
	readonly unlinkSync?: (path: string) => void;
	readonly writeFileSync?: (path: string, content: string | Uint8Array) => void;
	readonly readFileSync?: (path: string, encoding: BufferEncoding) => string;
	readonly mkdirSync?: (path: string, options?: { recursive?: boolean }) => void;
}

export interface SearchHit {
	readonly line: string;
	readonly lineNo: number;
	readonly seq: number;
	readonly stream: 'raw' | 'events' | 'vendor';
}

export interface SearchInRunOptions {
	readonly runId: string;
	readonly query: string;
	readonly limit?: number;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	readonly stream?: 'raw' | 'events' | 'vendor' | 'all';
	readonly isMobileDevice?: boolean;
}

export interface SearchInRunResult {
	readonly hits: readonly SearchHit[];
	readonly truncated: boolean;
	readonly scannedUntilSeq: number;
	readonly canceled: boolean;
}

export interface PurgeRunLogsOptions {
	readonly runId: string;
	readonly reason?: string;
	readonly actorDeviceId?: string | null;
}

export interface PurgeRunLogsResult {
	readonly runId: string;
	readonly purgedBytes: number;
	readonly purgedAt: string;
}

export interface RetentionPolicyOptions {
	/** Retain logs for completed runs ended within maxDays. Older ones are eligible for purge. */
	readonly maxDays?: number;
	/** Maximum total bytes for captured run logs. Oldest completed runs are purged until below limit. */
	readonly maxTotalBytes?: number;
	/** Only purge terminal runs (default: true). */
	readonly terminalOnly?: boolean;
}

export interface PurgedRunSummary {
	readonly runId: string;
	readonly taskId: string;
	readonly bytesFreed: number;
	readonly endedAt: string | null;
}

export interface RetentionCleanupReport {
	readonly purgedRuns: readonly PurgedRunSummary[];
	readonly totalBytesFreed: number;
	readonly totalRunsEvaluated: number;
}

export interface TaskRunsProgressResult {
	readonly taskId: string;
	readonly latestRun: RetentionRunRecord | null;
	readonly historicalRuns: readonly RetentionRunRecord[];
}

export interface RetentionClock {
	readonly now: () => string;
	readonly nowMs?: () => number;
}

export interface RetentionServiceDeps {
	readonly runsRepo: RetentionRunsRepo;
	readonly logstorePaths: LogstorePaths;
	readonly systemService?: Pick<SystemService, 'deleteByPath'>;
	readonly logSegmentsRepo?: Pick<LogSegmentsRepo, 'findByRunStream'>;
	readonly fileOps?: RetentionFileOps;
	readonly clock?: RetentionClock;
}

export interface RetentionService {
	/**
	 * Full-text search within a single run log (E-219, E-220, E-221, E-207).
	 */
	searchInRun(options: SearchInRunOptions): Promise<SearchInRunResult>;

	/**
	 * Purge captured log text for a single run (E-105, M1-T5 primitive).
	 * Preserves database records (runs, dispatch_snapshots, tasks).
	 */
	purgeRunLogs(options: PurgeRunLogsOptions): Promise<PurgeRunLogsResult>;

	/**
	 * Execute retention policy across completed runs (E-105).
	 */
	applyRetentionPolicy(
		policy: RetentionPolicyOptions,
		candidateRuns?: readonly RetentionRunRecord[],
	): Promise<RetentionCleanupReport>;

	/**
	 * Check if a run's captured logs have been purged by retention policy.
	 */
	isLogPurged(runId: string): boolean;

	/**
	 * Get task runs progress summary separating latest run from history (E-27).
	 */
	getTaskRunsSummary(taskId: string): TaskRunsProgressResult;
}

interface SegmentSnapshot {
	readonly path: string;
	readonly fileSeq: number;
	readonly maxByteOffset: number;
	readonly stream: 'raw' | 'events' | 'vendor';
}

export interface PurgedMarkerData {
	readonly runId: string;
	readonly purgedAt: string;
	readonly purgedBytes: number;
	readonly reason: string;
}

/**
 * Checks if a run state is active / in-flight and thus must not be purged.
 */
function isActiveRunState(state: string): boolean {
	return (
		state === 'starting' ||
		state === 'running' ||
		state === 'awaiting_reply' ||
		state === 'awaiting_human'
	);
}

/**
 * Creates the RetentionService (M6-T9).
 */
export function createRetentionService(deps: RetentionServiceDeps): RetentionService {
	const clock: RetentionClock = deps.clock ?? {
		now: () => new Date().toISOString(),
	};
	const nowMs = (): number => clock.nowMs?.() ?? Date.now();

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

	const fileOps: RetentionFileOps = {
		existsSync: deps.fileOps?.existsSync ?? existsSync,
		statSync: deps.fileOps?.statSync ?? statSync,
		openReadOnlySync:
			deps.fileOps?.openReadOnlySync ??
			(deps.fileOps?.readRangeSync ? () => 1 : (p: string) => openSync(p, 'r')),
		closeSync:
			deps.fileOps?.closeSync ??
			(deps.fileOps?.readRangeSync ? () => undefined : (fd: number) => closeSync(fd)),
		readRangeSync: deps.fileOps?.readRangeSync ?? defaultReadRange,
		readdirSync: deps.fileOps?.readdirSync ?? readdirSync,
		unlinkSync: deps.fileOps?.unlinkSync ?? unlinkSync,
		writeFileSync: deps.fileOps?.writeFileSync ?? writeFileSync,
		readFileSync: deps.fileOps?.readFileSync ?? readFileSync,
		mkdirSync: deps.fileOps?.mkdirSync ?? mkdirSync,
	};

	function isLogPurged(runId: string): boolean {
		const runDir = deps.logstorePaths.runDir(runId);
		const markerPath = join(runDir, PURGED_MARKER_FILE_NAME);
		return fileOps.existsSync(markerPath);
	}

	function resolveSegmentSnapshots(
		run: RetentionRunRecord,
		streamFilter: 'raw' | 'events' | 'vendor' | 'all' = 'all',
	): readonly SegmentSnapshot[] {
		const runId = run.id;
		const snapshots: SegmentSnapshot[] = [];

		// Streams to include in the snapshot based on the caller's filter.
		// 'all' (default) collects both raw and events; 'vendor' is handled below as a fallback.
		const wantRaw = streamFilter === 'raw' || streamFilter === 'all';
		const wantEvents = streamFilter === 'events' || streamFilter === 'all';

		// Helper: snapshot one segment path (E-220 – upper bound frozen at invocation time)
		function snapshotFile(
			path: string,
			fileSeq: number,
			stream: 'raw' | 'events' | 'vendor',
			byteEnd?: number,
		): void {
			if (!fileOps.existsSync(path)) return;
			try {
				const stat = fileOps.statSync(path);
				const maxByteOffset = byteEnd !== undefined ? Math.min(byteEnd, stat.size) : stat.size;
				if (maxByteOffset > 0) {
					snapshots.push({ path, fileSeq, maxByteOffset, stream });
				}
			} catch {
				// Unreadable – skip
			}
		}

		// Track whether each stream found at least one registered segment,
		// so the disk-probe fallback runs per-stream independently.
		let foundRaw = false;
		let foundEvents = false;

		// 1. Registered segments from logSegmentsRepo (covers multi-segment runs)
		if (deps.logSegmentsRepo) {
			if (wantRaw) {
				for (const seg of deps.logSegmentsRepo.findByRunStream(runId, 'raw')) {
					const before = snapshots.length;
					snapshotFile(seg.path, seg.fileSeq, 'raw', seg.byteEnd);
					if (snapshots.length > before) foundRaw = true;
				}
			}
			if (wantEvents) {
				for (const seg of deps.logSegmentsRepo.findByRunStream(runId, 'events')) {
					const before = snapshots.length;
					snapshotFile(seg.path, seg.fileSeq, 'events', seg.byteEnd);
					if (snapshots.length > before) foundEvents = true;
				}
			}
		}

		// 2. Disk probe fallback – runs independently per stream when no repo segments were found
		if (!foundRaw && wantRaw) {
			const before = snapshots.length;
			snapshotFile(deps.logstorePaths.segmentPath(runId, 'raw', 0), 0, 'raw');
			if (snapshots.length > before) foundRaw = true;
		}
		if (!foundEvents && wantEvents) {
			snapshotFile(deps.logstorePaths.segmentPath(runId, 'events', 0), 0, 'events');
		}

		// 3. Vendor session file – only when no captured segments exist and filter allows it
		if (snapshots.length === 0 && streamFilter !== 'raw' && streamFilter !== 'events') {
			if (run.vendorSessionRef) {
				snapshotFile(run.vendorSessionRef, 0, 'vendor');
			}
		}

		return Object.freeze(snapshots.sort((a, b) => a.fileSeq - b.fileSeq));
	}

	async function purgeRunLogs(options: PurgeRunLogsOptions): Promise<PurgeRunLogsResult> {
		const { runId, reason = 'retention_policy' } = options;
		if (!runId || typeof runId !== 'string' || runId.trim() === '') {
			throw new AppError('E_VALIDATION', 'runId is required for purging logs');
		}

		const run = deps.runsRepo.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}

		// Active runs must not have their logs purged
		if (isActiveRunState(run.state)) {
			throw new AppError(
				'E_VALIDATION',
				`Cannot purge logs of active run: ${runId} (state: ${run.state})`,
				{
					details: { runId, state: run.state },
				},
			);
		}

		const runDir = deps.logstorePaths.runDir(runId);
		const markerPath = join(runDir, PURGED_MARKER_FILE_NAME);

		// If already purged, operation is idempotent
		if (fileOps.existsSync(markerPath)) {
			return {
				runId,
				purgedBytes: 0,
				purgedAt: clock.now(),
			};
		}

		if (!fileOps.existsSync(runDir)) {
			// Directory already missing on disk (e.g. manually deleted outside product)
			// Write purged marker so subsequent calls recognize it as purged
			try {
				if (fileOps.mkdirSync) {
					fileOps.mkdirSync(runDir, { recursive: true });
				}
				const markerData: PurgedMarkerData = {
					runId,
					purgedAt: clock.now(),
					purgedBytes: 0,
					reason,
				};
				if (fileOps.writeFileSync) {
					fileOps.writeFileSync(markerPath, JSON.stringify(markerData, null, 2));
				}
			} catch {
				// Fall through
			}
			return {
				runId,
				purgedBytes: 0,
				purgedAt: clock.now(),
			};
		}

		// Identify captured log files in run directory
		let filesInDir: readonly string[] = [];
		if (fileOps.readdirSync) {
			try {
				filesInDir = fileOps.readdirSync(runDir);
			} catch {
				filesInDir = [];
			}
		}

		let totalPurgedBytes = 0;

		// Purge only captured segment files (raw*.log, events*.ndjson) (E-105).
		// Files not parseable as segment names (attachments, metadata, etc.) are left untouched.
		// The vendor session file lives outside runDir and is never deleted here.
		for (const fileName of filesInDir) {
			if (fileName === PURGED_MARKER_FILE_NAME) continue;

			// Only delete files that are recognised captured log segments
			if (!parseSegmentFileName(fileName)) continue;

			const filePath = join(runDir, fileName);
			let fileSize = 0;
			try {
				fileSize = fileOps.statSync(filePath).size;
			} catch {
				fileSize = 0;
			}

			if (deps.systemService?.deleteByPath) {
				// M1-T5 primitive
				const res = await deps.systemService.deleteByPath(filePath);
				if (res.ok) {
					totalPurgedBytes += res.bytesFreed;
				} else {
					totalPurgedBytes += fileSize;
				}
			} else if (fileOps.unlinkSync) {
				try {
					fileOps.unlinkSync(filePath);
					totalPurgedBytes += fileSize;
				} catch {
					// Continue deleting remaining files
				}
			}
		}

		const purgedAt = clock.now();
		const markerData: PurgedMarkerData = {
			runId,
			purgedAt,
			purgedBytes: totalPurgedBytes,
			reason,
		};

		// Write tombstone marker (E-221, E-105)
		if (fileOps.writeFileSync) {
			try {
				fileOps.writeFileSync(markerPath, JSON.stringify(markerData, null, 2));
			} catch {
				// If writing marker fails, continue
			}
		}

		return {
			runId,
			purgedBytes: totalPurgedBytes,
			purgedAt,
		};
	}

	async function searchInRun(options: SearchInRunOptions): Promise<SearchInRunResult> {
		const {
			runId,
			query,
			limit: requestedLimit,
			timeoutMs: requestedTimeout,
			signal,
			stream: streamFilter = 'all',
			isMobileDevice = false,
		} = options;

		if (!runId || typeof runId !== 'string' || runId.trim() === '') {
			throw new AppError('E_VALIDATION', 'runId is required for search');
		}

		if (typeof query !== 'string' || query.trim() === '' || query.length > 200) {
			throw new AppError(
				'E_VALIDATION',
				'Search query q must be a non-empty string with maximum length of 200 characters (E-219)',
			);
		}

		const run = deps.runsRepo.findById(runId);
		if (!run) {
			throw new AppError('E_NOT_FOUND', `Run not found: ${runId}`, {
				details: { runId },
			});
		}

		const runDir = deps.logstorePaths.runDir(runId);

		// E-221: Check if run log has already been purged by retention policy
		if (isLogPurged(runId)) {
			throw new AppError(
				'E_LOG_PURGED',
				'Captured log text has been purged by the retention policy.',
				{
					details: { runId, reason: 'purged' },
				},
			);
		}

		// E-220: Take snapshot of segment boundaries and file sizes at invocation moment
		const snapshots = resolveSegmentSnapshots(run, streamFilter);

		// E-221 & E-207: Captured log files missing from disk
		if (snapshots.length === 0) {
			if (!fileOps.existsSync(runDir)) {
				throw new AppError('E_LOG_FILE_MISSING', 'Captured log files are missing from disk.', {
					details: { runId, orphan: true },
				});
			}

			// Run dir exists but has no readable segment files
			throw new AppError('E_LOG_FILE_MISSING', 'No captured log segments found on disk.', {
				details: { runId, orphan: true },
			});
		}

		const limit = Math.min(
			Math.max(1, requestedLimit ?? SEARCH_MAX_HITS_LIMIT),
			SEARCH_MAX_HITS_LIMIT,
		);
		const timeoutMs = Math.min(
			Math.max(1, requestedTimeout ?? SEARCH_DEFAULT_TIMEOUT_MS),
			SEARCH_DEFAULT_TIMEOUT_MS,
		);

		const startTime = nowMs();
		const hits: SearchHit[] = [];
		const decoder = new TextDecoder('utf-8', { fatal: false });
		const lowerQuery = query.toLowerCase();

		let totalLinesScanned = 0;
		let lastScannedSeq = 0;
		let truncated = false;
		let canceled = false;

		const readRange = fileOps.readRangeSync ?? defaultReadRange;

		// Scan snapshots chunk by chunk with event loop yields (E-219, E-220)
		for (const seg of snapshots) {
			if (hits.length >= limit || truncated || canceled) break;

			let offset = 0;
			let carryBytes: Uint8Array = new Uint8Array(0);

			while (offset < seg.maxByteOffset) {
				// Check cancellation
				if (signal?.aborted) {
					canceled = true;
					truncated = true;
					break;
				}

				// Check hard timeout before the next chunk (E-219)
				if (nowMs() - startTime >= timeoutMs) {
					truncated = true;
					break;
				}

				const chunkLen = Math.min(SEARCH_CHUNK_SIZE_BYTES, seg.maxByteOffset - offset);
				const rawChunk = readRange(seg.path, offset, chunkLen);
				offset += rawChunk.length;

				// Combine carry from previous chunk
				let combined: Uint8Array = rawChunk;
				if (carryBytes.length > 0) {
					const joined = new Uint8Array(carryBytes.length + rawChunk.length);
					joined.set(carryBytes, 0);
					joined.set(rawChunk, carryBytes.length);
					combined = joined;
					carryBytes = new Uint8Array(0);
				}

				const slices = splitLines(combined);
				const isEndOfSegment = offset >= seg.maxByteOffset;

				for (let i = 0; i < slices.length; i++) {
					const slice = slices[i];
					if (!slice) continue;

					// If slice is incomplete and not at end of snapshot, save as carry
					if (!slice.complete && !isEndOfSegment && i === slices.length - 1) {
						carryBytes = slice.bytes;
						break;
					}

					totalLinesScanned++;
					lastScannedSeq = totalLinesScanned;

					const decoded = decoder.decode(slice.bytes);
					if (decoded.toLowerCase().includes(lowerQuery)) {
						const displayLine = isMobileDevice ? redactSensitiveLogLine(decoded) : decoded;
						hits.push({
							line: displayLine,
							lineNo: totalLinesScanned,
							seq: totalLinesScanned,
							stream: seg.stream,
						});

						if (hits.length >= limit) {
							truncated = true;
							break;
						}
					}
				}

				// Periodic cooperative yield to avoid blocking daemon event loop (E-219)
				await new Promise((resolve) => setImmediate(resolve));

				// Check hard timeout after yielding so the clock can advance (E-219)
				if (nowMs() - startTime >= timeoutMs) {
					truncated = true;
					break;
				}
			}

			// If any carry bytes remaining at end of segment
			if (carryBytes.length > 0 && hits.length < limit && !truncated && !canceled) {
				totalLinesScanned++;
				lastScannedSeq = totalLinesScanned;
				const decoded = decoder.decode(carryBytes);
				if (decoded.toLowerCase().includes(lowerQuery)) {
					const displayLine = isMobileDevice ? redactSensitiveLogLine(decoded) : decoded;
					hits.push({
						line: displayLine,
						lineNo: totalLinesScanned,
						seq: totalLinesScanned,
						stream: seg.stream,
					});
					if (hits.length >= limit) {
						truncated = true;
					}
				}
			}
		}

		return Object.freeze({
			hits: Object.freeze(hits),
			truncated,
			scannedUntilSeq: lastScannedSeq,
			canceled,
		});
	}

	async function applyRetentionPolicy(
		policy: RetentionPolicyOptions,
		candidateRuns?: readonly RetentionRunRecord[],
	): Promise<RetentionCleanupReport> {
		const runs = candidateRuns ?? deps.runsRepo.findCompletedRuns?.() ?? [];
		const terminalOnly = policy.terminalOnly !== false;

		const eligibleRuns: RetentionRunRecord[] = [];
		for (const r of runs) {
			if (terminalOnly && isActiveRunState(r.state)) {
				continue;
			}
			if (!isLogPurged(r.id)) {
				eligibleRuns.push(r);
			}
		}

		const purged: PurgedRunSummary[] = [];
		let totalFreed = 0;
		const nowMsValue = nowMs();

		// 1. Purge by age (maxDays)
		if (typeof policy.maxDays === 'number' && policy.maxDays >= 0) {
			const maxAgeMs = policy.maxDays * 24 * 60 * 60 * 1000;
			for (const r of eligibleRuns) {
				const timeStr = r.endedAt ?? r.startedAt;
				const runTimeMs = timeStr ? Date.parse(timeStr) : Number.NaN;
				if (!Number.isNaN(runTimeMs) && nowMsValue - runTimeMs >= maxAgeMs) {
					const res = await purgeRunLogs({ runId: r.id, reason: 'retention_policy_age' });
					purged.push({
						runId: r.id,
						taskId: r.taskId,
						bytesFreed: res.purgedBytes,
						endedAt: r.endedAt ?? null,
					});
					totalFreed += res.purgedBytes;
				}
			}
		}

		// 2. Purge by maxTotalBytes if configured
		if (typeof policy.maxTotalBytes === 'number' && policy.maxTotalBytes > 0) {
			// Measure current captured size of remaining unpurged runs
			const remainingRuns = eligibleRuns.filter((r) => !purged.some((p) => p.runId === r.id));
			const runSizes: Array<{ run: RetentionRunRecord; bytes: number }> = [];
			let totalBytes = 0;

			for (const r of remainingRuns) {
				const runDir = deps.logstorePaths.runDir(r.id);
				let bytes = 0;
				if (fileOps.existsSync(runDir) && fileOps.readdirSync) {
					try {
						for (const f of fileOps.readdirSync(runDir)) {
							if (f !== PURGED_MARKER_FILE_NAME) {
								try {
									bytes += fileOps.statSync(join(runDir, f)).size;
								} catch {
									// Continue
								}
							}
						}
					} catch {
						// Continue
					}
				}
				runSizes.push({ run: r, bytes });
				totalBytes += bytes;
			}

			if (totalBytes > policy.maxTotalBytes) {
				// Sort oldest ended runs first
				runSizes.sort((a, b) => {
					const timeA = Date.parse(a.run.endedAt ?? a.run.startedAt ?? '0');
					const timeB = Date.parse(b.run.endedAt ?? b.run.startedAt ?? '0');
					return (Number.isNaN(timeA) ? 0 : timeA) - (Number.isNaN(timeB) ? 0 : timeB);
				});

				for (const item of runSizes) {
					if (totalBytes <= policy.maxTotalBytes) break;
					const res = await purgeRunLogs({
						runId: item.run.id,
						reason: 'retention_policy_size_cap',
					});
					purged.push({
						runId: item.run.id,
						taskId: item.run.taskId,
						bytesFreed: res.purgedBytes,
						endedAt: item.run.endedAt ?? null,
					});
					totalFreed += res.purgedBytes;
					totalBytes -= res.purgedBytes;
				}
			}
		}

		return Object.freeze({
			purgedRuns: Object.freeze(purged),
			totalBytesFreed: totalFreed,
			totalRunsEvaluated: runs.length,
		});
	}

	function getTaskRunsSummary(taskId: string): TaskRunsProgressResult {
		const runs = deps.runsRepo.findByTaskId?.(taskId) ?? [];
		const sorted = [...runs].sort((a, b) => (b.attemptNo ?? 0) - (a.attemptNo ?? 0));
		const latestRun = sorted[0] ?? null;
		const historicalRuns = sorted.slice(1);
		return Object.freeze({
			taskId,
			latestRun,
			historicalRuns: Object.freeze(historicalRuns),
		});
	}

	return Object.freeze({
		searchInRun,
		purgeRunLogs,
		applyRetentionPolicy,
		isLogPurged,
		getTaskRunsSummary,
	});
}
