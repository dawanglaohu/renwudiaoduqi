import type { Statement } from 'better-sqlite3';
import { type DatabaseConnection, toDatabaseError } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';

export interface DeviceRow {
	readonly id: string;
	readonly name: string;
	readonly token_hash: string;
	readonly token_salt: string;
	readonly paired_at: string;
	readonly last_seen_at: string;
	readonly revoked_at: string | null;
}

export interface DeviceInsertRow {
	readonly id: string;
	readonly name: string;
	readonly token_hash: string;
	readonly token_salt: string;
	readonly paired_at: string;
	readonly last_seen_at: string;
	readonly revoked_at?: string | null;
}

const INSERT_SQL = `
INSERT INTO devices (
	id,
	name,
	token_hash,
	token_salt,
	paired_at,
	last_seen_at,
	revoked_at
) VALUES (
	@id,
	@name,
	@token_hash,
	@token_salt,
	@paired_at,
	@last_seen_at,
	@revoked_at
)
`;

const SELECT_BY_ID_SQL = `
SELECT
	id,
	name,
	token_hash,
	token_salt,
	paired_at,
	last_seen_at,
	revoked_at
FROM devices
WHERE id = ?
LIMIT 1
`;

const SELECT_ALL_SQL = `
SELECT
	id,
	name,
	token_hash,
	token_salt,
	paired_at,
	last_seen_at,
	revoked_at
FROM devices
ORDER BY paired_at ASC
`;

const SELECT_ACTIVE_SQL = `
SELECT
	id,
	name,
	token_hash,
	token_salt,
	paired_at,
	last_seen_at,
	revoked_at
FROM devices
WHERE revoked_at IS NULL
ORDER BY paired_at ASC
`;

const COUNT_ACTIVE_SQL = `
SELECT COUNT(*) AS count
FROM devices
WHERE revoked_at IS NULL
`;

const COUNT_TOTAL_SQL = `
SELECT COUNT(*) AS count
FROM devices
`;

const REVOKE_SQL = `
UPDATE devices
SET revoked_at = ?
WHERE id = ? AND revoked_at IS NULL
`;

const UPDATE_LAST_SEEN_SQL = `
UPDATE devices
SET last_seen_at = ?
WHERE id = ?
`;

const TABLE_EXISTS_SQL = `
SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'devices'
`;

export interface DevicesRepo {
	insert(device: DeviceInsertRow): void;
	findById(id: string): DeviceRow | null;
	list(): readonly DeviceRow[];
	listActive(): readonly DeviceRow[];
	countActive(): number;
	countTotal(): number;
	revoke(id: string, revokedAt: string): boolean;
	updateLastSeen(id: string, lastSeenAt: string): boolean;
}

export function createDevicesRepo(database: DatabaseConnection): DevicesRepo {
	let insertStmt: Statement | null = null;
	let selectByIdStmt: Statement | null = null;
	let selectAllStmt: Statement | null = null;
	let selectActiveStmt: Statement | null = null;
	let countActiveStmt: Statement | null = null;
	let countTotalStmt: Statement | null = null;
	let revokeStmt: Statement | null = null;
	let updateLastSeenStmt: Statement | null = null;
	let tableExistsStmt: Statement | null = null;

	function hasDevicesTable(): boolean {
		try {
			if (!tableExistsStmt) tableExistsStmt = database.prepare(TABLE_EXISTS_SQL);
			const row = tableExistsStmt.get();
			return row !== undefined;
		} catch {
			return false;
		}
	}

	function getInsertStmt(): Statement {
		if (!insertStmt) insertStmt = database.prepare(INSERT_SQL);
		return insertStmt;
	}

	function getSelectByIdStmt(): Statement {
		if (!selectByIdStmt) selectByIdStmt = database.prepare(SELECT_BY_ID_SQL);
		return selectByIdStmt;
	}

	function getSelectAllStmt(): Statement {
		if (!selectAllStmt) selectAllStmt = database.prepare(SELECT_ALL_SQL);
		return selectAllStmt;
	}

	function getSelectActiveStmt(): Statement {
		if (!selectActiveStmt) selectActiveStmt = database.prepare(SELECT_ACTIVE_SQL);
		return selectActiveStmt;
	}

	function getCountActiveStmt(): Statement {
		if (!countActiveStmt) countActiveStmt = database.prepare(COUNT_ACTIVE_SQL);
		return countActiveStmt;
	}

	function getCountTotalStmt(): Statement {
		if (!countTotalStmt) countTotalStmt = database.prepare(COUNT_TOTAL_SQL);
		return countTotalStmt;
	}

	function getRevokeStmt(): Statement {
		if (!revokeStmt) revokeStmt = database.prepare(REVOKE_SQL);
		return revokeStmt;
	}

	function getUpdateLastSeenStmt(): Statement {
		if (!updateLastSeenStmt) updateLastSeenStmt = database.prepare(UPDATE_LAST_SEEN_SQL);
		return updateLastSeenStmt;
	}

	return {
		insert(device: DeviceInsertRow): void {
			try {
				getInsertStmt().run({
					id: device.id,
					name: device.name,
					token_hash: device.token_hash,
					token_salt: device.token_salt,
					paired_at: device.paired_at,
					last_seen_at: device.last_seen_at,
					revoked_at: device.revoked_at ?? null,
				});
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to insert device '${device.id}'.`);
			}
		},

		findById(id: string): DeviceRow | null {
			try {
				const row = getSelectByIdStmt().get(id) as DeviceRow | undefined;
				return row ?? null;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to query device by id '${id}'.`);
			}
		},

		list(): readonly DeviceRow[] {
			try {
				return getSelectAllStmt().all() as DeviceRow[];
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list devices.');
			}
		},

		listActive(): readonly DeviceRow[] {
			try {
				return getSelectActiveStmt().all() as DeviceRow[];
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to list active devices.');
			}
		},

		countActive(): number {
			if (!hasDevicesTable()) return -1;
			try {
				const row = getCountActiveStmt().get() as { count: number } | undefined;
				return row?.count ?? 0;
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to count active devices.');
			}
		},

		countTotal(): number {
			if (!hasDevicesTable()) return -1;
			try {
				const row = getCountTotalStmt().get() as { count: number } | undefined;
				return row?.count ?? 0;
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to count total devices.');
			}
		},

		revoke(id: string, revokedAt: string): boolean {
			if (!id) {
				throw new AppError('E_VALIDATION', 'Device id is required to revoke.');
			}
			try {
				const result = getRevokeStmt().run(revokedAt, id);
				return result.changes > 0;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to revoke device '${id}'.`);
			}
		},

		updateLastSeen(id: string, lastSeenAt: string): boolean {
			try {
				const result = getUpdateLastSeenStmt().run(lastSeenAt, id);
				return result.changes > 0;
			} catch (cause) {
				throw toDatabaseError(cause, `Failed to update last seen for device '${id}'.`);
			}
		},
	};
}
