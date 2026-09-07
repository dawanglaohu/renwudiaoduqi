import type { DaemonLaunchSpec } from '@agent-scheduler/shared/shell/daemon-launch-spec';
import type { AutostartFailure } from './autostart-contract.ts';

export interface CommandResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

/** Encodes the three launch-spec fields losslessly: file, cwd, then args as JSON. */
export function encodeSpec(spec: DaemonLaunchSpec): string {
	return `${spec.file}\n${spec.cwd}\n${JSON.stringify(spec.args)}\n`;
}

export function decodeSpec(encoded: string): DaemonLaunchSpec | undefined {
	const lines = encoded.split('\n');
	const [file, cwd, argsLine] = [lines[0], lines[1], lines[2]];
	if (file === undefined || cwd === undefined || argsLine === undefined) return undefined;
	if (file.length === 0 || cwd.length === 0) return undefined;
	let args: unknown;
	try {
		args = JSON.parse(argsLine);
	} catch {
		return undefined;
	}
	if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
		return undefined;
	}
	return Object.freeze({ file, cwd, args: Object.freeze([...(args as readonly string[])]) });
}

export function encodeSpecBase64(spec: DaemonLaunchSpec): string {
	return Buffer.from(encodeSpec(spec), 'utf8').toString('base64');
}

export function decodeSpecBase64(encoded: string): DaemonLaunchSpec | undefined {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
	try {
		return decodeSpec(Buffer.from(encoded, 'base64').toString('utf8'));
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

export function deniedFailure(
	operation: 'register' | 'unregister' | 'status',
	details: Readonly<Record<string, unknown>>,
	cause?: unknown,
): { readonly ok: false; readonly error: AutostartFailure } {
	const code: AutostartFailure['code'] =
		operation === 'unregister'
			? 'E_AUTOSTART_UNREGISTER_DENIED'
			: operation === 'register'
				? 'E_AUTOSTART_REGISTER_DENIED'
				: 'E_AUTOSTART_UNSUPPORTED';
	return Object.freeze({
		ok: false,
		error: Object.freeze({
			code,
			message: `The host refused the autostart ${operation} operation.`,
			details,
			cause,
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

/** CommandLineToArgvW-compatible quoting for a single argument (no shell involved). */
export function quoteForWindowsArgv(argument: string): string {
	if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
	const escaped = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1');
	return `"${escaped}"`;
}

/** Single-quote escaping for POSIX sh. */
export function quoteForSh(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
