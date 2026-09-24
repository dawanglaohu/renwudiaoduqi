import { join } from 'node:path';
import { type EventEnvelope, isMilestoneEventKind } from '@agent-scheduler/shared/api/events';
import type { GateContextStderrTail } from '@agent-scheduler/shared/api/gates';
import type { UnitOfWork } from '../db/unit-of-work.ts';
import { AppError } from '../errors/app-error.ts';
import type { AppendQueue } from '../logstore/append-queue.ts';
import type {
	LogFileSystem,
	LogStream,
	LogstoreIds,
	ReadSegmentResult,
	ScanWindow,
	ScannedEventLine,
	SegmentBoundary,
	SegmentRowLike,
} from '../logstore/contract.ts';
import { isEnoent, toFilesystemError } from '../logstore/fs-errors.ts';
import { type LogstorePaths, parseSegmentFileName } from '../logstore/paths.ts';
import { parseEnvelopeLine, readSegmentPage } from '../logstore/read-window.ts';
import {
	type AppendResult,
	type RunLogWriter,
	createRunWriter,
	resumeRunWriterState,
} from '../logstore/run-writer.ts';
import type { EventIndexRecord, EventsIndexRepo } from '../repo/events-index-repo.ts';
import type { LogSegmentsRepo } from '../repo/log-segments-repo.ts';

/**
 * Canonical event envelope written to events.ndjson and indexed for milestones.
 * The normal-write path and the repair path produce the same envelope shape
 * and keep the envelope's existing id/seq.
 */
export type EventEnvelopeInput = EventEnvelope;

export interface AppendEventResult {
	readonly location: AppendResult;
	readonly indexed: boolean;
	readonly segmentRecorded: boolean;
	/** Non-null when the milestone/segment index write failed; bytes are still on disk. */
	readonly indexError: AppError | null;
}

export interface RepairError {
	readonly runId: string;
	readonly path: string;
	readonly code: 'E_LOG_FILE_MISSING' | 'E_VALIDATION' | 'E_DB_BUSY' | 'E_INTERNAL';
	readonly message: string;
}

export interface RepairRunReport {
	readonly runId: string;
	readonly indexedLines: number;
	readonly errors: readonly RepairError[];
}

export interface LogstoreServiceDeps {
	readonly fs: LogFileSystem;
	readonly paths: LogstorePaths;
	readonly queue: AppendQueue;
	readonly ids: LogstoreIds;
	readonly unitOfWork: UnitOfWork;
	readonly eventsIndexRepo: EventsIndexRepo;
	readonly segmentsRepo: LogSegmentsRepo;
	readonly isMilestone?: (kind: string) => boolean;
	readonly segmentSizeLimitBytes?: number;
	/**
	 * E-104: called with the run directory whenever an append rejects with
	 * E_DISK_FULL, before that rejection reaches the caller. The composition root
	 * points it at SystemService.notifyDiskFull so new dispatches halt at once.
	 */
	readonly onDiskFull?: (path: string) => void;
}

export interface LogstoreService {
	getWriter(runId: string): RunLogWriter;
	closeWriter(runId: string): Promise<void>;
	appendRaw(runId: string, line: Uint8Array): Promise<AppendResult>;
	/**
	 * Serialize the envelope, append the bytes to events.ndjson, then — inside a
	 * unitOfWork transaction — record any newly-closed segment boundary and,
	 * for milestone kinds, the index row using the envelope's existing id/seq.
	 * The file write happens first; if the index write fails, the bytes stay
	 * on disk and a later repair will back-fill them.
	 */
	appendEvent(runId: string, envelope: EventEnvelopeInput): Promise<AppendEventResult>;
	/** Paged read across segments: the cursor always advances; the tail is signalled. */
	readEventsPage(runId: string, cursor: string | undefined): Promise<ReadSegmentResult>;
	/** Bounded read of the latest run.exited event stderrTail. */
	readLatestRunExited?(runId: string): Promise<GateContextStderrTail>;
	/** Bounded scan-and-repair for one run. */
	repairRun(runId: string): Promise<RepairRunReport>;
	/** Bounded scan-and-repair for every run found in log_segments or on disk. */
	repairAll(): Promise<readonly RepairRunReport[]>;
}

