export const PORT_ENV_NAME = 'AGSCHED_PORT';
export const PORT_DEFAULT = 7817;

export interface EnvironmentSnapshot {
	readonly product: {
		readonly port: string | undefined;
	};
	readonly host: {
		readonly appDataDir: string | undefined;
		readonly xdgDataHome: string | undefined;
	};
}

export interface ProcessConfig {
	readonly port: number;
}

export type ProcessConfigResult =
	| { readonly ok: true; readonly config: ProcessConfig }
	| {
			readonly ok: false;
			readonly variable: typeof PORT_ENV_NAME;
			readonly expected: string;
			readonly actual: string;
	  };

export function snapshotEnvironment(): EnvironmentSnapshot {
	return Object.freeze({
		product: Object.freeze({ port: process.env.AGSCHED_PORT }),
		host: Object.freeze({
			appDataDir: process.env.APPDATA,
			xdgDataHome: process.env.XDG_DATA_HOME,
		}),
	});
}

export function parseProcessConfig(input: EnvironmentSnapshot['product']): ProcessConfigResult {
	const rawPort = input.port;
	if (rawPort === undefined || rawPort === '') {
		return { ok: true, config: Object.freeze({ port: PORT_DEFAULT }) };
	}

	if (!/^\d+$/.test(rawPort)) return invalidPort(rawPort);
	const port = Number.parseInt(rawPort, 10);
	if (port < 1 || port > 65535) return invalidPort(rawPort);
	return { ok: true, config: Object.freeze({ port }) };
}

function invalidPort(actual: string): ProcessConfigResult {
	return {
		ok: false,
		variable: PORT_ENV_NAME,
		expected: 'an integer port in 1..65535',
		actual,
	};
}
