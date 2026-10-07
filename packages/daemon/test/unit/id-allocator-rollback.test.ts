import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/db/open-database.ts';
import { createUnitOfWork } from '../../src/db/unit-of-work.ts';
import { type EventSeqStore, createIdAllocator } from '../../src/events/id-allocator.ts';
import { createEventSeqRepo } from '../../src/repo/event-seq-repo.ts';

describe('event ID watermark durability', () => {
	it.each(['unit-of-work', 'raw-sqlite'])(
		'repairs a rolled-back reservation before another ID is issued (%s)',
		(transactionKind) => {
			const db = openDatabase(':memory:');
			try {
				db.exec('CREATE TABLE event_seq (name TEXT PRIMARY KEY, watermark INTEGER NOT NULL)');
				const store = createEventSeqRepo(db);
				const allocator = createIdAllocator({ store });
				for (let index = 0; index < 1000; index += 1) allocator.allocate();
				const reserveAndFail = () => {
					expect(allocator.allocate()).toBe(1001);
					expect(store.getWatermark('events')).toBe(2000);
					throw new Error('business write rejected');
				};
				expect(() => {
					if (transactionKind === 'unit-of-work') createUnitOfWork(db).run(reserveAndFail);
					else db.transaction(reserveAndFail).immediate();
				}).toThrow();
				expect(store.getWatermark('events')).toBe(1000);
				const issuedAfterRollback = allocator.allocate();
				expect(issuedAfterRollback).toBe(1002);
				expect(store.getWatermark('events')).toBe(2000);
				const restarted = createIdAllocator({ store });
				expect(restarted.allocate()).toBeGreaterThan(issuedAfterRollback);
			} finally {
				db.close();
			}
		},
	);

	it.each(['read', 'write'])(
		'does not consume an ID when reservation repair fails during %s',
		(failure) => {
			let persisted: number | null = null;
			let failing = false;
			const store: EventSeqStore = {
				getWatermark: () => {
					if (failing && failure === 'read') throw new Error('read failed');
					return persisted;
				},
				setWatermark: (_name, watermark) => {
					if (failing && failure === 'write') throw new Error('write failed');
					persisted = watermark;
				},
			};
			const allocator = createIdAllocator({ store });
			for (let index = 0; index < 1001; index += 1) allocator.allocate();
			persisted = 1000;
			failing = true;
			expect(() => allocator.allocate()).toThrow(`${failure} failed`);
			expect(allocator.nextId()).toBe(1002);
			expect(allocator.currentWatermark()).toBe(2000);
			expect(persisted).toBe(1000);
			failing = false;
			expect(allocator.allocate()).toBe(1002);
			expect(persisted).toBe(2000);
		},
	);
});
