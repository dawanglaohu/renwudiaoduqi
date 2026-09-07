import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';

export type AutostartNameValidation =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false };

/**
 * deleteLine is the plain text command a human can paste verbatim to remove a
 * leftover registration, e.g. when a test run dies mid-cleanup (E-269).
 */
export interface AutostartEntryName {
	readonly argv: readonly string[];
	readonly deleteLine: string;
}

export interface AutostartStatus {
	readonly registered: boolean;
	readonly matchesSpec: boolean;
	readonly recordedSpec?: DaemonLaunchSpec;
}

export type AutostartErrorCode =
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

export interface AutostartAdapter {
	readonly register: (name: string, spec: DaemonLaunchSpec) => Promise<AutostartVoidResult>;
	readonly status: (
		name: string,
		spec: DaemonLaunchSpec,
	) => Promise<AutostartOperationResult<AutostartStatus>>;
	readonly unregister: (name: string) => Promise<AutostartVoidResult>;
}

const AUTOSTART_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidAutostartName(name: string): AutostartNameValidation {
	return AUTOSTART_NAME_PATTERN.test(name)
		? Object.freeze({ ok: true, value: name })
		: Object.freeze({ ok: false });
}