export function createLogstoreService(deps: LogstoreServiceDeps): LogstoreService {
	const {
		fs,
		paths,
		queue,
		ids,
		unitOfWork,
		eventsIndexRepo,
		segmentsRepo,
		isMilestone = isMilestoneEventKind,
	} = deps;

	const writers = new Map<string, RunLogWriter>();

	async function appendOrSignalDiskFull(
		runId: string,
		write: () => Promise<AppendResult>,
	): Promise<AppendResult> {
		try {
			return await write();
		} catch (cause) {
			if (cause instanceof AppError && cause.code === 'E_DISK_FULL') {
				deps.onDiskFull?.(paths.runDir(runId));
			}
			throw cause;
		}
	}

	function buildWriter(runId: string): RunLogWriter {
		const initialState = resumeRunWriterState(fs, paths, runId);
		return createRunWriter({
			runId,
			paths,
			queue,
			fs,
			initialState,
			segmentSizeLimitBytes: deps.segmentSizeLimitBytes,
		});
	}

	function getWriter(runId: string): RunLogWriter {
		const existing = writers.get(runId);
		if (existing !== undefined) return existing;
		const next = buildWriter(runId);
		writers.set(runId, next);
		return next;
	}

	async function closeWriter(runId: string): Promise<void> {
		const writer = writers.get(runId);
		if (writer === undefined) return;
		await writer.flush();
		writers.delete(runId);
	}

	function recordClosedSegment(runId: string, seg: SegmentBoundary): void {
		unitOfWork.run(() => {
			segmentsRepo.insertSegments([
				{
					id: ids.newId(),
					runId,
					stream: seg.stream,
					fileSeq: seg.fileSeq,
					path: seg.path,
					byteStart: seg.byteStart,
					byteEnd: seg.byteEnd,
					lineCount: seg.lineCount,
				},
			]);
		});
	}

	function recordRunIndexes(
		runId: string,
		envelope: EventEnvelopeInput,
		location: AppendResult,
	): { indexed: boolean; segmentRecorded: boolean; indexError: AppError | null } {
		const result = { indexed: false, segmentRecorded: false, indexError: null as AppError | null };
		try {
			unitOfWork.run(() => {
				if (location.closedSegment !== null) {
					const seg = location.closedSegment;
					segmentsRepo.insertSegments([
						{
							id: ids.newId(),
							runId,
							stream: seg.stream,
							fileSeq: seg.fileSeq,
							path: seg.path,
							byteStart: seg.byteStart,
							byteEnd: seg.byteEnd,
							lineCount: seg.lineCount,
						},
					]);
					result.segmentRecorded = true;
				}
				if (isMilestone(envelope.kind)) {
					const record: EventIndexRecord = {
						id: envelope.id,
						runId,
						taskId: envelope.taskId,
						seq: envelope.seq,
						ts: envelope.ts,
						scope: envelope.scope,
						kind: envelope.kind,
						actorDeviceId: envelope.actorDeviceId,
						fileSeq: location.fileSeq,
						byteOffset: location.byteOffset,
						byteLen: location.byteLen,
					};
					eventsIndexRepo.insertIndex(record);
					result.indexed = true;
				}
			});
		} catch (cause) {
			// File bytes are already on disk; the next repair pass will back-fill the
			// index from the same window. A failed index insert is not a write failure
			// and must not propagate to the caller.
			result.indexError =
				cause instanceof AppError
					? cause
					: new AppError('E_INTERNAL', 'Index write failed.', { cause });
		}
		return result;
	}

	async function appendEvent(
		runId: string,
		envelope: EventEnvelopeInput,
	): Promise<AppendEventResult> {
		const bytes = encodeEnvelope(envelope);
		const writer = getWriter(runId);
		const location = await appendOrSignalDiskFull(runId, () => writer.appendEventLine(bytes));
		const result = recordRunIndexes(runId, envelope, location);
		return {
			location,
			indexed: result.indexed,
			segmentRecorded: result.segmentRecorded,
			indexError: result.indexError,
		};
	}

	async function appendRaw(runId: string, line: Uint8Array): Promise<AppendResult> {
		const writer = getWriter(runId);
		const location = await appendOrSignalDiskFull(runId, () => writer.appendRawLine(line));
		if (location.closedSegment !== null) {
			recordClosedSegment(runId, location.closedSegment);
		}
		return location;
	}

	async function readEventsPage(
		runId: string,
		cursor: string | undefined,
	): Promise<ReadSegmentResult> {
		const registered = segmentsRepo.findByRunStream(runId, 'events');
		const onDisk = discoverOnDiskSegments(fs, paths, runId, 'events');
		const bySeq = new Map<number, SegmentRowLike>();
		for (const segment of registered) {
			const fileLen = onDisk.get(segment.fileSeq);
			bySeq.set(segment.fileSeq, {
				...segment,
				byteEnd: fileLen ?? segment.byteEnd,
			});
		}
		for (const [fileSeq, byteEnd] of onDisk) {
			if (bySeq.has(fileSeq)) continue;
			bySeq.set(fileSeq, {
				id: `active:${runId}:events:${fileSeq.toString()}`,
				runId,
				stream: 'events',
				fileSeq,
				path: paths.segmentPath(runId, 'events', fileSeq),
				byteStart: 0,
				byteEnd,
				lineCount: 0,
			});
		}
		const segments = [...bySeq.values()].sort((a, b) => a.fileSeq - b.fileSeq);
		const effectiveCursor = cursor ?? '0:0';
		return readSegmentPage(segments, effectiveCursor, fs);
	}

	async function repairRun(runId: string): Promise<RepairRunReport> {
		const errors: RepairError[] = [];
		let indexedLines = 0;
		const indexedFileSeq = eventsIndexRepo.lastIndexedFileSeq(runId);
		const indexedEndInLatestFile = eventsIndexRepo.lastIndexedEnd(runId);
		const segments = segmentsRepo.findByRunStream(runId, 'events');
		const onDisk = discoverOnDiskSegments(fs, paths, runId, 'events');

		// One window per on-disk (or registered-but-missing) events file, starting
		// after the last indexed byte in that fileSeq. Unregistered active tails
		// use the same start rule so a never-rotated run is not rescanned from 0.
		const windows: { window: ScanWindow; cursor: number }[] = [];
		const registeredBySeq = new Map(segments.map((seg) => [seg.fileSeq, seg]));
		const fileSeqs = new Set<number>([...registeredBySeq.keys(), ...onDisk.keys()]);
		for (const fileSeq of [...fileSeqs].sort((a, b) => a - b)) {
			const registered = registeredBySeq.get(fileSeq);
			const path = registered?.path ?? paths.segmentPath(runId, 'events', fileSeq);
			const fileLen = onDisk.get(fileSeq);
			if (fileLen === undefined) {
				errors.push({
					runId,
					path,
					code: 'E_LOG_FILE_MISSING',
					message: `registered segment ${fileSeq} missing on disk`,
				});
				continue;
			}
			let start: number;
			if (indexedFileSeq === null) {
				start = 0;
			} else if (fileSeq < indexedFileSeq) {
				start = fileLen;
			} else if (fileSeq === indexedFileSeq) {
				start = indexedEndInLatestFile;
			} else {
				start = 0;
			}
			if (start > fileLen) {
				errors.push({
					runId,
					path,
					code: 'E_VALIDATION',
					message: `index ahead of file (indexed=${start},file=${fileLen})`,
				});
				continue;
			}
			if (start < fileLen) {
				windows.push({
					window: { runId, path, fileSeq, start, endExclusive: fileLen },
					cursor: start,
				});
			}
		}

		// Repair is idempotent: every scan is bounded, so a second invocation
		// after a clean shutdown finds every window already at EOF and inserts
		// nothing.
		for (const entry of windows) {
			let buf: Uint8Array;
			try {
				buf = await fs.readRange(entry.window.path, entry.cursor, entry.window.endExclusive - 1);
			} catch (cause) {
				if (isEnoent(cause)) {
					errors.push({
						runId,
						path: entry.window.path,
						code: 'E_LOG_FILE_MISSING',
						message: 'file deleted between discovery and read',
					});
					continue;
				}
				throw toFilesystemError(cause, 'Failed to read log file during repair.');
			}
			const lines = scanEventLines(buf);
			for (const line of lines) {
				const byteOffset = entry.cursor;
				entry.cursor += line.lineLen;
				const env = line.envelope;
				if (env === null) continue;
				if (!line.complete) continue;
				if (env.kind === null || env.scope === null || env.ts === null) continue;
				if (env.id === null || env.seq === null) continue;
				if (!isMilestone(env.kind)) continue;
				const record: EventIndexRecord = {
					id: env.id,
					runId,
					taskId: env.taskId,
					seq: env.seq,
					ts: env.ts,
					scope: env.scope,
					kind: env.kind,
					actorDeviceId: env.actorDeviceId,
					fileSeq: entry.window.fileSeq,
					byteOffset,
					byteLen: line.lineLen,
				};
				try {
					unitOfWork.run(() => {
						eventsIndexRepo.insertIndex(record);
					});
					indexedLines += 1;
				} catch (cause) {
					const err = cause as AppError;
					errors.push({
						runId,
						path: entry.window.path,
						code: err?.code === 'E_DB_BUSY' ? 'E_DB_BUSY' : 'E_INTERNAL',
						message: `index insert failed: ${err?.message ?? 'unknown'}`,
					});
					break;
				}
			}
		}

		return { runId, indexedLines, errors: Object.freeze(errors) };
	}

	async function repairAll(): Promise<readonly RepairRunReport[]> {
		const reports: RepairRunReport[] = [];
		const runIds = new Set<string>();
		for (const seg of segmentsRepo.listAll()) runIds.add(seg.runId);
		let names: readonly string[] = [];
		try {
			names = fs.listDirectory(paths.rootDir);
		} catch (cause) {
			if (!isEnoent(cause)) throw toFilesystemError(cause, 'Failed to list log root.');
		}
		for (const name of names) {
			if (discoverOnDiskSegments(fs, paths, name, 'events').size > 0) {
				runIds.add(name);
			}
		}
		for (const runId of runIds) {
			reports.push(await repairRun(runId));
		}
		return Object.freeze(reports);
	}

	return Object.freeze({
		getWriter,
		closeWriter,
		appendRaw,
		appendEvent,
		readEventsPage,
		readLatestRunExited: (runId: string) => readRunExitedStderrTail({ paths, fs, runId }),
		repairRun,
		repairAll,
	});
}

