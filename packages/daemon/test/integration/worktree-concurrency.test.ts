import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
	type GitRunner,
	type WorktreeManagerDeps,
	createDefaultGitRunner,
	createWorktreeManager,
} from '../../src/workspace/worktree.ts';

const roots: string[] = [];
let sequence = 0;
const deps: WorktreeManagerDeps = {
	platform: process.platform as WorktreeManagerDeps['platform'],
	hostInputs: {
		platform: process.platform as WorktreeManagerDeps['platform'],
		homedir: homedir(),
		pathEnv: process.env.PATH ?? process.env.Path,
	},
	ids: { newId: () => `worktree-concurrency-${++sequence}` },
};
const realGit = createDefaultGitRunner(deps);

afterEach(() => {
	for (const root of roots.splice(0)) {
		expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
		expect(basename(root)).toMatch(/^worktree-concurrency-/);
		rmSync(root, { recursive: true, force: true });
	}
});

it('reuses the original wrapup branch without guessing a new collision suffix', async () => {
	const { root, repo } = await repository();
	const manager = createWorktreeManager(deps);
	const first = await manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'stable',
		round: 1,
		worktreesDir: root,
	});
	const reused = await manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'stable',
		round: 1,
		worktreesDir: root,
		worktreeMode: 'reuse',
	});
	expect(reused.branchName).toBe('wrapup/stable-1');
	expect(realpathSync.native(reused.worktreePath)).toBe(realpathSync.native(first.worktreePath));
	expect(reused.isReused).toBe(true);
	const collision = await manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'stable',
		round: 1,
		worktreesDir: root,
	});
	expect(collision.branchName).toBe('wrapup/stable-1-2');
	const selected = await manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'stable',
		round: 1,
		targetWorktreePath: collision.worktreePath,
		worktreeMode: 'reuse',
	});
	expect(selected.branchName).toBe(collision.branchName);
	expect(realpathSync.native(selected.worktreePath)).toBe(
		realpathSync.native(collision.worktreePath),
	);
});

it('removes a registered worktree addressed through a directory alias without force', async () => {
	const { root, repo } = await repository();
	const manager = createWorktreeManager(deps);
	const prepared = await manager.prepareWorktree({
		repoPath: repo,
		taskId: 'alias',
		targetWorktreePath: join(root, 'original'),
	});
	const alias = join(root, 'alias-parent');
	symlinkSync(root, alias, 'junction');
	const target = join(alias, 'original');
	expect(realpathSync.native(target)).toBe(realpathSync.native(prepared.worktreePath));
	// Keep this control scoped to the exact registration instead of relying on global prune.
	const cleanup = createWorktreeManager({
		...deps,
		gitRunner: {
			run(args, cwd, options) {
				if (args[0] === 'worktree' && args[1] === 'prune')
					return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
				return realGit.run(args, cwd, options);
			},
		},
	});
	await cleanup.removeWorktree({ repoPath: repo, worktreePath: target });
	expect(existsSync(prepared.worktreePath)).toBe(false);
	expect(
		(await manager.listWorktrees(repo)).some((entry) => entry.branch === prepared.branchName),
	).toBe(false);
});

async function repository() {
	const root = mkdtempSync(join(tmpdir(), 'worktree-concurrency-'));
	roots.push(root);
	const repo = join(root, 'repo');
	mkdirSync(repo);
	for (const args of [
		['init'],
		[
			'-c',
			'user.name=Concurrency test',
			'-c',
			'user.email=concurrency@example.invalid',
			'commit',
			'--allow-empty',
			'-m',
			'initial',
		],
	]) {
		const result = await realGit.run(args, repo);
		expect(result.exitCode, result.stderr).toBe(0);
	}
	return { root, repo };
}

