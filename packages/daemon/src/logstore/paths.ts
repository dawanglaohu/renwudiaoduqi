import { join } from 'node:path';
import {
	EVENTS_STREAM_FILE_BASE,
	EVENTS_STREAM_FILE_SUFFIX,
	type LogFileSystem,
	type LogStream,
	RAW_STREAM_FILE_BASE,
	RAW_STREAM_FILE_SUFFIX,
} from './contract.ts';

export interface LogstorePaths {
	readonly runDir: (runId: string) => string;
	/** Absolute path of one segment file. Segment 0 has no numeric suffix to keep the 06/08 节 names raw.log / events.ndjson. */
	readonly segmentPath: (runId: string, stream: LogStream, fileSeq: number) => string;
}

export function createLogstorePaths(baseDir: string): LogstorePaths {
	return Object.freeze({
		runDir(runId: string): string {
			return join(baseDir, runId);
		},
		segmentPath(runId: string, stream: LogStream, fileSeq: number): string {
			const base = stream === 'events' ? EVENTS_STREAM_FILE_BASE : RAW_STREAM_FILE_BASE;
			const suffix = stream === 'events' ? EVENTS_STREAM_FILE_SUFFIX : RAW_STREAM_FILE_SUFFIX;
			const name = fileSeq === 0 ? `${base}${suffix}` : `${base}-${fileSeq}${suffix}`;
			return join(baseDir, runId, name);
		},
	});
}

/** Null-safe byte length of a file: null means the file is gone (E-151), never throws ENOENT. */
export function fileLenOrNull(fs: LogFileSystem, path: string): number | null {
	return fs.fileLenSync(path);
}