function encodeEnvelope(envelope: EventEnvelopeInput): Uint8Array {
	const json = JSON.stringify({
		id: envelope.id,
		seq: envelope.seq,
		ts: envelope.ts,
		runId: envelope.runId,
		taskId: envelope.taskId,
		scope: envelope.scope,
		kind: envelope.kind,
		actorDeviceId: envelope.actorDeviceId,
		payload: envelope.payload,
	});
	return new TextEncoder().encode(json);
}

function discoverOnDiskSegments(
	fs: Pick<LogFileSystem, 'listDirectory' | 'fileLenSync'>,
	paths: LogstorePaths,
	runId: string,
	stream: LogStream,
): Map<number, number> {
	const out = new Map<number, number>();
	let names: readonly string[];
	try {
		names = fs.listDirectory(paths.runDir(runId));
	} catch (cause) {
		if (isEnoent(cause)) return out;
		throw toFilesystemError(cause, 'Failed to list log directory.');
	}
	for (const name of names) {
		const seq = parseDiskFileSeq(name);
		if (seq === null) continue;
		const path = paths.segmentPath(runId, stream, seq);
		const size = fs.fileLenSync(path);
		if (size === null) continue;
		out.set(seq, size);
	}
	return out;
}

function parseDiskFileSeq(name: string): number | null {
	for (const [base, suffix] of [
		['raw', '.log'],
		['events', '.ndjson'],
	] as const) {
		const tail = name.slice(0, name.length - suffix.length);
		if (tail === base) return 0;
		if (tail.startsWith(`${base}-`)) {
			const n = Number.parseInt(tail.slice(base.length + 1), 10);
			if (Number.isSafeInteger(n) && n >= 0) return n;
		}
	}
	return null;
}

