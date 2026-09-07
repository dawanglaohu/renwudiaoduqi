export type RunLogStream = 'raw' | 'events';

import type { EventsIndexRepo } from '../repo/events-index-repo.ts';
import type { LogSegmentsRepo } from '../repo/log-segments-repo.ts';
import type { AppendQueue } from './append-queue.ts';
import type { EventIndexRecord, LogstoreIds, SegmentInsert } from './contract.ts';
import { SEGMENT_SIZE_LIMIT_BYTES } from './contract.ts';
import type { LogstorePaths } from './paths.ts';

export interface RunLogWriterDeps {
	readonly runId: string;
	readonly paths: LogstorePaths;
	readonly queue: AppendQueue;
	readonly ids: LogstoreIds;
	readonly segmentsRepo: LogSegmentsRepo;
	readonly eventsIndexRepo: EventsIndexRepo;
	/** Defaults to SEGMENT_SIZE_LIMIT_BYTES (200 MB). Injectable so tests can rotate megabytes, not hundreds. */
	readonly segmentSizeLimitBytes?: number;
}

export interface AppendedEvent
	extends Omit<EventIndexRecord, 'runId' | 'fileSeq' | 'byteOffset' | 'byteLen'> {
	readonly bytes: Uint8Array;
}

/**
 * Per-run writer for raw.log / events.ndjson.
 *
 * Invariants (08 节): file bytes land first, index rows second — never the
 * other way round. Rotation closes the segment and writes its log_segments
 * row before the next line is appended to the fresh file (E-149).
 */
export interface RunLogWriter {
	appendRawLine(line: Uint8Array): Promise<void>;
	appendEventLine(event: AppendedEvent): Promise<void>;
	/** Wait for all queued bytes to be on disk, then close the open segments. */
	flush(): Promise<void>;
}

interface OpenStream {
	fileSeq: number;
	byteEnd: number;
	lineCount: number;
	dirty: boolean;
}

const NEWLINE = new Uint8Array([0x0a]);

export function createRunLogWriter(deps: RunLogWriterDeps): RunLogWriter {
	const { runId, paths, queue, ids, segmentsRepo, eventsIndexRepo } = deps;
	const segmentSizeLimit = deps.segmentSizeLimitBytes ?? SEGMENT_SIZE_LIMIT_BYTES;

	const raw: OpenStream = { fileSeq: 0, byteEnd: 0, lineCount: 0, dirty: false };
	const events: OpenStream = { fileSeq: 0, byteEnd: 0, lineCount: 0, dirty: false };

	function streamFor(kind: RunLogStream): OpenStream {
		return kind === 'raw' ? raw : events;
	}

	async function closeSegment(stream: OpenStream, kind: RunLogStream): Promise<void> {
		if (!stream.dirty) return;
		const insert: SegmentInsert = {
			id: ids.newId(),
			runId,
			stream: kind,
			fileSeq: stream.fileSeq,
			path: paths.segmentPath(runId, kind, stream.fileSeq),
			byteStart: 0,
			byteEnd: stream.byteEnd,
			lineCount: stream.lineCount,
		};
		segmentsRepo.insertSegments([insert]);
		stream.dirty = false;
	}

	async function maybeRotate(
		stream: OpenStream,
		kind: RunLogStream,
		incomingBytes: number,
	): Promise<void> {
		if (stream.byteEnd + incomingBytes <= segmentSizeLimit) return;
		await queue.drain();
		await closeSegment(stream, kind);
		stream.fileSeq += 1;
		stream.byteEnd = 0;
		stream.lineCount = 0;
	}

	async function appendRawLine(line: Uint8Array): Promise<void> {
		const incoming = line.byteLength + 1;
		await maybeRotate(raw, 'raw', incoming);
		await queue.append(paths.segmentPath(runId, 'raw', raw.fileSeq), line);
		await queue.append(paths.segmentPath(runId, 'raw', raw.fileSeq), NEWLINE);
		raw.byteEnd += incoming;
		raw.lineCount += 1;
		raw.dirty = true;
	}

	async function appendEventLine(event: AppendedEvent): Promise<void> {
		const { bytes, ...rest } = event;
		const incoming = bytes.byteLength + 1;
		await maybeRotate(events, 'events', incoming);
		await queue.append(paths.segmentPath(runId, 'events', events.fileSeq), bytes);
		await queue.append(paths.segmentPath(runId, 'events', events.fileSeq), NEWLINE);
		// Index row strictly after the file append resolved — no reverse ordering anywhere.
		eventsIndexRepo.insertIndex({
			...rest,
			runId,
			fileSeq: events.fileSeq,
			byteOffset: events.byteEnd,
			byteLen: incoming,
		});
		events.byteEnd += incoming;
		events.lineCount += 1;
		events.dirty = true;
	}

	async function flush(): Promise<void> {
		await queue.drain();
		await closeSegment(raw, 'raw');
		await closeSegment(events, 'events');
	}

	return Object.freeze({ appendRawLine, appendEventLine, flush });
}
