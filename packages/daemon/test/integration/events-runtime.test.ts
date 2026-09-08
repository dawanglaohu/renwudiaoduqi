import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import type { ProcessConfig } from '../../src/config/env.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { type DatabaseConnection, openDatabase } from '../../src/db/open-database.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

const temporaryDirectories: string[] = [];
const openDatabases: DatabaseConnection[] = [];
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../migrations');

afterEach(() => {
	for (const database of openDatabases.splice(0)) {
		if (database.open) database.close();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

function createTestConfig(dataDir: string): ProcessConfig {
	return Object.freeze({
		port: 7817,
		bind: '127.0.0.1',
		dataDir,
		logLevel: 'info',
		dev: false,
	});
}

const dummyLockHandle: LockFileHandle = {
	path: '/dummy.lock',
	metadata: {
		pid: process.pid,
		uid: '1000',
		startedAt: new Date().toISOString(),
		port: 7817,
		bind: '127.0.0.1',
	},
	serializedMetadata: '{}',
	released: false,
	release: () => {},
};

const dummyLockAdapter: NativeLockAdapter = {
	platform: 'linux',
	filePath: '/dummy.lock',
	dirPath: '/dummy',
	reclaimPath: '/dummy.reclaim',
	permissionLines: [],
	createExclusive: () => ({ ok: true }),
	read: () => ({ ok: true, contents: '{}' }),
	remove: () => ({ ok: true }),
	verifyPermissions: () => ({ ok: true }),
	createReclaimGuard: () => ({ ok: true }),
	readReclaimGuard: () => ({ ok: true, contents: '{}' }),
	removeReclaimGuard: () => ({ ok: true }),
	inspectPermissions: () => ({ ok: true, contents: '{}' }),
};

describe('M2-T4 Events Runtime Integration (real SQLite + migrations + container + restart)', () => {
	it('E-10 wires one event runtime and preserves monotonic IDs across restart', () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'agent-scheduler-runtime-'));
		temporaryDirectories.push(tempDir);
		const dbPath = join(tempDir, 'app.db');

		let timeMs = 1725800000000;
		const clock = {
			now: () => new Date(timeMs++).toISOString(),
		};

		// Run real migrations on app.db
		const db1 = openDatabase(dbPath);
		openDatabases.push(db1);
		const runner1 = createMigrationRunner({
			clock,
			database: db1,
			fileSystem: {
				readDirectory: (dir) => readdirSync(dir),
				readFile: (path) => readFileSync(path, 'utf8'),
			},
		});
		const applied1 = runner1.run(migrationsDirectory);
		expect(applied1.appliedVersions.length).toBeGreaterThan(0);

		// Boot container 1
		const container1 = createContainer({
			config: createTestConfig(tempDir),
			database: db1,
			hostInputs: { platform: 'linux', homedir: tempDir },
			lockAdapter: dummyLockAdapter,
			instanceLock: dummyLockHandle,
			clock,
		});

		// Verify container exposes unique instances and they are interconnected
		expect(container1.repos.eventSeq).toBeDefined();
		expect(container1.events.idAllocator).toBeDefined();
		expect(container1.events.envelopeFactory).toBeDefined();
		expect(container1.events.ringBuffer).toBeDefined();
		expect(container1.events.bus).toBeDefined();
		expect(container1.events.bus.ringBuffer).toBe(container1.events.ringBuffer);

		// Subscribe to container bus
		const received1: unknown[] = [];
		container1.events.bus.subscribe((event) => {
			received1.push(event);
		});

		// Produce 50 events in container 1
		for (let i = 0; i < 50; i++) {
			const envelope = container1.events.envelopeFactory.createEnvelope({
				kind: 'run.state_changed',
				runId: 'run-alpha',
				payload: { from: 'pending', to: 'running', reason: `step-${i}` },
			});
			container1.events.bus.publish(envelope);
		}

		expect(received1).toHaveLength(50);
		expect(container1.events.ringBuffer.size()).toBe(50);
		expect(container1.events.ringBuffer.oldest()?.id).toBe(1);
		expect(container1.events.ringBuffer.latest()?.id).toBe(50);
		expect(container1.events.idAllocator.currentWatermark()).toBe(1000);

		// Close database 1 to simulate daemon exit
		db1.close();

		// Reopen database 2 for container 2 on the same disk database
		const db2 = openDatabase(dbPath);
		openDatabases.push(db2);

		const container2 = createContainer({
			config: createTestConfig(tempDir),
			database: db2,
			hostInputs: { platform: 'linux', homedir: tempDir },
			lockAdapter: dummyLockAdapter,
			instanceLock: dummyLockHandle,
			clock,
		});

		// Watermark on restart must advance to 2000 (E-10)
		expect(container2.events.idAllocator.currentWatermark()).toBe(2000);

		// First event created in container 2 must have id 1001 (jumped without rollback)
		const envRestart1 = container2.events.envelopeFactory.createEnvelope({
			kind: 'run.started',
			runId: 'run-beta',
			payload: { runId: 'run-beta', pid: 1234 },
		});
		expect(envRestart1.id).toBe(1001);
		expect(envRestart1.seq).toBe(0);

		container2.events.bus.publish(envRestart1);
		expect(container2.events.ringBuffer.size()).toBe(1);
		expect(container2.events.ringBuffer.oldest()?.id).toBe(1001);

		// Client from previous run asking for replay of event 50 gets E_REPLAY_WINDOW_EXPIRED
		const replayOld = container2.events.ringBuffer.getEventsSince(50);
		expect(replayOld.ok).toBe(false);
		if (!replayOld.ok) {
			expect(replayOld.code).toBe('E_REPLAY_WINDOW_EXPIRED');
			expect(replayOld.minId).toBe(1001);
		}

		// Client asking for replay since 1000 gets event 1001
		const replayCatchUp = container2.events.ringBuffer.getEventsSince(1000);
		expect(replayCatchUp.ok).toBe(true);
		if (replayCatchUp.ok) {
			expect(replayCatchUp.events).toHaveLength(1);
			expect(replayCatchUp.events[0]?.id).toBe(1001);
		}
	});
});
