import type { DatabaseConnection } from '../db/open-database.ts';

export interface SettingRow {
	readonly key: string;
	readonly value_json: string;
	readonly updated_at: string;
}

export interface SettingsRepo {
	readonly get: (key: string) => SettingRow | null;
	readonly set: (key: string, valueJson: string, updatedAt: string) => void;
	readonly delete: (key: string) => void;
}

const SELECT_BY_KEY_SQL = `
SELECT key, value_json, updated_at
FROM settings
WHERE key = ?
`;

const UPSERT_SETTING_SQL = `
INSERT INTO settings (key, value_json, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
	value_json = excluded.value_json,
	updated_at = excluded.updated_at
`;

const DELETE_SETTING_SQL = `
DELETE FROM settings
WHERE key = ?
`;

export function createSettingsRepo(db: DatabaseConnection): SettingsRepo {
	const selectStmt = db.prepare<[string], SettingRow>(SELECT_BY_KEY_SQL);
	const upsertStmt = db.prepare<[string, string, string]>(UPSERT_SETTING_SQL);
	const deleteStmt = db.prepare<[string]>(DELETE_SETTING_SQL);

	return Object.freeze({
		get(key: string): SettingRow | null {
			const row = selectStmt.get(key);
			return row ?? null;
		},

		set(key: string, valueJson: string, updatedAt: string): void {
			upsertStmt.run(key, valueJson, updatedAt);
		},

		delete(key: string): void {
			deleteStmt.run(key);
		},
	});
}
