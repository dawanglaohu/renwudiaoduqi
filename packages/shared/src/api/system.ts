/**
 * Current supported API version (shared by daemon and both shells) (AC 1, E-14).
 * Single source of truth across daemon, shell-desktop, and shell-mobile.
 */
export const CURRENT_API_VERSION = 'v1' as const;

export interface HealthDiagnostics {
	readonly ok: true;
	readonly uptimeSec: number;
	readonly rss: number;
	readonly eventIdRange: {
		readonly min: number | null;
		readonly max: number | null;
	};
	readonly activeRuns: number;
	readonly sseClients: number;
	readonly dbSizeBytes: number;
}

export interface VersionResponse {
	readonly daemon: string;
	readonly apiVersion: string;
	readonly node: string;
}

export interface SystemUsageItem {
	readonly runId: string;
	readonly bytes: number;
}

export interface SystemUsageResponse {
	readonly dataDirBytes: number;
	readonly byRun: readonly SystemUsageItem[];
	readonly warnThreshold: number;
}
