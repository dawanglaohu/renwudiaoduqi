import type { AppendQueue } from './append-queue.ts';
import type { LogFileSystem, LogStream, SegmentBoundary, SegmentRowLike } from './contract.ts';
import { SEGMENT_SIZE_LIMIT_BYTES } from './contract.ts';
import type { LogstorePaths } from './paths.ts';

export interface StreamOffset {
	readonly fileSeq: number;
	readonly byteEnd: number;
	readonly lineCount: number;
}

export interface RunWriterInitialState {
	readonly raw?: StreamOffset;
	readonly events?: StreamOffset;
}

export interface AppendResult {
	readonly fileSeq: number;
	readonly path: string;
	readonly byteOffset: number;
	/** Bytes including the trailing LF. */
	readonly byteLen: number;
	readonly closedSegment: SegmentBoundary | null;
}

export interface RunLogWriter {
	appendRawLine(line: Uint8Array): Promise<AppendResult>;
	appendEventLine(line: Uint8Array): Promise<AppendResult>;
	flush(): Promise<void>;
	resumeState(): RunWriterInitialState;
}

interface OpenStreamState {
	fileSeq: number;
	byteEnd: number;
	lineCount: number;
}

const NEWLINE = new Uint8Array([0x0a]);
const ZERO_OFFSET: StreamOffset = { fileSeq: 0, byteEnd: 0, lineCount: 0 };

export interface CreateRunWriterDeps {
	readonly runId: string;
	readonly paths: LogstorePaths;
	readonly queue: AppendQueue;
	readonly fs: Pick<LogFileSystem, 'mkdirSync' | 'appendFile' | 'fileLenSync'>;
	readonly segmentSizeLimitBytes?: number;
	readonly initialState?: RunWriterInitialState;
}

/**
 * Per-run append writer for raw.log and events.ndjson. The writer itself is
 * file-only (logstore layer, R5); it never reads the segments repo or the index.
 *
 * Concurrency: per-run serialization via AppendQueue plus an internal promise
 * chain, so a resolved `appendEventLine` means those bytes are persisted to
 * disk and the returned offsets are accurate. The caller may then write the
 * milestone index in a unitOfWork transaction — that write is outside the
 * writer, so file-first ordering is preserved (R1).
 *
 * Recovery: construction takes an `initialState` derived from on-disk scan,
 * so rebuilding a writer for an existing run does NOT restart at fileSeq 0
 * or byteOffset 0 (R1).
 */
