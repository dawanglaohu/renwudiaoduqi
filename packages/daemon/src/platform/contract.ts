export const SUPPORTED_PLATFORMS = ['win32', 'darwin', 'linux'] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface PlatformEnvironmentInputs {
	readonly appData?: string;
	readonly xdgDataHome?: string;
}

export interface PlatformHostInputs extends PlatformEnvironmentInputs {
	readonly platform: SupportedPlatform;
	readonly homedir: string;
}

export interface PlatformOperationError<Code extends string> {
	readonly code: Code;
	readonly message: string;
	readonly details: Readonly<Record<string, unknown>>;
	readonly cause?: unknown;
}

export type AppDataDirectoryResult =
	| { readonly ok: true; readonly path: string }
	| {
			readonly ok: false;
			readonly error: PlatformOperationError<'E_DATA_DIR_UNRESOLVABLE'>;
	  };

export type CurrentPlatformPath =
	| {
			readonly isValidForCurrentPlatform: true;
			readonly value: string;
			readonly normalizedPath: string;
	  }
	| {
			readonly isValidForCurrentPlatform: false;
			readonly value: string;
			readonly reason: 'foreign-platform-path' | 'not-absolute';
	  };

export interface PlatformPathAdapter {
	readonly platform: SupportedPlatform;
	readonly requiresExecutablePermission: boolean;
	appDataDir(hostInputs: PlatformHostInputs): AppDataDirectoryResult;
	classifyPath(value: string): CurrentPlatformPath;
	executableCandidatePaths(
		executableName: string,
		hostInputs: PlatformHostInputs,
	): readonly string[];
	toFileSystemPath(value: string): string;
}

export interface PlatformAdapter extends PlatformPathAdapter {
	readonly killTree: (
		pid: number,
		processOps: import('./kill-tree-contract.ts').KillTreeProcessOps,
		options?: import('./kill-tree-contract.ts').KillTreeOptions,
	) => Promise<import('./kill-tree-contract.ts').KillTreeResult>;
	readonly autostart: import('./autostart-contract.ts').AutostartAdapter;
}

export interface ExecutableFileInfo {
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

export interface ExecutableFileSystem {
	lstat(path: string): Promise<ExecutableFileInfo>;
	readlink(path: string): Promise<string>;
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<ExecutableFileInfo>;
	access(path: string, mode: number): Promise<void>;
}

export interface ResolveExecutableInput {
	readonly hostInputs: PlatformHostInputs;
	readonly executableName: string;
	readonly configuredPath?: string;
	readonly windowsComSpecPath?: string;
}

interface ResolvedExecutableBase {
	readonly sourcePath: string;
	readonly file: string;
	readonly argsPrefix: readonly string[];
	readonly checkedPaths: readonly string[];
}

export interface DirectResolvedExecutable extends ResolvedExecutableBase {
	readonly launchKind: 'direct';
}

export interface ComSpecResolvedExecutable extends ResolvedExecutableBase {
	readonly launchKind: 'com-spec';
	readonly spawnOptions: {
		readonly windowsVerbatimArguments: true;
	};
}

export type ResolvedExecutable = DirectResolvedExecutable | ComSpecResolvedExecutable;

export type ExecutableResolutionErrorCode =
	| 'E_AGENT_EXEC_NOT_FOUND'
	| 'E_AGENT_EXEC_NOT_EXECUTABLE'
	| 'E_AGENT_EXEC_INVALID_TARGET';

export type ResolveExecutableResult =
	| { readonly ok: true; readonly executable: ResolvedExecutable }
	| {
			readonly ok: false;
			readonly error: PlatformOperationError<ExecutableResolutionErrorCode>;
	  };

export function hasUnexpandedPathToken(value: string): boolean {
	return value.includes('~') || /\$\{[^}]*\}/.test(value) || /%[^%]+%/.test(value);
}
