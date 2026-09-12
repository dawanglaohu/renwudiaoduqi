import { AppError } from '../../errors/app-error.ts';

export interface GrokSessionSummary {
	readonly id: string;
	readonly created: string;
	readonly updated: string;
	readonly status: string;
	readonly summary: string;
}

export interface GrokCommandSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd?: string;
}

export interface GrokCommandResult {
	readonly stdout: string;
	readonly stderr?: string;
	readonly exitCode: number | null;
}

export type GrokSessionRunner = (spec: GrokCommandSpec) => Promise<GrokCommandResult>;

export interface ListGrokSessionsOptions {
	readonly execPath?: string;
	readonly limit?: number;
	readonly cwd?: string;
	readonly leaderSocket?: string;
	readonly runner?: GrokSessionRunner;
}

export interface SearchGrokSessionsOptions {
	readonly execPath?: string;
	readonly limit?: number;
	readonly cwd?: string;
	readonly leaderSocket?: string;
	readonly runner?: GrokSessionRunner;
}

export interface ExportGrokSessionOptions {
	readonly execPath?: string;
	readonly cwd?: string;
	readonly leaderSocket?: string;
	readonly runner?: GrokSessionRunner;
}

/**
 * Builds CLI argument list for `grok sessions list`.
 */
export function buildGrokSessionsListArgs(options?: {
	limit?: number;
	leaderSocket?: string;
}): readonly string[] {
	const args: string[] = ['sessions', 'list'];
	if (options?.limit !== undefined && options.limit > 0) {
		args.push('-n', String(options.limit));
	}
	if (options?.leaderSocket) {
		args.push('--leader-socket', options.leaderSocket);
	}
	return Object.freeze(args);
}

/**
 * Builds CLI argument list for `grok sessions search <query>`.
 */
export function buildGrokSessionsSearchArgs(
	query: string,
	options?: { limit?: number; leaderSocket?: string },
): readonly string[] {
	const args: string[] = ['sessions', 'search', query];
	if (options?.limit !== undefined && options.limit > 0) {
		args.push('-n', String(options.limit));
	}
	if (options?.leaderSocket) {
		args.push('--leader-socket', options.leaderSocket);
	}
	return Object.freeze(args);
}

/**
 * Builds CLI argument list for `grok export <sessionId>`.
 */
export function buildGrokExportArgs(
	sessionId: string,
	options?: { leaderSocket?: string },
): readonly string[] {
	const args: string[] = ['export', sessionId];
	if (options?.leaderSocket) {
		args.push('--leader-socket', options.leaderSocket);
	}
	return Object.freeze(args);
}

/**
 * Parses the tabular or structured stdout of `grok sessions list` or `grok sessions search`.
 *
 * Example output:
 * SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY
 * 01a08004-0fbb-78a3-b1f3-a54fbfe035c8  2026-09-08  2026-09-08  local       M1-T4 logstore review
 * 01a0800b-79ae-7c10-9288-ddb61c848c75  2026-09-08  2026-09-08  local       (no summary)
 */
export function parseGrokSessionsTable(stdout: string): readonly GrokSessionSummary[] {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return Object.freeze([]);
	}

	// If future CLI output is JSON array
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed) as readonly Record<string, unknown>[];
			if (Array.isArray(parsed)) {
				const summaries = parsed.map((item) => {
					const id = String(item.id ?? item.sessionId ?? item.session_id ?? '');
					const created = String(item.created ?? item.createdAt ?? item.created_at ?? '');
					const updated = String(item.updated ?? item.updatedAt ?? item.updated_at ?? '');
					const status = String(item.status ?? 'local');
					const summary = String(item.summary ?? item.title ?? '');
					return Object.freeze({ id, created, updated, status, summary });
				});
				return Object.freeze(summaries.filter((s) => s.id.length > 0));
			}
		} catch {
			// Fall through to tabular parsing
		}
	}

	const lines = trimmed.split(/\r?\n/);
	const results: GrokSessionSummary[] = [];

	let inHeader = true;
	for (const line of lines) {
		const raw = line.trim();
		if (!raw) continue;

		// Skip header line containing SESSION ID or SESSION
		if (inHeader && (raw.includes('SESSION ID') || raw.includes('SESSION_ID'))) {
			inHeader = false;
			continue;
		}

		// Look for standard UUID / session ID formatted row
		// UUID: 36 chars with hyphens (e.g. 01a08004-0fbb-78a3-b1f3-a54fbfe035c8) or 32+ hex/hyphens
		const match = raw.match(/^([0-9a-fA-F-]{32,36})\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
		if (match?.[1]) {
			inHeader = false;
			const id = match[1];
			const created = match[2] ?? '';
			const updated = match[3] ?? '';
			const status = match[4] ?? '';
			const rawSummary = match[5]?.trim() ?? '';
			const summary = rawSummary === '(no summary)' ? '' : rawSummary;

			results.push(
				Object.freeze({
					id,
					created,
					updated,
					status,
					summary,
				}),
			);
		}
	}

	return Object.freeze(results);
}

