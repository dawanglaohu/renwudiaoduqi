import type { ErrorCode } from '@agent-scheduler/shared/errors/codes';

export type LogStream = 'raw' | 'events';

export const LOG_STREAMS = ['raw', 'events'] as const satisfies readonly LogStream[];

/** E-149: one segment file never exceeds 200 MB. */
export const SEGMENT_SIZE_LIMIT_BYTES = 200 * 1024 * 1024;

/** Default warning threshold: 10 GB (E-103). */
export const DEFAULT_DISK_WARN_THRESHOLD_BYTES = 10 * 1024 * 1024 * 1024;

/** Default low disk free threshold: 500 MB (E-104). */
export const DEFAULT_FREE_DISK_THRESHOLD_BYTES = 500 * 1024 * 1024;

/** One paged read returns at most this many bytes; the UI pages instead of loading whole files (E-24). */
export const READ_CHUNK_LIMIT_BYTES = 1024 * 1024;

export const RAW_STREAM_FILE_BASE = 'raw';
export const RAW_STREAM_FILE_SUFFIX = '.log';
export const EVENTS_STREAM_FILE_BASE = 'events';
export const EVENTS_STREAM_FILE_SUFFIX = '.ndjson';

export interface LogstoreClock {
	readonly now: () => string;
}

export interface LogstoreIds {
	readonly newId: () => string;
}

export interface LogFileSystem {
	readonly mkdirSync: (path: string) => void;
	readonly listDirectory: (path: string) => readonly string[];
	readonly appendFile: (path: string, data: Uint8Array) => Promise<void>;
	readonly readFile: (path: string) => Promise<Uint8Array>;
	/** Read bytes [start, endInclusive] from a file. */
	readonly readRange: (path: string, start: number, endInclusive: number) => Promise<Uint8Array>;
	/** Byte length, or null when the file is gone (E-151). */
	readonly fileLenSync: (path: string) => number | null;
	/**
	 * Remove a file, or a directory with its contents. Rejects with an AppError:
	 * E_LOG_FILE_MISSING when the path is gone, otherwise E_INTERNAL carrying the
	 * native cause (EBUSY/EPERM included; primitives.ts turns that into a retry).
	 */
	readonly deleteFile: (path: string) => Promise<void>;
	/** Shrink a file to targetBytes. Same rejection contract as deleteFile. */
	readonly truncateFile: (path: string, targetBytes: number) => Promise<void>;
	/**
	 * Volume statistics for the filesystem holding `path`; when `path` does not
	 * exist yet the nearest existing ancestor answers, so a fresh data directory
	 * is measurable before the first run writes anything.
	 */
	readonly statfs: (path: string) => Promise<VolumeStats>;
}

export interface VolumeStats {
	/** Blocks available to this process. */
	readonly bavail: number;
	readonly bsize: number;
	readonly blocks: number;
}

export interface SegmentRowLike {
	readonly id: string;
	readonly runId: string;
	readonly stream: LogStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface SegmentBoundary {
	readonly stream: LogStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export type LineSeverity = 'std' | 'err';
export type MergedSource = 'raw' | 'events';

/**
 * One physical event line recovered from events.ndjson during a repair scan.
 *
 * - `line` is the exact bytes on disk (without the trailing LF).
 * - `envelope` is the parsed JSON fields when the line is a complete, well-formed
 *   envelope; a "null envelope" means a line whose fields are missing or
 *   non-string (`ts`/`scope`/`kind` are required for the index).
 * - `complete` marks lines terminated by an LF (a truncated tail line has no LF
 *   and is treated as garbage, never re-attached to a following append).
 */
export interface ScannedEventLine {
	readonly line: Uint8Array;
	readonly lineLen: number; // bytes including the trailing LF
	readonly envelope: ScannedEnvelope | null;
	readonly complete: boolean;
}

export interface ScannedEnvelope {
	readonly id: number | null;
	readonly seq: number | null;
	readonly ts: string | null;
	readonly scope: string | null;
	readonly kind: string | null;
	readonly taskId: string | null;
	readonly actorDeviceId: string | null;
}

/** Scan one segment of events.ndjson from `start` to `endExclusive`. */
export interface ScanWindow {
	readonly runId: string;
	readonly path: string;
	readonly fileSeq: number;
	readonly start: number;
	readonly endExclusive: number;
}

export type ReadSegmentResult =
	| ReadSegmentResultOk
	| {
			readonly ok: false;
			readonly code: Extract<ErrorCode, 'E_LOG_FILE_MISSING' | 'E_VALIDATION'>;
	  };

export interface ReadSegmentResultOk {
	readonly ok: true;
	readonly data: Uint8Array;
	readonly nextCursor: string;
	readonly hasMore: boolean;
	readonly tailReached: boolean;
}

export interface DeleteResultSuccess {
	readonly ok: true;
	readonly path: string;
	readonly bytesFreed: number;
}

export interface TruncateResultSuccess {
	readonly ok: true;
	readonly path: string;
	readonly bytesFreed: number;
	readonly newSize: number;
}

/**
 * Failure of a restricted delete or truncate. `EBUSY` is the only retryable
 * code (E-204: another handle still reads the file, so the caller skips it this
 * pass and retries next pass); `E_FORBIDDEN` marks a whitelist violation (E-206).
 */
export interface RestrictedOpFailure {
	readonly ok: false;
	readonly retryable: boolean;
	readonly code: 'EBUSY' | 'E_FORBIDDEN' | 'E_LOG_FILE_MISSING' | 'E_INTERNAL';
	readonly message: string;
	readonly path: string;
}

export type DeleteResult = DeleteResultSuccess | RestrictedOpFailure;

export type TruncateResult = TruncateResultSuccess | RestrictedOpFailure;

export interface RunUsage {
	readonly runId: string;
	readonly bytes: number;
	readonly fileCount: number;
}

/** Usage of the run log root; `byRun` is sorted by bytes descending (E-103 banner order). */
export interface DiskUsageReport {
	readonly dataDirBytes: number;
	readonly byRun: readonly RunUsage[];
	readonly warnThreshold: number;
	/** Undefined when the volume does not answer statfs. */
	readonly freeBytes?: number;
	readonly totalBytes?: number;
	readonly isWarnThresholdExceeded: boolean;
	/** The volume reports zero available blocks. */
	readonly isDiskFull: boolean;
}

export { isMilestoneEventKind } from '@agent-scheduler/shared/api/events';
