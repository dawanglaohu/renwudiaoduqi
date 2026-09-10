import { spawn as nodeSpawn } from 'node:child_process';
import { AppError } from '../errors/app-error.ts';
import type { PlatformHostInputs } from '../platform/contract.ts';
import { resolveExecutable } from '../platform/resolve-executable.ts';

export type OpenBrowserFn = (targetPath: string) => Promise<void> | void;

export interface OpenBrowserProcessOps {
	readonly spawn: (
		file: string,
		args: readonly string[],
		options: {
			readonly shell: false;
			readonly windowsHide: boolean;
			readonly detached: boolean;
			readonly stdio: 'ignore';
		},
	) => {
		unref?: () => void;
		on?: (event: 'error', listener: (err: Error) => void) => void;
	};
}

export function defaultOpenBrowserProcessOps(): OpenBrowserProcessOps {
	return Object.freeze({
		spawn(
			file: string,
			args: readonly string[],
			options: Parameters<OpenBrowserProcessOps['spawn']>[2],
		) {
			return nodeSpawn(file, [...args], {
				shell: options.shell,
				windowsHide: options.windowsHide,
				detached: options.detached,
				stdio: options.stdio,
			});
		},
	});
}

export interface CreateOpenBrowserOptions {
	readonly hostInputs: PlatformHostInputs;
	readonly processOps?: OpenBrowserProcessOps;
	readonly resolver?: typeof resolveExecutable;
}

export function createOpenBrowser(options: CreateOpenBrowserOptions): OpenBrowserFn {
	const hostInputs = options.hostInputs;
	const processOps = options.processOps ?? defaultOpenBrowserProcessOps();
	const resolver = options.resolver ?? resolveExecutable;

	return async function openInDefaultBrowser(targetPath: string): Promise<void> {
		let executableName: string;
		let candidatePath: string;

		switch (hostInputs.platform) {
			case 'darwin': {
				executableName = 'open';
				candidatePath = '/usr/bin/open';
				break;
			}
			case 'win32': {
				executableName = 'explorer.exe';
				candidatePath = 'C:\\Windows\\explorer.exe';
				break;
			}
			default: {
				executableName = 'xdg-open';
				candidatePath = '/usr/bin/xdg-open';
				break;
			}
		}

		const resolved = await resolver({
			hostInputs,
			executableName,
			configuredPath: candidatePath,
		});

		if (!resolved.ok) {
			throw new AppError(
				'E_AGENT_EXEC_NOT_FOUND',
				`Failed to resolve browser executable for platform ${hostInputs.platform}: ${resolved.error.message}`,
				{
					details: {
						platform: hostInputs.platform,
						executableName,
						candidatePath,
						error: resolved.error,
					},
				},
			);
		}

		const file = resolved.executable.file;
		const args = [targetPath];

		const child = processOps.spawn(file, args, {
			shell: false,
			windowsHide: true,
			detached: true,
			stdio: 'ignore',
		});

		if (typeof child.on === 'function') {
			child.on('error', () => {
				// Prevent unhandled errors from detached browser processes
			});
		}

		if (typeof child.unref === 'function') {
			child.unref();
		}
	};
}