/**
 * Lists recent Grok sessions via `grok sessions list`.
 *
 * AC 2: Reads sessions solely via `grok sessions list/search` and `grok export <id>`.
 * Direct connection to Grok's internal SQLite database is forbidden because the schema is unversioned.
 */
export async function listGrokSessions(
	options?: ListGrokSessionsOptions,
): Promise<readonly GrokSessionSummary[]> {
	if (!options?.runner) {
		throw new AppError(
			'E_VALIDATION',
			'Command runner is required to execute grok sessions list without direct SQLite access',
		);
	}

	const file = options.execPath?.trim() || 'grok';
	const args = buildGrokSessionsListArgs({
		limit: options.limit,
		leaderSocket: options.leaderSocket,
	});

	const result = await options.runner({ file, args, cwd: options.cwd });
	if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new AppError(
			'E_INTERNAL',
			`grok sessions list failed with exit code ${result.exitCode}: ${result.stderr ?? ''}`,
		);
	}

	return parseGrokSessionsTable(result.stdout);
}

/**
 * Searches Grok sessions by keyword via `grok sessions search <query>`.
 *
 * AC 2: Reads sessions solely via `grok sessions search`.
 */
export async function searchGrokSessions(
	query: string,
	options?: SearchGrokSessionsOptions,
): Promise<readonly GrokSessionSummary[]> {
	if (!options?.runner) {
		throw new AppError(
			'E_VALIDATION',
			'Command runner is required to execute grok sessions search without direct SQLite access',
		);
	}

	const file = options.execPath?.trim() || 'grok';
	const args = buildGrokSessionsSearchArgs(query, {
		limit: options.limit,
		leaderSocket: options.leaderSocket,
	});

	const result = await options.runner({ file, args, cwd: options.cwd });
	if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new AppError(
			'E_INTERNAL',
			`grok sessions search failed with exit code ${result.exitCode}: ${result.stderr ?? ''}`,
		);
	}

	return parseGrokSessionsTable(result.stdout);
}

/**
 * Exports a Grok session transcript as Markdown via `grok export <sessionId>`.
 *
 * AC 2: Export transcript solely via `grok export <sessionId>`, never by reading SQLite.
 */
export async function exportGrokSession(
	sessionId: string,
	options?: ExportGrokSessionOptions,
): Promise<string> {
	if (!sessionId || sessionId.trim().length === 0) {
		throw new AppError('E_VALIDATION', 'sessionId must not be empty');
	}

	if (!options?.runner) {
		throw new AppError(
			'E_VALIDATION',
			'Command runner is required to execute grok export without direct SQLite access',
		);
	}

	const file = options.execPath?.trim() || 'grok';
	const args = buildGrokExportArgs(sessionId.trim(), {
		leaderSocket: options.leaderSocket,
	});

	const result = await options.runner({ file, args, cwd: options.cwd });
	if (result.exitCode !== 0 && result.exitCode !== null) {
		throw new AppError(
			'E_INTERNAL',
			`grok export failed with exit code ${result.exitCode}: ${result.stderr ?? ''}`,
		);
	}

	return result.stdout;
}
