import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createContainer } from '../../src/boot/container.ts';
import { createAgentRegistry } from '../../src/config/registry.ts';
import { openDatabase } from '../../src/db/open-database.ts';
import type { SupportedPlatform } from '../../src/platform/contract.ts';
import type { LockFileHandle, NativeLockAdapter } from '../../src/platform/lock-contract.ts';
import { createDefaultGitRunner } from '../../src/workspace/worktree.ts';

it.each([
	'missing',
	'existing',
	'deleted_after_preflight',
	'deleted_before_add',
	'deleted_with_remote',
	'deleted_before_attach',
] as const)('recovers the original rework branch safely: %s', async (scenario) => {
	const dataDir = mkdtempSync(join(tmpdir(), 'agsched-missing-branch-'));
	const repoPath = join(dataDir, 'repo');
	const worktreePath = join(dataDir, 'old-worktree');
	mkdirSync(repoPath);
	const git = (args: string[]) =>
		execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' });
	git(['init', '-b', 'main']);
	git([
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.invalid',
		'commit',
		'--allow-empty',
		'-m',
		'base',
	]);
	git(['switch', '-c', 'task/missing']);
	writeFileSync(join(repoPath, 'previous-work.txt'), 'work from the original implementation');
	git(['add', 'previous-work.txt']);
	git([
		'-c',
		'user.name=Test',
		'-c',
		'user.email=test@example.invalid',
		'commit',
		'-m',
		'implementation',
	]);
	const originalHead = git(['rev-parse', 'HEAD']).trim();
	git(['switch', 'main']);
	if (scenario === 'deleted_with_remote') {
		git(['remote', 'add', 'origin', repoPath]);
		git(['update-ref', 'refs/remotes/origin/task/missing', 'main']);
	}
	if (scenario === 'missing') git(['branch', '-D', 'task/missing']);
	const hostInputs = {
		platform: process.platform as SupportedPlatform,
		homedir: dataDir,
		pathEnv: process.env.PATH,
	};
	const nativeRunner = createDefaultGitRunner({
		platform: hostInputs.platform,
		hostInputs,
		ids: { newId: () => 'branch-probe' },
	});
	let deletedInRace = false;
	const racingRunner = {
		async run(args: readonly string[], cwd: string) {
			if (scenario === 'deleted_before_attach' && args[0] === 'switch') {
				git(['branch', '-D', 'task/missing']);
				deletedInRace = true;
			}
			if (
				(scenario === 'deleted_before_add' || scenario === 'deleted_with_remote') &&
				args[0] === 'worktree' &&
				args[1] === 'add'
			) {
				git(['branch', '-D', 'task/missing']);
				deletedInRace = true;
			}
			const result = await nativeRunner.run(args, cwd);
			if (
				scenario === 'deleted_after_preflight' &&
				!deletedInRace &&
				args[0] === 'rev-parse' &&
				args.includes('refs/heads/task/missing')
			) {
				git(['branch', '-D', 'task/missing']);
				deletedInRace = true;
			}
			return result;
		},
	};
	const db = openDatabase(':memory:');
	const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
	for (const file of readdirSync(migrationsDir)
		.filter((name) => name.endsWith('.sql'))
		.sort())
		db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
	let attemptedSpawns = 0;
	const container = createContainer({
		config: { port: 0, bind: '127.0.0.1', dataDir, logLevel: 'error', dev: false },
		database: db,
		hostInputs,
		...(scenario.startsWith('deleted_') ? { gitRunner: racingRunner } : {}),
		lockAdapter: {} as NativeLockAdapter,
		instanceLock: { release: () => undefined } as unknown as LockFileHandle,
		clock: { now: () => '2026-10-02T10:00:00.000Z' },
		bootstrapPairing: false,
		agentRegistry: createAgentRegistry({
			dataDir,
			builtInDefaults: {},
			platform: process.platform === 'win32' ? 'win32' : 'posix',
			publishWarning: (warning) => {
				throw new Error(warning.message);
			},
		}),
		spawnManaged: () => {
			attemptedSpawns += 1;
			throw new Error('agent launch boundary reached');
		},
	});
	try {
		await container.services.agents.start();
		container.repos.documents.insert({
			id: 'doc',
			docs_path: '/docs',
			project_name: 'Missing branch',
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
		container.repos.tasks.insert({
			id: 'task',
			doc_id: 'doc',
			task_key: 'M7-T5',
			title: 'Rework',
			module_key: 'M7',
			deps_json: '[]',
			contract_hash: 'fp',
			is_contract_ready: 1,
			contract_reasons_json: '[]',
		});
		container.repos.dispatchSnapshots?.insert({
			id: 'snapshot',
			task_id: 'task',
			contract_hash: 'fp',
			task_paths_json: '[]',
			launch_spec_json: '{}',
			created_at: container.clock.now(),
		});
		container.repos.runs.insert({
			id: 'implementation',
			task_id: 'task',
			attempt_no: 1,
			kind: 'implement',
			state: 'awaiting_human',
			agent_id: 'codex',
			permission_tier: 'workspaceWrite',
			snapshot_id: 'snapshot',
			worktree_path: worktreePath,
			branch_name: 'task/missing',
			vendor_session_ref: 'session',
		});
		const result = await container.services.rework.dispatchRework({
			targetRunId: 'implementation',
			reviewRunId: null,
			reworkText: 'Fix the listed parser boundary.',
			source: 'human',
		});
		const branches = git(['branch', '--list', 'task/missing']).trim();
		const gate = container.repos.gates?.findLatestByTaskIdAndKind('task', 'review');
		console.log(
			JSON.stringify({
				mode: result.mode,
				reason: 'reason' in result ? result.reason : null,
				branches,
				worktreeExists: existsSync(worktreePath),
				attemptedSpawns,
				gateComment: gate?.comment,
			}),
		);
		if (scenario === 'existing') {
			expect(result).toMatchObject({ mode: 'undeliverable', reason: 'spawn_failed' });
			expect(attemptedSpawns).toBe(1);
			expect(git(['rev-parse', 'refs/heads/task/missing']).trim()).toBe(originalHead);
			expect(
				execFileSync('git', ['symbolic-ref', 'HEAD'], {
					cwd: worktreePath,
					encoding: 'utf8',
				}).trim(),
			).toBe('refs/heads/task/missing');
			expect(readFileSync(join(worktreePath, 'previous-work.txt'), 'utf8')).toBe(
				'work from the original implementation',
			);
			expect(git(['branch', '--list', 'task/missing-*']).trim()).toBe('');
			return;
		}
		if (scenario.startsWith('deleted_')) expect(deletedInRace).toBe(true);
		expect(result).toMatchObject({ mode: 'awaiting_human', reason: 'branch_missing' });
		expect(branches).toBe('');
		expect(existsSync(worktreePath)).toBe(false);
		expect(attemptedSpawns).toBe(0);
		expect(gate?.comment).toBe('branch_missing');
	} finally {
		await container.services.agents.stop();
		container.events.dispose();
		db.close();
		expect(dirname(resolve(dataDir))).toBe(resolve(tmpdir()));
		expect(basename(dataDir)).toMatch(/^agsched-missing-branch-/);
		rmSync(dataDir, { recursive: true, force: true });
	}
});
