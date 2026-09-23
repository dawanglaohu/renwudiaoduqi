export const LANE_STAGES = [
	'idle',
	'queued',
	'implement',
	'rework',
	'review',
	'bughunt',
	'wrapup',
] as const;

export type LaneStage = (typeof LANE_STAGES)[number];

export const PIPELINE_STAGES = ['implement', 'review', 'bughunt', 'landing'] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_ORDER = PIPELINE_STAGES;

export interface LaneView {
	readonly laneNo: number;
	readonly taskId: string | null;
	readonly currentRunId: string | null;
	readonly stage: LaneStage;
	readonly nextTaskId: string | null;
	readonly nextBlockedBy: readonly string[];
	readonly archivedTaskIds: readonly string[];
	readonly archivedWrapupRunId: string | null;
	readonly overLimit: boolean;
}
