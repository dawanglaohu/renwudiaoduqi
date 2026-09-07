import { homedir as readSystemHomedir } from 'node:os';
import type {
	AppDataDirectoryResult,
	CurrentPlatformPath,
	PlatformEnvironmentInputs,
	PlatformHostInputs,
	PlatformOperationError,
	PlatformPathAdapter,
	SupportedPlatform,
} from './contract.ts';
import { SUPPORTED_PLATFORMS } from './contract.ts';
import { DARWIN_PATH_ADAPTER } from './darwin.ts';
import { LINUX_PATH_ADAPTER } from './linux.ts';
import { WINDOWS_PATH_ADAPTER } from './windows.ts';

export interface HostReader {
	readonly platform: () => NodeJS.Platform;
	readonly homedir: () => string;
}

export type PlatformHostInputsResult =
	| { readonly ok: true; readonly value: PlatformHostInputs }
	| {
			readonly ok: false;
			readonly error: PlatformOperationError<'E_PLATFORM_UNSUPPORTED'>;
	  };

const HOST_READER: HostReader = Object.freeze({
	platform: () => process.platform,
	homedir: readSystemHomedir,
});

export function takePlatformHostInputs(
	environment: PlatformEnvironmentInputs,
	hostReader: HostReader = HOST_READER,
): PlatformHostInputsResult {
	const platform = hostReader.platform();
	if (!isSupportedPlatform(platform)) {
		return Object.freeze({
			ok: false,
			error: Object.freeze({
				code: 'E_PLATFORM_UNSUPPORTED',
				message: 'The current host platform is not supported.',
				details: Object.freeze({ platform }),
			}),
		});
	}

	return Object.freeze({
		ok: true,
		value: Object.freeze({
			platform,
			homedir: hostReader.homedir(),
			appData: environment.appData,
			xdgDataHome: environment.xdgDataHome,
		}),
	});
}

export function appDataDir(hostInputs: PlatformHostInputs): AppDataDirectoryResult {
	return platformPathAdapter(hostInputs.platform).appDataDir(hostInputs);
}

export function classifyPathForHost(
	value: string,
	platform: SupportedPlatform,
): CurrentPlatformPath {
	return platformPathAdapter(platform).classifyPath(value);
}

export function platformPathAdapter(platform: SupportedPlatform): PlatformPathAdapter {
	switch (platform) {
		case 'win32':
			return WINDOWS_PATH_ADAPTER;
		case 'darwin':
			return DARWIN_PATH_ADAPTER;
		case 'linux':
			return LINUX_PATH_ADAPTER;
	}
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
	return SUPPORTED_PLATFORMS.some((supported) => supported === platform);
}

// ---------------------------------------------------------------------------
// Platform adapter seam (E-132). Platforms outside the three supported
// setters get E_PLATFORM_UNSUPPORTED, never a near-name fallthrough into a
// better-matching adapter.
// ---------------------------------------------------------------------------

export interface PlatformKillTreeAdapter {
	readonly killTree: typeof platformKillTree;
}

import type {
	KillTreeClock,
	KillTreeEmit,
	KillTreeResult,
} from './kill-tree-contract.ts';
import { darwinKillTree } from './darwin.ts';
import { linuxKillTree } from './linux.ts';
import { windowsKillTree } from './windows.ts';

export function platformKillTree(
	platform: SupportedPlatform,
	pid: number,
	options: {
		readonly graceMs?: number;
		readonly clock?: KillTreeClock;
		readonly signal?: AbortSignal;
		readonly emit?: KillTreeEmit;
		readonly spawnImpl?: unknown;
	},
): Promise<KillTreeResult> {
	switch (platform) {
		case 'win32':
			return windowsKillTree(pid, options as never);
		case 'darwin':
			return darwinKillTree(pid, options);
		case 'linux':
			return linuxKillTree(pid, options);
	}
	const error = Object.freeze({
		code: 'E_PLATFORM_UNSUPPORTED',
		message: 'The current host platform is not supported.',
		details: Object.freeze({ platform }),
	});
	throw Object.assign(new Error(error.message), { code: error.code, details: error.details });
}
