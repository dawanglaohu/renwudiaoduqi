import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';

export type AutostartErrorCode =
	| 'E_VALIDATION'
	| 'E_PLATFORM_UNSUPPORTED'
	| 'E_AUTOSTART_UNSUPPORTED'
	| 'E_AUTOSTART_REGISTER_DENIED'
	| 'E_AUTOSTART_UNREGISTER_DENIED';

export interface AutostartFailure {
	readonly code: AutostartErrorCode;
	readonly message: string;
	readonly details: Readonly<Record<string, unknown>>;
	readonly cause?: unknown;
}

export type AutostartOperationResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: AutostartFailure };

export type AutostartVoidResult = AutostartOperationResult<null>;

export interface AutostartStatus {
	readonly registered: boolean;
	readonly matchesSpec: boolean;
	readonly recordedSpec?: DaemonLaunchSpec;
}

/** The registration name and platform dependencies are bound by the adapter factory. */
export interface AutostartAdapter {
	readonly register: (spec: DaemonLaunchSpec) => Promise<AutostartVoidResult>;
	readonly status: (spec: DaemonLaunchSpec) => Promise<AutostartOperationResult<AutostartStatus>>;
	readonly unregister: () => Promise<AutostartVoidResult>;
	/** Copyable fallback that preserves the launch file, argv, and working directory. */
	readonly manualStartCommand: (spec: DaemonLaunchSpec) => string;
	/** Copyable recovery command for a native entry left behind by interrupted cleanup. */
	readonly manualUnregisterCommand: string;
}

export type CommandFailureKind = 'not-found' | 'unsupported' | 'denied' | 'failed';

export type CommandResult =
	| { readonly ok: true; readonly stdout: string; readonly stderr: string }
	| {
			readonly ok: false;
			readonly kind: CommandFailureKind;
			readonly code: number | null;
			readonly stdout: string;
			readonly stderr: string;
			readonly cause?: unknown;
	  };

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface AutostartFileSystem {
	readonly makeDirectory: (path: string) => Promise<void>;
	readonly readTextFile: (path: string) => Promise<string>;
	readonly writeTextFile: (path: string, content: string) => Promise<void>;
	readonly removeFile: (path: string) => Promise<void>;
}

export interface AutostartDependencies {
	readonly files: AutostartFileSystem;
	readonly runCommand: CommandRunner;
	readonly temporaryDirectory: string;
}

const AUTOSTART_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidAutostartName(name: string): boolean {
	return AUTOSTART_NAME_PATTERN.test(name);
}
