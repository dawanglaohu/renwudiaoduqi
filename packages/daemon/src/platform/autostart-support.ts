import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type { AutostartErrorCode, AutostartFailure, CommandResult } from './autostart-contract.ts';

export function encodeSpecBase64(spec: DaemonLaunchSpec): string {
	return Buffer.from(JSON.stringify([spec.file, spec.args, spec.cwd]), 'utf8').toString('base64');
}

export function decodeSpecBase64(encoded: string): DaemonLaunchSpec | undefined {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
		if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
		const [file, args, cwd] = parsed;
		if (
			typeof file !== 'string' ||
			!Array.isArray(args) ||
			args.some((argument) => typeof argument !== 'string') ||
			typeof cwd !== 'string'
		) {
			return undefined;
		}
		return Object.freeze({ file, args: Object.freeze([...args]), cwd });
	} catch {
		return undefined;
	}
}

export function specsEqual(left: DaemonLaunchSpec, right: DaemonLaunchSpec): boolean {
	return (
		left.file === right.file &&
		left.cwd === right.cwd &&
		left.args.length === right.args.length &&
		left.args.every((argument, index) => argument === right.args[index])
	);
}

export function failure(
	code: AutostartErrorCode,
	message: string,
	details: Readonly<Record<string, unknown>>,
	cause?: unknown,
): { readonly ok: false; readonly error: AutostartFailure } {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code, message, details, cause }),
	});
}

export function commandFailure(
	operation: 'register' | 'status' | 'unregister',
	result: Exclude<CommandResult, { readonly ok: true }>,
	details: Readonly<Record<string, unknown>>,
): { readonly ok: false; readonly error: AutostartFailure } {
	if (result.kind === 'unsupported') {
		return failure(
			'E_AUTOSTART_UNSUPPORTED',
			'The current host does not provide the required user autostart service.',
			Object.freeze({ ...details, stderr: result.stderr }),
			result.cause,
		);
	}
	const code =
		operation === 'register'
			? 'E_AUTOSTART_REGISTER_DENIED'
			: operation === 'unregister'
				? 'E_AUTOSTART_UNREGISTER_DENIED'
				: 'E_AUTOSTART_UNSUPPORTED';
	return failure(
		code,
		`The host failed the autostart ${operation} operation.`,
		Object.freeze({ ...details, stderr: result.stderr }),
		result.cause,
	);
}

export function invalidNameFailure(name: string) {
	return failure(
		'E_VALIDATION',
		'The autostart registration name is invalid.',
		Object.freeze({ name }),
	);
}

export function isFileNotFound(cause: unknown): boolean {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		(cause as NodeJS.ErrnoException).code === 'ENOENT'
	);
}

export function withManualStartCommand(
	result: { readonly ok: false; readonly error: AutostartFailure },
	manualStartCommand: string,
): { readonly ok: false; readonly error: AutostartFailure } {
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			...result.error,
			details: Object.freeze({ ...result.error.details, manualStartCommand }),
		}),
	});
}

export function xmlEscape(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export function xmlUnescape(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, '&');
}

/** CommandLineToArgvW-compatible quoting for one argument; no shell is involved. */
export function quoteForWindowsArgv(argument: string): string {
	if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
	const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1');
	return `"${escaped}"`;
}

export function quoteForSh(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
