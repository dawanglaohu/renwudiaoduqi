import type { ErrorCode } from '@agent-scheduler/shared/errors/codes';

export type LogStream = 'raw' | 'events';

export const LOG_STREAMS = ['raw', 'events'] as const satisfies readonly LogStream[];

/** E-149: one segment file never exceeds 200 MB. */
export const SEGMENT_SIZE_LIMIT_BYTES = 200 * 1024 * 1024;

/** One paged read returns at most this many bytes; the UI pages instead of loading whole files (E-24). */
export const READ_CHUNK_LIMIT_BYTES = 1024 * 1024;

export const RAW_STREAM_FILE_BASE = 'raw';
export const RAW_STREAM_FILE_SUFFIX = '.log';
export const EVENTS_STREAM_FILE_BASE = 'events';
export const EVENTS_STREAM_FILE_SUFFIX = '.ndjson';

export const MILESTONE_KIND_PREFIXES = ['run.', 'task.', 'batch.', 'system.', 'agent.'] as const;

export const MILESTONE_KIND_EXACT = ['tool_call', 'tool_call_update', 'plan'] as const;

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
	readonly createReadStream: (
		path: string,
		options: { readonly start: number; readonly end: number },
	) => AsyncIterable<Uint8Array>;
	/** Null instead of throwing when the file is gone (E-151). */
	readonly fileLenSync: (path: string) => number | null;
}

export interface SegmentBoundary {
	readonly stream: LogStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface EventLineLocation {
	readonly runId: string;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteOffset: number;
	readonly byteLen: number;
	readonly bytes: Uint8Array;
}

export interface AppendedEventLine {
	readonly location: EventLineLocation;
	readonly closedSegment: SegmentBoundary | null;
}

export interface AppendedRawLine {
	readonly fileSeq: number;
	readonly path: string;
	readonly byteOffset: number;
	readonly byteLen: number;
	readonly closedSegment: SegmentBoundary | null;
}

export interface StreamResumeState {
	readonly fileSeq: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface RecoveredEventLine {
	readonly location: EventLineLocation;
	readonly envelope: RecoveredEventEnvelope | null;
	readonly isComplete: boolean;
}

export interface RecoveredEventEnvelope {
	readonly id: number | null;
	readonly seq: number | null;
	readonly ts: string | null;
	readonly scope: string | null;
	readonly kind: string | null;
	readonly taskId: string | null;
	readonly actorDeviceId: string | null;
}

export interface EventIndexRecord {
	readonly id: number;
	readonly runId: string;
	readonly taskId: string | null;
	readonly seq: number;
	readonly ts: string;
	readonly scope: string;
	readonly kind: string;
	readonly actorDeviceId: string | null;
	readonly fileSeq: number;
	readonly byteOffset: number;
	readonly byteLen: number;
}

export interface SegmentInsert {
	readonly id: string;
	readonly runId: string;
	readonly stream: LogStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface SegmentRow {
	readonly id: string;
	readonly runId: string;
	readonly stream: LogStream;
	readonly fileSeq: number;
	readonly path: string;
	readonly byteStart: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface ReadSegmentResultOk {
	readonly ok: true;
	readonly data: Uint8Array;
	readonly nextCursor: string;
	readonly hasMore: boolean;
	readonly tailReached: boolean;
}

export interface ReadSegmentResultError {
	readonly ok: false;
	readonly code: Extract<ErrorCode, 'E_LOG_FILE_MISSING' | 'E_VALIDATION'>;
}

export type ReadSegmentResult = ReadSegmentResultOk | ReadSegmentResultError;

export interface RepairError {
	readonly runId: string;
	readonly path: string;
	readonly code: 'E_LOG_FILE_MISSING' | 'E_INTERNAL';
	readonly message: string;
}

export interface RepairRunReport {
	readonly runId: string;
	readonly indexedLines: number;
	readonly errors: readonly RepairError[];
}

export function isMilestoneEventKind(kind: string): boolean {
	return (
		MILESTONE_KIND_EXACT.some((exact) => exact === kind) ||
		MILESTONE_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix))
	);
}
