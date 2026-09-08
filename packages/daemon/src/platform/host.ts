import { homedir as readSystemHomedir } from 'node:os';
import type { AutostartDependencies } from './autostart-contract.ts';
import type {
	AppDataDirectoryResult,
	CurrentPlatformPath,
	PlatformAdapter,
	PlatformEnvironmentInputs,
	PlatformHostInputs,
	PlatformOperationError,
	PlatformPathAdapter,
	SupportedPlatform,
} from './contract.ts';
import { SUPPORTED_PLATFORMS } from './contract.ts';
import { DARWIN_PATH_ADAPTER, createDarwinAutostart, darwinKillTree } from './darwin.ts';
import { LINUX_PATH_ADAPTER, createLinuxAutostart, linuxKillTree } from './linux.ts';
import { WINDOWS_PATH_ADAPTER, createWindowsAutostart, windowsKillTree } from './windows.ts';

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

export type PlatformAdapterResult =
	| { readonly ok: true; readonly value: PlatformAdapter }
	| {
			readonly ok: false;
			readonly error: PlatformOperationError<'E_PLATFORM_UNSUPPORTED'>;
	  };

/** Resolves the only platform branch and binds one uniform adapter for callers. */
export function createPlatformAdapter(
	platform: NodeJS.Platform,
	host: Omit<PlatformHostInputs, 'platform'>,
	autostartName: string,
	autostartDependencies: AutostartDependencies,
): PlatformAdapterResult {
	if (!isSupportedPlatform(platform)) return unsupportedPlatform(platform);
	const hostInputs = Object.freeze({ ...host, platform });
	switch (platform) {
		case 'win32':
			return Object.freeze({
				ok: true,
				value: Object.freeze({
					...WINDOWS_PATH_ADAPTER,
					killTree: windowsKillTree,
					autostart: createWindowsAutostart(autostartName, autostartDependencies),
				}),
			});
		case 'darwin':
			return Object.freeze({
				ok: true,
				value: Object.freeze({
					...DARWIN_PATH_ADAPTER,
					killTree: darwinKillTree,
					autostart: createDarwinAutostart(autostartName, hostInputs, autostartDependencies),
				}),
			});
		case 'linux':
			return Object.freeze({
				ok: true,
				value: Object.freeze({
					...LINUX_PATH_ADAPTER,
					killTree: linuxKillTree,
					autostart: createLinuxAutostart(autostartName, hostInputs, autostartDependencies),
				}),
			});
	}
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
	return SUPPORTED_PLATFORMS.some((supported) => supported === platform);
}

function unsupportedPlatform(
	platform: NodeJS.Platform,
): Extract<PlatformAdapterResult, { readonly ok: false }> {
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			code: 'E_PLATFORM_UNSUPPORTED',
			message: 'The current host platform is not supported.',
			details: Object.freeze({ platform }),
		}),
	});
}
