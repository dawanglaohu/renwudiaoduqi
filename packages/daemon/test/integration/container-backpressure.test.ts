import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createNodeLogFileSystem } from '../../src/logstore/node-log-file-system.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { ManagedProcess, SpawnManagedOptions } from '../../src/proc/spawn.ts';

it('connects managed processes to the queue that accounts for pending production log writes', async () => {
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-container-pressure-'));
	const db = openDatabase(':memory:');
	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
	}
	let releaseWrite: (() => void) | undefined;
	const blockedWrite = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	let writeStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		writeStarted = resolve;
	});
	const fs = createNodeLogFileSystem();
	const spawn = vi.fn((_spec: unknown, _options: SpawnManagedOptions) => ({}) as ManagedProcess);
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		hostInputs: { platform: 'linux', homedir: dataDir },
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => '2026-10-02T10:00:00.000Z' },
		bootstrapPairing: false,
		spawnManaged: spawn,
		logFs: {
			...fs,
			async appendFile(path, bytes) {
				writeStarted?.();
				await blockedWrite;
				await fs.appendFile(path, bytes);
			},
		},
	});
	let pendingWrite: Promise<unknown> | undefined;
	try {
		container.proc.spawnManaged({ runId: 'pressure', file: '/agent', args: [], cwd: dataDir });
		const queue = spawn.mock.calls[0]?.[1].appendQueue;
		expect(queue).toBeDefined();
		pendingWrite = container.services.run.ingestRaw('pressure', 'x'.repeat(1024));
		await started;
		expect(queue?.pendingBytes).toBeGreaterThanOrEqual(1024);
		releaseWrite?.();
		await pendingWrite;
		expect(queue?.pendingBytes).toBe(0);
	} finally {
		releaseWrite?.();
		await pendingWrite;
		await container.services.agents.stop();
		db.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