function scanEventLines(buf: Uint8Array): readonly ScannedEventLine[] {
	const lines: ScannedEventLine[] = [];
	for (const slice of splitBytesLines(buf)) {
		lines.push({
			line: slice.bytes,
			lineLen: slice.lenWithLf,
			envelope: parseEnvelopeLine(slice.bytes),
			complete: slice.complete,
		});
	}
	return lines;
}

function splitBytesLines(
	buf: Uint8Array,
): readonly { bytes: Uint8Array; lenWithLf: number; complete: boolean }[] {
	const lines: { bytes: Uint8Array; lenWithLf: number; complete: boolean }[] = [];
	let start = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0x0a) {
			lines.push({ bytes: buf.subarray(start, i), lenWithLf: i + 1 - start, complete: true });
			start = i + 1;
		}
	}
	if (start < buf.length) {
		lines.push({
			bytes: buf.subarray(start, buf.length),
			lenWithLf: buf.length - start,
			complete: false,
		});
	}
	return lines;
}

export interface ReadRunExitedTailOptions {
	readonly paths: LogstorePaths;
	readonly fs: LogFileSystem;
	readonly runId: string;
	readonly altRunDir?: string;
}

const BOUNDED_READ_WINDOW_BYTES = 64 * 1024;
const MAX_SEARCH_SPAN_BYTES = 256 * 1024;

