export class EnvFormatError extends Error {
	readonly varName: string;
	readonly expected: string;
	readonly actual: string;

	constructor(varName: string, expected: string, actual: string) {
		super(`invalid ${varName}="${actual}": expected ${expected}.`);
		this.name = 'EnvFormatError';
		this.varName = varName;
		this.expected = expected;
		this.actual = actual;
	}
}

export const PORT_ENV_NAME = 'AGSCHED_PORT';
export const PORT_DEFAULT = 7817;

// AGSCHED_PORT：缺失回落默认 7817；格式非法必须报错退出，不许静默回落。
export function parsePort(raw: string | undefined): number {
	if (raw === undefined || raw === '') return PORT_DEFAULT;
	if (!/^\d+$/.test(raw)) {
		throw new EnvFormatError(PORT_ENV_NAME, 'an integer port in 1..65535', raw);
	}
	const port = Number.parseInt(raw, 10);
	if (port < 1 || port > 65535) {
		throw new EnvFormatError(PORT_ENV_NAME, 'an integer port in 1..65535', raw);
	}
	return port;
}
