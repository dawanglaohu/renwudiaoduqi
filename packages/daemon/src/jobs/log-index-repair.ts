import type { SegmentRow } from '../logstore/contract.ts';

export interface LogstoreJob {
	readonly name: string;
	start(): void;
	stop(): void;
}

export interface RepairRunReport {
	readonly runId: string;
	readonly indexedLines: number;
	readonly errors: readonly string[];
}

export interface LogIndexRepairDeps {
	readonly listSegments: (runId: string, stream: 'events') => readonly SegmentRow[];
	readonly lastIndexedEnd: (runId: string) => number;
	readonly lastIndexedFileSeq: (runId: string) => number | null;
	readonly insertIndex: (record: {
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
	}) => void;
	readonly fileLen: (path: string) => number | null;
	readonly readRange: (path: string, start: number, end: number) => Promise<string>;
	readonly listRunIds: () => readonly string[];
}

/**
 * Startup job: scans every run's events.ndjson from the last indexed
 * `byte_offset + byte_len` to EOF and back-fills missing index rows.
 *
 * File-ahead-of-index is the normal crash window (E-24). Index-ahead-of-file is
 * corruption and is reported as an error entry, never silently discarded (E-24).
 */
export function createLogIndexRepairJob(deps: LogIndexRepairDeps): LogstoreJob & {
	readonly runOnce: () => Promise<RepairRunReport[]>;
} {
	async function repairRun(runId: string): Promise<RepairRunReport> {
		const report: { runId: string; indexedLines: number; errors: string[] } = {
			runId,
			indexedLines: 0,
			errors: [],
		};

		const segments = deps.listSegments(runId, 'events');
		const indexedEnd = deps.lastIndexedEnd(runId);
		const indexedFileSeq = deps.lastIndexedFileSeq(runId);

		for (const segment of segments) {
			const fileLen = deps.fileLen(segment.path);
			if (fileLen === null) {
				// E-151: a deleted log file is not fatal; other runs still get repaired.
				report.errors.push(`missing:${segment.path}`);
				continue;
			}

			const indexedEndInFile = indexedFileSeq === segment.fileSeq ? indexedEnd : 0;
			if (indexedEndInFile > fileLen) {
				report.errors.push(
					`corrupt:${segment.path}:index-ahead(indexed=${indexedEndInFile},file=${fileLen})`,
				);
				continue;
			}

			if (indexedEndInFile === fileLen) continue;

			const text = await deps.readRange(segment.path, indexedEndInFile, fileLen - 1);
			let offset = indexedEndInFile;
			let seq = 0; // repaired lines continue seq ordering; caller may renumber on read.

			for (const line of splitLines(text)) {
				const bytes = Buffer.byteLength(line, 'utf8');
				const byteLen = bytes + 1;
				const parsed = parseEnvelope(line);
				if (parsed !== null) {
					deps.insertIndex({
						runId,
						taskId: parsed.taskId,
						seq,
						ts: parsed.ts,
						scope: parsed.scope,
						kind: parsed.kind,
						actorDeviceId: parsed.actorDeviceId,
						fileSeq: segment.fileSeq,
						byteOffset: offset,
						byteLen,
					});
					report.indexedLines += 1;
					seq += 1;
				}
				offset += byteLen;
			}
		}

		return report;
	}

	return {
		name: 'log-index-repair',
		start() {
			return undefined;
		},
		stop() {
			return undefined;
		},
		async runOnce(): Promise<RepairRunReport[]> {
			const reports: RepairRunReport[] = [];
			for (const runId of deps.listRunIds()) {
				reports.push(await repairRun(runId));
			}
			return reports;
		},
	};
}

function splitLines(text: string): readonly string[] {
	if (text.length === 0) return [];
	return text.split('\n').filter((line) => line.length > 0);
}

interface ParsedEnvelope {
	taskId: string | null;
	ts: string;
	scope: string;
	kind: string;
	actorDeviceId: string | null;
}

function parseEnvelope(line: string): ParsedEnvelope | null {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		if (
			typeof value.ts !== 'string' ||
			typeof value.scope !== 'string' ||
			typeof value.kind !== 'string'
		) {
			return null;
		}
		return {
			taskId: typeof value.taskId === 'string' ? value.taskId : null,
			ts: value.ts,
			scope: value.scope,
			kind: value.kind,
			actorDeviceId: typeof value.actorDeviceId === 'string' ? value.actorDeviceId : null,
		};
	} catch {
		return null;
	}
}