export async function readRunExitedStderrTail(
	options: ReadRunExitedTailOptions,
): Promise<GateContextStderrTail> {
	const { paths, fs, runId, altRunDir } = options;

	const candidateDirs = [paths.runDir(runId)];
	if (altRunDir && altRunDir !== paths.runDir(runId)) {
		candidateDirs.push(altRunDir);
	}

	let targetFile: string | null = null;

	for (const dir of candidateDirs) {
		let names: readonly string[] = [];
		try {
			names = fs.listDirectory(dir);
		} catch {
			continue;
		}

		const eventFiles: { name: string; fileSeq: number }[] = [];
		for (const name of names) {
			const parsed = parseSegmentFileName(name);
			if (parsed?.stream === 'events') {
				eventFiles.push({ name, fileSeq: parsed.fileSeq });
			}
		}

		if (eventFiles.length > 0) {
			eventFiles.sort((a, b) => b.fileSeq - a.fileSeq);
			const top = eventFiles[0];
			if (top) {
				targetFile = join(dir, top.name);
				break;
			}
		}
	}

	if (!targetFile) {
		return { kind: 'unavailable', reason: 'event_missing', lines: [] };
	}

	let fileLen: number | null = null;
	try {
		fileLen = fs.fileLenSync(targetFile);
	} catch {
		return { kind: 'unavailable', reason: 'event_missing', lines: [] };
	}

	if (fileLen === null || fileLen === 0) {
		return { kind: 'unavailable', reason: 'event_missing', lines: [] };
	}

	let currentEnd = fileLen - 1;
	let totalBytesRead = 0;
	let residualText = '';

	while (currentEnd >= 0 && totalBytesRead < MAX_SEARCH_SPAN_BYTES) {
		const chunkSize = Math.min(currentEnd + 1, BOUNDED_READ_WINDOW_BYTES);
		const start = currentEnd + 1 - chunkSize;
		let chunkBytes: Uint8Array;
		try {
			chunkBytes = await fs.readRange(targetFile, start, currentEnd);
		} catch {
			return { kind: 'unavailable', reason: 'event_missing', lines: [] };
		}
		totalBytesRead += chunkBytes.length;

		const chunkText = Buffer.from(chunkBytes).toString('utf8') + residualText;
		const lines = chunkText.split(/\r?\n/);
		if (start > 0) {
			residualText = lines.shift() ?? '';
		} else {
			residualText = '';
		}

		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i]?.trim();
			if (!line || !line.includes('"run.exited"')) continue;
			try {
				const parsed = JSON.parse(line);
				if (parsed.kind === 'run.exited') {
					const tail = parsed.payload?.stderrTail;
					if (Array.isArray(tail)) {
						return { kind: 'lines', lines: tail };
					}
					return { kind: 'unavailable', reason: 'legacy_run', lines: [] };
				}
			} catch {
				// parse failure on incomplete line, continue
			}
		}

		currentEnd = start - 1;
	}

	return { kind: 'unavailable', reason: 'event_missing', lines: [] };
}
