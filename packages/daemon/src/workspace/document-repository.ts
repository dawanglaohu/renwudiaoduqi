import { dirname, resolve } from 'node:path';
import { AppError } from '../errors/app-error.ts';
import type { SupportedPlatform } from '../platform/contract.ts';
import { classifyPathForHost } from '../platform/host.ts';
import { type GitRunner, checkGitRepository } from './worktree.ts';

/** A portable handoff repository name is not a host filesystem binding. */
export async function resolveDocumentRepository(
	docsPath: string,
	repoPath: string | undefined,
	runner: GitRunner,
): Promise<string> {
	if (
		repoPath !== undefined &&
		!classifyPathForHost(repoPath, process.platform as SupportedPlatform).isValidForCurrentPlatform
	) {
		throw new AppError('E_VALIDATION', `仓库目录必须是本机绝对路径：${repoPath}`, {
			details: { docsPath, repoPath },
		});
	}
	const target = repoPath ?? dirname(docsPath);
	const check = await checkGitRepository(target, runner);
	if (!check.isGitRepo || !check.repoRoot) {
		throw new AppError(
			'E_NOT_A_GIT_REPO',
			`无法访问 Git 仓库目录：${target}。请指定有效的仓库目录。`,
			{
				details: { docsPath, repoPath: target, reason: check.reason },
			},
		);
	}
	return resolve(check.repoRoot);
}
