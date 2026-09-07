import type { AppendQueue } from './append-queue.ts';
import type { LogFileSystem, LogStream, SegmentBoundary, StreamResumeState } from './contract.ts';
import { SEGMENT_SIZE_LIMIT_BYTES } from './contract.ts';
import type { LogstorePaths } from './paths.ts';

export interface RawAppendResult {
	readonly fileSeq: number;
	readonly path: string;
	readonly byteOffset: number;
	readonly byteLen: number;
	readonly closedSegment: SegmentBoundary | null;
}

export interface RunLogWriter {
	appendRawLine(line: Uint8Array): Promise<RawAppendResult>;
	appendEventLine(line: Uint8Array): Promise<RawAppendResult>;
	flush(): Promise<void>;
}

interface OpenStreamState {
	fileSeq: number;
	byteEnd: number;
	lineCount: number;
}

const INITIAL_STATE: StreamResumeState = { fileSeq: 0, byteEnd: 0, lineCount: 0 };

export function createRunWriter(deps: {
	readonly runId: string;
	readonly paths: LogstorePaths;
	readonly queue: AppendQueue;
	readonly fs: LogFileSystem;
	readonly ids: { newId: () => string };
	readonly segmentSizeLimitBytes?: number;
	readonly initialStates?: Partial<Record<LogStream, StreamResumeState>>;
}): RunLogWriter {
	const { runId, paths, queue, fs } = deps;
	const segmentSizeLimit = deps.segmentSizeLimitBytes ?? SEGMENT_SIZE_LIMIT_BYTES;

	let chain: Promise<void> = Promise.resolve();
	let directoryCreated = false;
	const closedSegments: SegmentBoundary[] = [];

	async function ensureDirectory(): Promise<void> {
		if (directoryCreated) return;
		fs.mkdirSync(paths.runDir(runId));
		directoryCreated = true;
	}

	const rawState: OpenStreamState = { ...INITIAL_STATE, ...(deps.initialStates?.raw ?? {}) };
	const eventsState: OpenStreamState = { ...INITIAL_STATE, ...(deps.initialStates?.events ?? {}) };

	async function performAppend(
		stream: LogStream,
		line: Uint8Array,
	): Promise<{
		fileSeq: number;
		path: string;
		closedSegment: SegmentBoundary | null;
		byteOffset: number;
		byteLen: number;
	}> {
		await ensureDirectory();

		const state = stream === 'raw' ? rawState : eventsState;
		const incomingBytes = line.byteLength + 1;

		if (state.byteEnd + incomingBytes > segmentSizeLimit) {
			const closed: SegmentBoundary = {
				stream,
				fileSeq: state.fileSeq,
				path: paths.segmentPath(runId, stream, state.fileSeq),
				byteStart: 0,
				byteEnd: state.byteEnd,
				lineCount: state.lineCount,
			};
			closedSegments.push(closed);
			state.fileSeq += 1;
			state.byteEnd = 0;
			state.lineCount = 0;
		}

		const fileSeq = state.fileSeq;
		const path = paths.segmentPath(runId, stream, state.fileSeq);
		await queue.append(path, line);
		await queue.append(path, NEWLINE);
		const byteOffset = state.byteEnd;
		state.byteEnd += incomingBytes;
		state.lineCount += 1;

		return {
			fileSeq,
			path,
			closedSegment:
				closedSegments.length > 0 && closedSegments[closedSegments.length - 1]?.fileSeq === fileSeq
					? null
					: (closedSegments.pop() ?? null),
			byteOffset,
			byteLen: incomingBytes,
		};
	}

	return Object.freeze({
		async appendRawLine(line: Uint8Array) {
			const task = chain.then(() => performAppend('raw', line));
			chain = task.then(
				() => undefined,
				() => undefined,
			);
			return task;
		},
		async appendEventLine(line: Uint8Array) {
			const task = chain.then(() => performAppend('events', line));
			chain = task.then(
				() => undefined,
				() => undefined,
			);
			return task;
		},
		async flush(): Promise<void> {
			await chain;
			closedSegments.length = 0;
		},
	});
}

const NEWLINE = new Uint8Array([0x0a]);
