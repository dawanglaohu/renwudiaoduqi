import type { DatabaseConnection } from '../db/open-database.ts';

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
	const selectStmt = database.prepare<[string], { watermark: number }>(SELECT_WATERMARK_SQL);
	const insertStmt = database.prepare<[string, number]>(INSERT_WATERMARK_SQL);
	const updateStmt = database.prepare<[number, string]>(UPDATE_WATERMARK_SQL);

	return Object.freeze({
		getWatermark(name: string): number | null {
			const row = selectStmt.get(name);
			return row !== undefined ? row.watermark : null;
		},
		setWatermark(name: string, watermark: number): void {
			const row = selectStmt.get(name);
			if (row !== undefined) {
				updateStmt.run(watermark, name);
			} else {
				insertStmt.run(name, watermark);
			}
		},
	});
}
