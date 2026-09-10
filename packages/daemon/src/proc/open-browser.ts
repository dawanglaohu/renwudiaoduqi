import { spawn as nodeSpawn } from 'node:child_process';
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
	) => { unref?: () => void };
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
		let fallbackPath: string;

		switch (hostInputs.platform) {
			case 'darwin': {
				executableName = 'open';
				fallbackPath = '/usr/bin/open';
				break;
			}
			case 'win32': {
				executableName = 'explorer.exe';
				fallbackPath = 'C:Windowsexplorer.exe';
				break;
			}
			default: {
				executableName = 'xdg-open';
				fallbackPath = '/usr/bin/xdg-open';
				break;
			}
		}

		const resolved = await resolver({
			hostInputs,
			executableName,
		});

		const file = resolved.ok ? resolved.executable.file : fallbackPath;
		const args = [targetPath];

		const child = processOps.spawn(file, args, {
			shell: false,
			windowsHide: true,
			detached: true,
			stdio: 'ignore',
		});

		if (typeof child.unref === 'function') {
			child.unref();
		}
	};
}
