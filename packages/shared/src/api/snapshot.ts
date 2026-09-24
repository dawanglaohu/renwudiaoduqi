import type { AgentEntryDto } from './agents.ts';
import type { BatchDto } from './batches.ts';
import type { DocumentDto } from './documents.ts';
import type { GateDto } from './gates.ts';
import type { LaneView } from './lanes.ts';
import type { RunDto } from './runs.ts';
import type { TaskDto } from './tasks.ts';

export * from './lanes.ts';

export interface SnapshotResponse {
	readonly documents: readonly DocumentDto[];
	readonly batches: readonly BatchDto[];
	readonly tasks: readonly TaskDto[];
	readonly runs: readonly RunDto[];
	readonly gates: readonly GateDto[];
	readonly agents: readonly AgentEntryDto[];
	readonly lanes?: readonly LaneView[];
	readonly latestEventId: number | null;
}
