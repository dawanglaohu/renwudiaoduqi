import { join } from 'node:path';
import {
	EVENTS_STREAM_FILE_BASE,
	EVENTS_STREAM_FILE_SUFFIX,
	type LogStream,
	RAW_STREAM_FILE_BASE,
	RAW_STREAM_FILE_SUFFIX,
} from './contract.ts';

export interface LogstorePaths {
	readonly rootDir: string;
	readonly runDir: (runId: string) => string;
	readonly segmentPath: (runId: string, stream: LogStream, fileSeq: number) => string;
}

export function createLogstorePaths(baseDir: string): LogstorePaths {
	return Object.freeze({
		rootDir: baseDir,
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

export function parseSegmentFileName(
	fileName: string,
): { stream: LogStream; fileSeq: number } | null {
	if (fileName === `${RAW_STREAM_FILE_BASE}${RAW_STREAM_FILE_SUFFIX}`) {
		return { stream: 'raw', fileSeq: 0 };
	}
	if (fileName === `${EVENTS_STREAM_FILE_BASE}${EVENTS_STREAM_FILE_SUFFIX}`) {
		return { stream: 'events', fileSeq: 0 };
	}
	const rawMatch = new RegExp(
		`^${RAW_STREAM_FILE_BASE}-(\\d+)${escapeRegExp(RAW_STREAM_FILE_SUFFIX)}$`,
	).exec(fileName);
	if (rawMatch?.[1] !== undefined) {
		return { stream: 'raw', fileSeq: Number.parseInt(rawMatch[1], 10) };
	}
	const eventsMatch = new RegExp(
		`^${EVENTS_STREAM_FILE_BASE}-(\\d+)${escapeRegExp(EVENTS_STREAM_FILE_SUFFIX)}$`,
	).exec(fileName);
	if (eventsMatch?.[1] !== undefined) {
		return { stream: 'events', fileSeq: Number.parseInt(eventsMatch[1], 10) };
	}
	return null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
