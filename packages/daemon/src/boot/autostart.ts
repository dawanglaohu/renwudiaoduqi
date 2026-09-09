import { parseDaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type {
	AutostartAdapter,
	AutostartErrorCode,
	AutostartFailure,
	AutostartOperationResult,
	AutostartStatus,
	AutostartVoidResult,
} from '../platform/autostart-contract.ts';

export type AutostartRegistrationResult =
	| {
			readonly ok: true;
			readonly registered: true;
			readonly matchesSpec: true;
			readonly rewritten: boolean;
	  }
	| {
			readonly ok: false;
			readonly registered: boolean;
			readonly matchesSpec: boolean;
			readonly error: AutostartFailure;
			readonly manualStartCommand?: string;
	  };

export interface AutostartRegistrar {
	readonly register: (spec: unknown) => Promise<AutostartRegistrationResult>;
	readonly status: (spec: unknown) => Promise<AutostartOperationResult<AutostartStatus>>;
	readonly unregister: () => Promise<AutostartVoidResult>;
	readonly manualStartCommand: (spec: unknown) => string | undefined;
}

/**
 * Registers native autostart for the daemon with the specified launch spec.
 *
 * Requirements (E-209, E-210, E-261):
 * - Validates absolute file, args[], and absolute cwd.
 * - Idempotent: field-by-field check against current registration; does not rewrite if identical.
 * - Rewrites when any field changes (e.g. after upgrade).
 * - Never composes a shell command string; preserves separate file, args[], cwd.
 * - Non-fatal on failure: returns typed failure and copyable manual command (E-210, E-261).
 */
export async function register(
	spec: unknown,
	adapter: AutostartAdapter,
): Promise<AutostartRegistrationResult> {
	const parseResult = parseDaemonLaunchSpec(spec);
	if (!parseResult.ok) {
		const validationFailure: AutostartFailure = Object.freeze({
			code: 'E_VALIDATION' as AutostartErrorCode,
			message: 'The autostart launch specification is invalid or contains non-absolute paths.',
			details: Object.freeze({ issues: parseResult.issues }),
		});
		return Object.freeze({
			ok: false,
			registered: false,
			matchesSpec: false,
			error: validationFailure,
		});
	}

	const validSpec = parseResult.value;

	let currentStatus: AutostartOperationResult<AutostartStatus>;
	try {
		currentStatus = await adapter.status(validSpec);
	} catch (cause) {
		const manualStartCommand = adapter.manualStartCommand(validSpec);
		const statusFailure: AutostartFailure = Object.freeze({
			code: 'E_AUTOSTART_UNSUPPORTED' as AutostartErrorCode,
			message: 'Failed to query current native autostart status.',
			details: Object.freeze({ manualStartCommand }),
			cause,
		});
		return Object.freeze({
			ok: false,
			registered: false,
			matchesSpec: false,
			manualStartCommand,
			error: statusFailure,
		});
	}

	if (!currentStatus.ok) {
		const manualStartCommand = adapter.manualStartCommand(validSpec);
		const error: AutostartFailure = Object.freeze({
			...currentStatus.error,
			details: Object.freeze({
				...currentStatus.error.details,
				manualStartCommand,
			}),
		});
		return Object.freeze({
			ok: false,
			registered: false,
			matchesSpec: false,
			manualStartCommand,
			error,
		});
	}

	const statusValue = currentStatus.value;
	if (statusValue.registered && statusValue.matchesSpec) {
		return Object.freeze({
			ok: true,
			registered: true,
			matchesSpec: true,
			rewritten: false,
		});
	}

	let registerResult: AutostartVoidResult;
	try {
		registerResult = await adapter.register(validSpec);
	} catch (cause) {
		const manualStartCommand = adapter.manualStartCommand(validSpec);
		const registerFailure: AutostartFailure = Object.freeze({
			code: 'E_AUTOSTART_REGISTER_DENIED' as AutostartErrorCode,
			message: 'System denied native autostart registration.',
			details: Object.freeze({ manualStartCommand }),
			cause,
		});
		return Object.freeze({
			ok: false,
			registered: false,
			matchesSpec: false,
			manualStartCommand,
			error: registerFailure,
		});
	}

	if (!registerResult.ok) {
		const manualStartCommand =
			(registerResult.error.details.manualStartCommand as string | undefined) ??
			adapter.manualStartCommand(validSpec);
		const error: AutostartFailure = Object.freeze({
			...registerResult.error,
			details: Object.freeze({
				...registerResult.error.details,
				manualStartCommand,
			}),
		});
		return Object.freeze({
			ok: false,
			registered: false,
			matchesSpec: false,
			manualStartCommand,
			error,
		});
	}

	return Object.freeze({
		ok: true,
		registered: true,
		matchesSpec: true,
		rewritten: statusValue.registered && !statusValue.matchesSpec,
	});
}

export async function status(
	spec: unknown,
	adapter: AutostartAdapter,
): Promise<AutostartOperationResult<AutostartStatus>> {
	const parseResult = parseDaemonLaunchSpec(spec);
	if (!parseResult.ok) {
		return Object.freeze({
			ok: false,
			error: Object.freeze({
				code: 'E_VALIDATION' as AutostartErrorCode,
				message: 'The autostart launch specification is invalid or contains non-absolute paths.',
				details: Object.freeze({ issues: parseResult.issues }),
			}),
		});
	}
	return adapter.status(parseResult.value);
}

export async function unregister(adapter: AutostartAdapter): Promise<AutostartVoidResult> {
	return adapter.unregister();
}

export function createAutostartRegistrar(adapter: AutostartAdapter): AutostartRegistrar {
	return Object.freeze({
		register: (spec: unknown) => register(spec, adapter),
		status: (spec: unknown) => status(spec, adapter),
		unregister: () => unregister(adapter),
		manualStartCommand: (spec: unknown): string | undefined => {
			const parseResult = parseDaemonLaunchSpec(spec);
			return parseResult.ok ? adapter.manualStartCommand(parseResult.value) : undefined;
		},
	});
}
