import type Database from 'better-sqlite3';
import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';

const SELECT_WATERMARK_SQL = `
SELECT watermark
FROM event_seq
WHERE name = ?
`;

const INSERT_WATERMARK_SQL = `
INSERT INTO event_seq (name, watermark)
VALUES (?, ?)
`;

const UPDATE_WATERMARK_SQL = `
UPDATE event_seq
SET watermark = ?
WHERE name = ?
`;

export interface EventSeqRepo {
	readonly getWatermark: (name: string) => number | null;
	readonly setWatermark: (name: string, watermark: number) => void;
}

export function createEventSeqRepo(database: DatabaseConnection): EventSeqRepo {
	let selectStmt: Database.Statement<[string], { watermark: number }>;
	let insertStmt: Database.Statement<[string, number]>;
	let updateStmt: Database.Statement<[number, string]>;
	try {
		selectStmt = database.prepare<[string], { watermark: number }>(SELECT_WATERMARK_SQL);
		insertStmt = database.prepare<[string, number]>(INSERT_WATERMARK_SQL);
		updateStmt = database.prepare<[number, string]>(UPDATE_WATERMARK_SQL);
	} catch (cause) {
		throw toDatabaseError(cause, 'Failed to prepare event sequence statements.');
	}

	return Object.freeze({
		getWatermark(name: string): number | null {
			try {
				const row = selectStmt.get(name);
				return row !== undefined ? row.watermark : null;
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to read event sequence watermark.');
			}
		},
		setWatermark(name: string, watermark: number): void {
			try {
				const row = selectStmt.get(name);
				if (row !== undefined) {
					updateStmt.run(watermark, name);
				} else {
					insertStmt.run(name, watermark);
				}
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to save event sequence watermark.');
			}
		},
	});
}
