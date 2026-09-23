import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createMigrationRunner } from '../../src/db/migrate.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(currentDir, '../../../..');
const daemonRoot = join(repositoryRoot, 'packages/daemon');
const jobsSourceDir = join(daemonRoot, 'src/jobs');
const mainSourcePath = join(daemonRoot, 'src/main.ts');
const migrationsDir = join(daemonRoot, 'migrations');

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

describe('M7-T9 Architecture: Container Jobs, Review & Gate Service Wiring (AC 1, AC 5, 08-backend)', () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors
			}
		}
		tempDirs.length = 0;
	});

	function makeTestContainer() {
		const dataDir = mkdtempSync(join(tmpdir(), 'agsched-arch-jobs-'));
		tempDirs.push(dataDir);
		const db = openDatabase(join(dataDir, 'test.db'));
		const runner = createMigrationRunner({
			clock: { now: () => '2026-09-09T12:00:00.000Z' },
			database: db,
			fileSystem: {
				readDirectory: () => readdirSync(migrationsDir),
				readFile: (p: string) => readFileSync(p, 'utf8'),
			},
		});
		runner.run(migrationsDir);

		return createContainer({
			config: {
				port: 7817,
				bind: '127.0.0.1',
				dataDir,
				logLevel: 'error',
				dev: false,
			},
			database: db,
			hostInputs: { platform: 'linux', homedir: dataDir },
			lockAdapter: dummyLockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-09-09T12:00:00.000Z' },
		});
	}

	it('AC 1: createContainer() returns non-null services.review and services.gates', () => {
		const container = makeTestContainer();
		expect(container.services.review).toBeDefined();
		expect(typeof container.services.review.evaluateMechanicalCheck).toBe('function');
		expect(container.services.gates).toBeDefined();
		expect(typeof container.services.gates.decideGate).toBe('function');
	});

	it('AC 1: jobs.map returns exactly the 5 job names in fixed order (reconcile-runs, log-index-repair, stall-detector, scheduler-tick, disk-watch)', () => {
		const container = makeTestContainer();
		const expectedJobNames = [
			'reconcile-runs',
			'log-index-repair',
			'stall-detector',
			'scheduler-tick',
			'disk-watch',
		];
		const actualJobNames = container.jobs.map((j) => j.name);
		expect(actualJobNames).toEqual(expectedJobNames);
		expect(container.jobs).toHaveLength(5);
	});

	it('AC 1 & E-123: main.ts starts jobs after server.listen and prints "job started name=..." for each', () => {
		const mainSource = readFileSync(mainSourcePath, 'utf8');

		// Assert sequence: server.listen -> job.start() -> writeRunLog(job started name=...)
		const listenIdx = mainSource.indexOf('await server.listen(');
		expect(listenIdx).toBeGreaterThan(0);

		const startIdx = mainSource.indexOf('job.start()', listenIdx);
		expect(startIdx).toBeGreaterThan(listenIdx);

		const logIdx = mainSource.indexOf('job started name=', startIdx);
		expect(logIdx).toBeGreaterThan(startIdx);

		// Assert template literal format
		expect(mainSource).toContain('`job started name=${job.name}`');
	});

	it('AC 5: arch assertion: jobs/ directory has NO repo/ imports (08 backend isolation rule)', () => {
		const files = readdirSync(jobsSourceDir).filter((file) => file.endsWith('.ts'));
		expect(files.length).toBeGreaterThanOrEqual(5);

		for (const file of files) {
			const filePath = join(jobsSourceDir, file);
			const content = readFileSync(filePath, 'utf8');

			// Check for direct or relative repo/ imports
			const hasRepoImport = /from\s+['"][^'"]*repo\//.test(content);
			expect(
				hasRepoImport,
				`File ${file} in src/jobs/ must not import from repo/ (found violation)`,
			).toBe(false);
		}
	});

	it('AC 5: route handler and container services share the exact same gateService instance', () => {
		const container = makeTestContainer();
		const server = createHttpServer({ container });

		// Route handler extracts gateService from container.services.gates
		const containerGateService = container.services.gates;
		const serverContainerGateService = (
			server.instance as unknown as { container?: { services?: { gates?: unknown } } }
		)?.container?.services?.gates;

		expect(serverContainerGateService).toBe(containerGateService);
	});
});
