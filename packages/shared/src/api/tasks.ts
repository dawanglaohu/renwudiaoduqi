export interface TaskDto {
	readonly id: string;
	readonly docId: string;
	readonly taskKey: string;
	readonly title: string;
	readonly moduleKey: string;
	readonly deps: readonly string[];
	readonly estDays: number | null;
	readonly batchId: string | null;
	readonly state: string;
	readonly inHead?: boolean | null;
	readonly inHeadMethod?: string | null;
	readonly isCrossBatchFix?: boolean;
	readonly laneNo?: number | null;
}

export interface GetTaskLandingResponse {
	readonly worktreePath: string;
	readonly branchName: string;
	readonly diffStat: {
		readonly filesChanged: number;
		readonly insertions: number;
		readonly deletions: number;
	};
	readonly commands: readonly string[];
}

export interface CleanupTaskWorktreeResponse {
	readonly removed: true;
}
