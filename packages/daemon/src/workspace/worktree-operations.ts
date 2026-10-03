import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GitRunner } from './worktree.ts';

const pendingOperations = new Map<string, Promise<void>>();

async function repositoryKey(repoPath: string, runner: GitRunner): Promise<string> {
	const root = resolve(repoPath);
	const result = await runner.run(['rev-parse', '--git-common-dir'], root).catch(() => null);
	// Invalid repositories still run their normal validation inside the operation.
	const commonDir =
		result?.exitCode === 0 && result.stdout.trim() ? resolve(root, result.stdout.trim()) : root;
	const canonical = await realpath(commonDir).catch(() => commonDir);
	return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** Git exposes a partially written registration while worktree add is running. */
export async function withWorktreeOperation<T>(
	repoPath: string,
	runner: GitRunner,
	operation: () => Promise<T>,
): Promise<T> {
	const key = await repositoryKey(repoPath, runner);
	const previous = pendingOperations.get(key);
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	pendingOperations.set(key, current);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (pendingOperations.get(key) === current) pendingOperations.delete(key);
	}
}