export function createRunWriter(deps: CreateRunWriterDeps): RunLogWriter {
	const { runId, paths, queue, fs } = deps;
	const segmentSizeLimit = deps.segmentSizeLimitBytes ?? SEGMENT_SIZE_LIMIT_BYTES;
	const raw: OpenStreamState = { ...ZERO_OFFSET, ...(deps.initialState?.raw ?? {}) };
	const events: OpenStreamState = { ...ZERO_OFFSET, ...(deps.initialState?.events ?? {}) };

	let chain: Promise<unknown> = Promise.resolve();
	let directoryCreated = false;

	function get(stream: LogStream): OpenStreamState {
		return stream === 'raw' ? raw : events;
	}

	async function ensureDirectory(): Promise<void> {
		if (directoryCreated) return;
		fs.mkdirSync(paths.runDir(runId));
		directoryCreated = true;
	}

	async function performAppend(stream: LogStream, line: Uint8Array): Promise<AppendResult> {
		await ensureDirectory();
		const state = get(stream);
		const incomingBytes = line.byteLength + 1;

		let closedSegment: SegmentBoundary | null = null;
		if (state.byteEnd + incomingBytes > segmentSizeLimit) {
			closedSegment = {
				stream,
				fileSeq: state.fileSeq,
				path: paths.segmentPath(runId, stream, state.fileSeq),
				byteStart: 0,
				byteEnd: state.byteEnd,
				lineCount: state.lineCount,
			};
			state.fileSeq += 1;
			state.byteEnd = 0;
			state.lineCount = 0;
		}

		const fileSeq = state.fileSeq;
		const path = paths.segmentPath(runId, stream, state.fileSeq);
		const framed = new Uint8Array(incomingBytes);
		framed.set(line, 0);
		framed[incomingBytes - 1] = NEWLINE[0] ?? 0x0a;
		await queue.append(path, framed);
		const byteOffset = state.byteEnd;
		state.byteEnd += incomingBytes;
		state.lineCount += 1;
		return {
			fileSeq,
			path,
			byteOffset,
			byteLen: incomingBytes,
			closedSegment,
		};
	}

	function enqueue(stream: LogStream, line: Uint8Array): Promise<AppendResult> {
		const task = chain.then(() => performAppend(stream, line));
		chain = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	return Object.freeze({
		appendRawLine(line: Uint8Array): Promise<AppendResult> {
			return enqueue('raw', line);
		},
		appendEventLine(line: Uint8Array): Promise<AppendResult> {
			return enqueue('events', line);
		},
		async flush(): Promise<void> {
			await chain;
		},
		resumeState(): RunWriterInitialState {
			return {
				raw: { fileSeq: raw.fileSeq, byteEnd: raw.byteEnd, lineCount: raw.lineCount },
				events: { fileSeq: events.fileSeq, byteEnd: events.byteEnd, lineCount: events.lineCount },
			};
		},
	});
}

/**
 * Probe a run directory for existing segment files and return the offset state
 * needed to rebuild a writer for it (R1). If the directory is empty or missing,
 * returns the zero state — first append will create the directory.
 *
 * This is a file-only scan, no SQL or DB access (R5).
 */
export function resumeRunWriterState(
	fs: Pick<LogFileSystem, 'listDirectory' | 'fileLenSync'>,
	paths: LogstorePaths,
	runId: string,
): RunWriterInitialState {
	const dir = paths.runDir(runId);
	let names: readonly string[];
	try {
		names = fs.listDirectory(dir);
	} catch {
		return {};
	}
	return scanDirectoryState(names, fs, paths, runId);
}

function scanDirectoryState(
	names: readonly string[],
	fs: Pick<LogFileSystem, 'fileLenSync'>,
	paths: LogstorePaths,
	runId: string,
): RunWriterInitialState {
	const raw = latestSegment(names, fs, paths, runId, 'raw');
	const events = latestSegment(names, fs, paths, runId, 'events');
	return {
		raw: raw ?? undefined,
		events: events ?? undefined,
	};
}

function latestSegment(
	names: readonly string[],
	fs: Pick<LogFileSystem, 'fileLenSync'>,
	paths: LogstorePaths,
	runId: string,
	stream: LogStream,
): StreamOffset | null {
	const base = stream === 'events' ? 'events' : 'raw';
	const suffix = stream === 'events' ? '.ndjson' : '.log';
	let best: StreamOffset | null = null;
	for (const name of names) {
		const seq = parseFileSeq(name, base, suffix);
		if (seq === null) continue;
		const path = paths.segmentPath(runId, stream, seq);
		const size = fs.fileLenSync(path);
		if (size === null) continue;
		if (best === null || seq > best.fileSeq) {
			best = { fileSeq: seq, byteEnd: size, lineCount: 0 };
		}
	}
	return best;
}

function parseFileSeq(name: string, base: string, suffix: string): number | null {
	const baseName = name.slice(0, name.length - suffix.length);
	if (baseName === base) return 0;
	if (baseName.startsWith(`${base}-`)) {
		const tail = baseName.slice(base.length + 1);
		const n = Number.parseInt(tail, 10);
		if (Number.isSafeInteger(n) && n >= 0) return n;
	}
	return null;
}

export function toSegmentBoundary(row: SegmentRowLike): SegmentBoundary {
	return {
		stream: row.stream,
		fileSeq: row.fileSeq,
		path: row.path,
		byteStart: row.byteStart,
		byteEnd: row.byteEnd,
		lineCount: row.lineCount,
	};
}
