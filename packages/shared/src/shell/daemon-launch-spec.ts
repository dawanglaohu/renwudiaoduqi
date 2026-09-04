export interface DaemonLaunchSpec {
	readonly file: string;
	readonly args: readonly string[];
	readonly cwd: string;
}

export interface DaemonLaunchSpecIssue {
	readonly path: '$' | '$.file' | '$.args' | '$.cwd';
	readonly reason: 'invalid-type' | 'missing' | 'not-absolute' | 'unknown-property';
}

export type DaemonLaunchSpecResult =
	| { readonly ok: true; readonly value: DaemonLaunchSpec }
	| { readonly ok: false; readonly issues: readonly DaemonLaunchSpecIssue[] };

const ABSOLUTE_LAUNCH_PATH_PATTERN =
	'^(?:/|[A-Za-z]:[\\\\/]|(?:\\\\\\\\|//)[^\\\\/]+[\\\\/][^\\\\/]+)';

export const DAEMON_LAUNCH_SPEC_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['file', 'args', 'cwd'],
	properties: {
		file: {
			type: 'string',
			minLength: 1,
			pattern: ABSOLUTE_LAUNCH_PATH_PATTERN,
		},
		args: {
			type: 'array',
			items: { type: 'string' },
		},
		cwd: {
			type: 'string',
			minLength: 1,
			pattern: ABSOLUTE_LAUNCH_PATH_PATTERN,
		},
	},
} as const satisfies {
	readonly type: 'object';
	readonly additionalProperties: false;
	readonly required: readonly (keyof DaemonLaunchSpec)[];
	readonly properties: Readonly<Record<keyof DaemonLaunchSpec, unknown>>;
};

export function parseDaemonLaunchSpec(input: unknown): DaemonLaunchSpecResult {
	if (!isRecord(input)) {
		return invalid([issue('$', 'invalid-type')]);
	}

	const issues: DaemonLaunchSpecIssue[] = [];
	for (const key of Object.keys(input)) {
		if (key !== 'file' && key !== 'args' && key !== 'cwd') {
			issues.push(issue('$', 'unknown-property'));
		}
	}

	const { file, args, cwd } = input;
	if (file === undefined) issues.push(issue('$.file', 'missing'));
	else if (typeof file !== 'string') issues.push(issue('$.file', 'invalid-type'));
	else if (!isAbsoluteLaunchPath(file)) issues.push(issue('$.file', 'not-absolute'));

	if (args === undefined) issues.push(issue('$.args', 'missing'));
	else if (!Array.isArray(args) || !args.every((argument) => typeof argument === 'string')) {
		issues.push(issue('$.args', 'invalid-type'));
	}

	if (cwd === undefined) issues.push(issue('$.cwd', 'missing'));
	else if (typeof cwd !== 'string') issues.push(issue('$.cwd', 'invalid-type'));
	else if (!isAbsoluteLaunchPath(cwd)) issues.push(issue('$.cwd', 'not-absolute'));

	if (
		issues.length > 0 ||
		typeof file !== 'string' ||
		!Array.isArray(args) ||
		!args.every((argument) => typeof argument === 'string') ||
		typeof cwd !== 'string'
	) {
		return invalid(issues);
	}

	return Object.freeze({
		ok: true,
		value: Object.freeze({ file, args: Object.freeze([...args]), cwd }),
	});
}

export function isAbsoluteLaunchPath(value: string): boolean {
	if (value.length === 0 || value.includes('\0')) return false;
	if (/^[A-Za-z]:[\\/]/.test(value)) return true;
	if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value)) return true;
	return value.startsWith('/');
}

function invalid(issues: readonly DaemonLaunchSpecIssue[]): DaemonLaunchSpecResult {
	return Object.freeze({ ok: false, issues: Object.freeze([...issues]) });
}

function issue(
	path: DaemonLaunchSpecIssue['path'],
	reason: DaemonLaunchSpecIssue['reason'],
): DaemonLaunchSpecIssue {
	return Object.freeze({ path, reason });
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === 'object' && input !== null && !Array.isArray(input);
}