function deferred() {
	let resolvePromise!: () => void;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

it('keeps name selection and creation atomic across managers and linked worktrees while another repository progresses', async () => {
	const { root, repo } = await repository();
	const other = await repository();
	const seed = await createWorktreeManager(deps).prepareWorktree({
		repoPath: repo,
		taskId: 'seed',
		worktreesDir: root,
	});
	writeFileSync(join(repo, 'user.txt'), 'preserve main user data');
	const entered = deferred();
	const release = deferred();
	let held = false;
	const runner: GitRunner = {
		async run(args, cwd, options) {
			if (!held && args[0] === 'worktree' && args[1] === 'add') {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return realGit.run(args, cwd, options);
		},
	};
	const first = createWorktreeManager({ ...deps, gitRunner: runner }).prepareWorktree({
		repoPath: repo,
		taskId: 'same',
		worktreesDir: root,
	});
	const firstResult = first.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await entered.promise;
	const second = createWorktreeManager(deps).prepareWorktree({
		repoPath: seed.worktreePath,
		taskId: 'same',
		worktreesDir: root,
	});
	const secondResult = second.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	try {
		const unrelated = await createWorktreeManager(deps).prepareWorktree({
			repoPath: other.repo,
			taskId: 'independent',
			worktreesDir: other.root,
		});
		expect(unrelated.branchName).toBe('task/independent');
	} finally {
		release.resolve();
		await Promise.all([firstResult, secondResult]);
	}
	const results = await Promise.all([firstResult, secondResult]);
	expect(results.map((result) => ('error' in result ? String(result.error) : null))).toEqual([
		null,
		null,
	]);
	const created = results.flatMap((result) => ('value' in result ? [result.value] : []));
	expect(created.map((result) => result.branchName)).toEqual(['task/same', 'task/same-2']);
	expect(new Set(created.map((result) => result.worktreePath)).size).toBe(2);
	expect(readFileSync(join(repo, 'user.txt'), 'utf8')).toBe('preserve main user data');
	for (const result of created) {
		const branch = await realGit.run(['symbolic-ref', '--short', 'HEAD'], result.worktreePath);
		expect(branch.stdout.trim()).toBe(result.branchName);
	}
});

it('releases repository ownership after a real Git failure and can prepare a wrapup', async () => {
	const { root, repo } = await repository();
	const entered = deferred();
	const release = deferred();
	let held = false;
	const runner: GitRunner = {
		async run(args, cwd, options) {
			if (!held && args[0] === 'worktree' && args[1] === 'add') {
				held = true;
				entered.resolve();
				await release.promise;
			}
			return realGit.run(args, cwd, options);
		},
	};
	const manager = createWorktreeManager({ ...deps, gitRunner: runner });
	const failed = manager
		.prepareWorktree({
			repoPath: repo,
			taskId: 'missing-base',
			baseRef: 'refs/heads/absent',
			worktreesDir: root,
		})
		.then(
			() => null,
			(error) => error,
		);
	await entered.promise;
	const next = manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'batch',
		round: 1,
		worktreesDir: root,
	});
	release.resolve();
	const [error, wrapup] = await Promise.all([failed, next]);
	expect(error).toMatchObject({ code: 'E_WORKSPACE_UNAVAILABLE' });
	expect(wrapup.branchName).toBe('wrapup/batch-1');
	const reused = await manager.prepareWrapupWorktree({
		repoPath: repo,
		batchId: 'batch',
		round: 1,
		targetWorktreePath: wrapup.worktreePath,
		worktreeMode: 'reuse',
	});
	expect(realpathSync.native(reused.worktreePath)).toBe(realpathSync.native(wrapup.worktreePath));
	expect(reused.branchName).toBe(wrapup.branchName);
	expect(reused.isReused).toBe(true);
});

it('keeps registry reads and reuse behind an in-flight registration', async () => {
	const { root, repo } = await repository();
	const other = await repository();
	const entered = deferred();
	const release = deferred();
	let held = false;
	const manager = createWorktreeManager({
		...deps,
		gitRunner: {
			async run(args, cwd, options) {
				if (!held && args[0] === 'worktree' && args[1] === 'add') {
					held = true;
					entered.resolve();
					await release.promise;
				}
				return realGit.run(args, cwd, options);
			},
		},
	});
	const target = join(root, 'explicit-worktree');
	const fresh = manager.prepareWorktree({
		repoPath: repo,
		taskId: 'reused',
		targetWorktreePath: target,
	});
	await entered.promise;
	let readCompleted = false;
	const read = manager.listWorktrees(repo).then((value) => {
		readCompleted = true;
		return value;
	});
	const reuse = manager
		.prepareWorktree({
			repoPath: repo,
			taskId: 'reused',
			targetWorktreePath: target,
			worktreeMode: 'reuse',
		})
		.then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
	let completedWhileHeld: boolean;
	try {
		await createWorktreeManager(deps).prepareWorktree({
			repoPath: other.repo,
			taskId: 'unrelated',
			worktreesDir: other.root,
		});
		completedWhileHeld = readCompleted;
	} finally {
		release.resolve();
		await Promise.all([fresh, read, reuse]);
	}
	const [created, entries, reused] = await Promise.all([fresh, read, reuse]);
	expect(completedWhileHeld).toBe(false);
	expect(entries.some((entry) => entry.branch === 'task/reused')).toBe(true);
	if ('error' in reused) throw reused.error;
	expect(realpathSync.native(reused.value.worktreePath)).toBe(
		realpathSync.native(created.worktreePath),
	);
	expect(reused.value).toMatchObject({ branchName: created.branchName, isReused: true });
});

it('does not remove a task worktree until its registration is complete', async () => {
	const { root, repo } = await repository();
	const other = await repository();
	const entered = deferred();
	const release = deferred();
	let held = false;
	const manager = createWorktreeManager({
		...deps,
		gitRunner: {
			async run(args, cwd, options) {
				// The test owns one exact worktree; never run a repository-wide prune on Windows.
				if (args[0] === 'worktree' && args[1] === 'prune')
					return { exitCode: 0, stdout: '', stderr: '' };
				if (!held && args[0] === 'worktree' && args[1] === 'add') {
					held = true;
					entered.resolve();
					await release.promise;
				}
				return realGit.run(args, cwd, options);
			},
		},
	});
	const target = join(root, 'to-remove');
	const fresh = manager.prepareWorktree({
		repoPath: repo,
		taskId: 'removed',
		targetWorktreePath: target,
	});
	await entered.promise;
	let removalCompleted = false;
	const removed = manager
		.removeWorktree({ repoPath: repo, worktreePath: target, force: true })
		.then((value) => {
			removalCompleted = true;
			return value;
		});
	let completedWhileHeld: boolean;
	try {
		await createWorktreeManager(deps).prepareWorktree({
			repoPath: other.repo,
			taskId: 'unrelated',
			worktreesDir: other.root,
		});
		completedWhileHeld = removalCompleted;
	} finally {
		release.resolve();
		await Promise.all([fresh, removed]);
	}
	expect(completedWhileHeld).toBe(false);
	expect(await removed).toEqual({ removed: true });
	expect((await manager.listWorktrees(repo)).some((entry) => entry.branch === 'task/removed')).toBe(
		false,
	);
});
