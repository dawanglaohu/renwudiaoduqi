import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import {
	BUILT_IN_AGENT_DEFAULTS,
	GENERIC_LOGIN_PROBE_DEFAULT,
	GENERIC_MODELS_LIVE_DEFAULT,
} from '../../src/config/defaults.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import { createHttpServer } from '../../src/http/server.ts';
import type { SupportedPlatform } from '../../src/platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import type { LaunchSpec } from '../../src/proc/spawn.ts';

it.each(['fresh', 'reuse', 'implementation-fresh', 'missing-worktree'] as const)(
	'respects stage workspace ownership with frozen mode %s',
	async (scenario) => {
		const worktreeMode = scenario === 'reuse' ? 'reuse' : 'fresh';
		const tempRoot = realpathSync.native(tmpdir());
		const dataDir = mkdtempSync(join(tempRoot, 'agsched-bughunt-worktree-'));
		const repoPath = join(dataDir, 'repo');
		const worktreePath = join(dataDir, 'original-worktree');
		mkdirSync(repoPath);
		const git = (args: string[], cwd = repoPath) =>
			execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
		const commit = (message: string, cwd = repoPath) =>
			git(
				[
					'-c',
					'user.name=Test',
					'-c',
					'user.email=test@example.invalid',
					'commit',
					'--allow-empty',
					'-m',
					message,
				],
				cwd,
			);
		git(['init', '-b', 'main']);
		commit('base');
		git(['worktree', 'add', '-b', 'task/BH-T1', worktreePath, 'main']);
		writeFileSync(join(worktreePath, 'implementation.txt'), 'implementation under review');
		git(['add', 'implementation.txt'], worktreePath);
		commit('implementation', worktreePath);
		writeFileSync(join(worktreePath, 'uncommitted.txt'), 'preserve this working-tree change');
		const branchesBefore = git(['for-each-ref', '--format=%(refname)', 'refs/heads/']);
		const db = openDatabase(':memory:');
		const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
		for (const file of readdirSync(migrationsDir)
			.filter((name) => name.endsWith('.sql'))
			.sort())
			db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
		const launches: Array<{
			spec: LaunchSpec;
			implementation: string | null;
			uncommitted: string | null;
		}> = [];
		const container = createContainer({
			config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
			database: db,
			hostInputs: {
				platform: process.platform as SupportedPlatform,
				homedir: dataDir,
				pathEnv: process.env.PATH,
			},
			lockAdapter: {} as NativeLockAdapter,
			instanceLock: { release: () => undefined } as unknown as LockFileHandle,
			clock: { now: () => '2026-10-03T10:00:00.000Z' },
			bootstrapPairing: false,
			codexSessions: null,
			agentRegistry: createAgentRegistry({
				dataDir,
				builtInDefaults: {
					codex: {
						...BUILT_IN_AGENT_DEFAULTS.codex,
						execPath: process.execPath,
						versionFingerprint: { args: ['--version'], expectedPattern: '^v[0-9]+' },
						loginProbe: GENERIC_LOGIN_PROBE_DEFAULT,
						modelsLive: GENERIC_MODELS_LIVE_DEFAULT,
					},
				},
				platform: process.platform === 'win32' ? 'win32' : 'posix',
				publishWarning: (warning) => {
					throw new Error(warning.message);
				},
			}),
			spawnManaged: (spec) => {
				const readAtLaunch = (name: string) =>
					existsSync(join(spec.cwd, name)) ? readFileSync(join(spec.cwd, name), 'utf8') : null;
				launches.push({
					spec,
					implementation: readAtLaunch('implementation.txt'),
					uncommitted: readAtLaunch('uncommitted.txt'),
				});
				throw new Error('controlled agent launch failure');
			},
		});
		const server = createHttpServer({ container });
		try {
			await container.services.agents.start();
			expect(container.services.agents.getAvailability('codex')?.canDispatch).toBe(true);
			container.repos.documents.insert({
				id: 'doc',
				docs_path: '/docs',
				project_name: 'Bughunt worktree',
				repo_path: repoPath,
				main_branch: 'main',
				branch_prefix: 'task/',
				lane_count: 1,
				content_fingerprint: 'fp',
				is_source_readable: 1,
				is_takeover_notified: 0,
				imported_at: container.clock.now(),
				last_seen_at: container.clock.now(),
			});
			container.repos.batches.insert({
				id: 'batch',
				doc_id: 'doc',
				batch_no: 1,
				state: 'running',
				started_at: container.clock.now(),
			});
			container.repos.tasks.insert({
				id: 'task',
				doc_id: 'doc',
				task_key: 'BH-T1',
				title: 'Bughunt',
				module_key: 'M7',
				deps_json: '[]',
				batch_id: 'batch',
				contract_hash: 'fp',
				is_contract_ready: 1,
				contract_reasons_json: '[]',
			});
			container.repos.tasks.setLaneNo('task', 1);
			container.repos.dispatchSnapshots?.insert({
				id: 'snapshot',
				task_id: 'task',
				contract_hash: 'fp',
				task_paths_json: '[]',
				launch_spec_json: JSON.stringify({ execPath: process.execPath, worktreeMode }),
				created_at: container.clock.now(),
			});
			container.repos.runs.insert({
				id: 'implementation',
				task_id: 'task',
				batch_id: 'batch',
				attempt_no: 1,
				kind: 'implement',
				state: scenario === 'implementation-fresh' ? 'starting' : 'reviewing',
				agent_id: 'codex',
				permission_tier: 'workspaceWrite',
				snapshot_id: 'snapshot',
				worktree_path: worktreePath,
				branch_name: 'task/BH-T1',
				lane_no: 1,
			});
			if (scenario === 'implementation-fresh') {
				await expect(container.services.dispatch.launchRun('implementation')).rejects.toThrow(
					'controlled agent launch failure',
				);
				expect(launches).toHaveLength(1);
				expect(resolve(launches[0]?.spec.cwd ?? '')).not.toBe(worktreePath);
				expect(launches[0]?.implementation).toBeNull();
				expect(git(['branch', '--list', 'task/BH-T1-2'])).toBeTruthy();
				return;
			}
			if (!container.services.bughunt) throw new Error('Bughunt service is not registered');
			if (scenario === 'missing-worktree') {
				expect(dirname(resolve(worktreePath))).toBe(resolve(dataDir));
				git(['worktree', 'remove', '--force', worktreePath]);
				const result = await container.services.bughunt.dispatchBughunt({
					implRunId: 'implementation',
				});
				expect(result.action).toBe('baseline_unavailable');
				expect(launches).toHaveLength(0);
				expect(container.repos.runs.findById('implementation')?.state).toBe('awaiting_human');
				expect(container.repos.gates?.findLatestByTaskIdAndKind('task', 'review')?.comment).toBe(
					'bughunt_failed',
				);
				expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(branchesBefore);
				expect(existsSync(worktreePath)).toBe(false);
				return;
			}
			await container.services.bughunt.dispatchBughunt({ implRunId: 'implementation' });
			await expect
				.poll(() => container.repos.runs.findById('implementation')?.state)
				.toBe('awaiting_human');
			const bughunt = container.repos.runs.findByParentRunIdAndKind?.('implementation', 'bughunt');
			expect(bughunt?.state).toBe('failed');
			expect(launches).toHaveLength(1);
			expect.soft(resolve(launches[0]?.spec.cwd ?? '')).toBe(worktreePath);
			expect.soft(launches[0]?.implementation).toBe('implementation under review');
			expect.soft(launches[0]?.uncommitted).toBe('preserve this working-tree change');
			expect.soft(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(branchesBefore);
			const { code } = container.services.pairing.createPairingCode();
			const { token } = await container.services.pairing.claimPairingCode({
				code,
				deviceName: 'bughunt-worktree-test',
			});
			const rerunResponse = await server.instance.inject({
				method: 'POST',
				url: `/api/v1/runs/${bughunt?.id}/rerun`,
				headers: { authorization: `Bearer ${token}` },
				payload: { idempotencyKey: 'bughunt-rerun' },
			});
			expect(rerunResponse.statusCode).toBe(200);
			const rerun = rerunResponse.json();
			await container.services.dispatch.tick();
			await expect
				.poll(() => container.repos.runs.findById('implementation')?.state)
				.toBe('awaiting_human');
			expect(launches).toHaveLength(2);
			expect.soft(launches[1]?.spec.runId).toBe(rerun.run.id);
			expect.soft(resolve(launches[1]?.spec.cwd ?? '')).toBe(worktreePath);
			expect.soft(launches[1]?.implementation).toBe('implementation under review');
			expect.soft(launches[1]?.uncommitted).toBe('preserve this working-tree change');
			expect.soft(git(['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe(branchesBefore);
			expect(git(['symbolic-ref', 'HEAD'], worktreePath)).toBe('refs/heads/task/BH-T1');
			expect(
				JSON.parse(
					container.repos.dispatchSnapshots?.findById('snapshot')?.launch_spec_json ?? '{}',
				).worktreeMode,
			).toBe(worktreeMode);
		} finally {
			await server.close();
			await container.services.agents.stop();
			container.events.dispose();
			db.close();
			expect(dirname(resolve(dataDir))).toBe(tempRoot);
			expect(basename(dataDir)).toMatch(/^agsched-bughunt-worktree-/);
			rmSync(dataDir, { recursive: true, force: true });
		}
	},
);
