import type { DatabaseConnection } from '../db/open-database.ts';
import { toDatabaseError } from '../db/open-database.ts';
import { AppError } from '../errors/app-error.ts';

export const WATERMARK_BATCH_SIZE = 1000;
export const DEFAULT_EVENT_SEQ_NAME = 'events';

export interface EventSeqStore {
	readonly getWatermark: (name: string) => number | null;
	readonly saveWatermark: (name: string, watermark: number) => void;
}

export interface IdAllocator {
	readonly allocate: () => number;
	readonly currentWatermark: () => number;
	readonly nextId: () => number;
}

export interface IdAllocatorDeps {
	readonly database?: DatabaseConnection;
	readonly store?: EventSeqStore;
	readonly name?: string;
	readonly batchSize?: number;
}

function createSqliteEventSeqStore(database: DatabaseConnection): EventSeqStore {
	const selectStmt = database.prepare<[string], { watermark: number }>(
		'SELECT watermark FROM event_seq WHERE name = ?',
	);
	const insertStmt = database.prepare<[string, number]>(
		'INSERT INTO event_seq (name, watermark) VALUES (?, ?)',
	);
	const updateStmt = database.prepare<[number, string]>(
		'UPDATE event_seq SET watermark = ? WHERE name = ?',
	);

	return {
		getWatermark(name: string): number | null {
			try {
				const row = selectStmt.get(name);
				return row !== undefined ? row.watermark : null;
			} catch (cause) {
				throw toDatabaseError(cause, 'Failed to read event sequence watermark.');
			}
		},
		saveWatermark(name: string, watermark: number): void {
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
	};
}

export function createIdAllocator(deps: IdAllocatorDeps): IdAllocator {
	const batchSize = deps.batchSize ?? WATERMARK_BATCH_SIZE;
	if (batchSize <= 0) {
		throw new AppError('E_VALIDATION', 'batchSize must be greater than 0.');
	}

	let store: EventSeqStore;
	if (deps.store) {
		store = deps.store;
	} else if (deps.database) {
		store = createSqliteEventSeqStore(deps.database);
	} else {
		throw new AppError(
			'E_VALIDATION',
			'createIdAllocator requires either a database connection or a store.',
		);
	}

	const name = deps.name ?? DEFAULT_EVENT_SEQ_NAME;
	const existingWatermark = store.getWatermark(name);

	let nextAllocatableId: number;
	let watermarkLimit: number;

	if (existingWatermark === null) {
		watermarkLimit = batchSize;
		store.saveWatermark(name, watermarkLimit);
		nextAllocatableId = 1;
	} else {
		// E-10: On restart, advance from previous watermark to ensure jump without rollback
		watermarkLimit = existingWatermark + batchSize;
		store.saveWatermark(name, watermarkLimit);
		nextAllocatableId = existingWatermark + 1;
	}

	function allocate(): number {
		if (nextAllocatableId > watermarkLimit) {
			const newWatermark = watermarkLimit + batchSize;
			store.saveWatermark(name, newWatermark);
			watermarkLimit = newWatermark;
		}

		const id = nextAllocatableId;
		nextAllocatableId += 1;
		return id;
	}

	return Object.freeze({
		allocate,
		currentWatermark: () => watermarkLimit,
		nextId: () => nextAllocatableId,
	});
}
