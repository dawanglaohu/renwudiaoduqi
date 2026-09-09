export interface SnapshotResponse {
	readonly documents: readonly unknown[];
	readonly batches: readonly unknown[];
	readonly tasks: readonly unknown[];
	readonly runs: readonly unknown[];
	readonly gates: readonly unknown[];
	readonly agents: readonly unknown[];
	readonly latestEventId: number | null;
}
