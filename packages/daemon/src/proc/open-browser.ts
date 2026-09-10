import { spawn as nodeSpawn } from 'node:child_process';
import type { SupportedPlatform } from '../platform/contract.ts';

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

export function createOpenBrowser(options?: {
	readonly platform?: SupportedPlatform;
	readonly processOps?: OpenBrowserProcessOps;
}): OpenBrowserFn {
	const platform = options?.platform ?? (process.platform as SupportedPlatform);
	const processOps = options?.processOps ?? defaultOpenBrowserProcessOps();

	return async function openInDefaultBrowser(targetPath: string): Promise<void> {
		let file: string;
		let args: readonly string[];

		switch (platform) {
			case 'darwin': {
				file = '/usr/bin/open';
				args = [targetPath];
				break;
			}
			case 'win32': {
				file = 'explorer.exe';
				args = [targetPath];
				break;
			}
			default: {
				file = '/usr/bin/xdg-open';
				args = [targetPath];
				break;
			}
		}

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
