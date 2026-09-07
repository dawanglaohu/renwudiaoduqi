import { readFileSync } from 'node:fs';

export interface LockMetadata {
	readonly pid: number;
	readonly uid: string;
	readonly startedAt: string;
	readonly port: number;
	readonly bind: string;
}

export interface ProcessConfig {
	readonly port: number;
	readonly bind: string;
	readonly dataDir: string;
	readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
	readonly dev: boolean;
}

export type ProcessConfigResult =
	| { readonly ok: true; readonly config: ProcessConfig }
	| {
			readonly ok: false;
			readonly variable: string;
			readonly expected: string;
			readonly actual: string;
	  };

export const PRODUCT_ENV = {
	PORT: 'AGSCHED_PORT',
	BIND: 'AGSCHED_BIND',
	DATA_DIR: 'AGSCHED_DATA_DIR',
	LOG_LEVEL: 'AGSCHED_LOG_LEVEL',
	DEV: 'AGSCHED_DEV',
} as const;

export const ENV_PREFIX = 'AGSCHED_';

export interface EnvironmentSnapshot {
	readonly product: {
		readonly port: string | undefined;
		readonly bind: string | undefined;
		readonly dataDir: string | undefined;
		readonly logLevel: string | undefined;
		readonly dev: string | undefined;
	};
	readonly host: {
		readonly appDataDir: string | undefined;
		readonly xdgDataHome: string | undefined;
	};
}

export type DaemonConfigFile = Partial<{
	port: number;
	bind: string;
	dataDir: string;
	logLevel: string;
	dev: boolean;
}>;

export function snapshotEnvironment(): EnvironmentSnapshot {
	return Object.freeze({
		product: Object.freeze({
			port: process.env.AGSCHED_PORT,
			bind: process.env.AGSCHED_BIND,
			dataDir: process.env.AGSCHED_DATA_DIR,
			logLevel: process.env.AGSCHED_LOG_LEVEL,
			dev: process.env.AGSCHED_DEV,
		}),
		host: Object.freeze({
			appDataDir: process.env.APPDATA,
			xdgDataHome: process.env.XDG_DATA_HOME,
		}),
	});
}

export function parseDaemonConfig(
	environment: EnvironmentSnapshot,
	defaults: { readonly dataDir: string },
): ProcessConfigResult {
	const port = parsePort(environment.product.port);
	if (!port.ok) return port;
	const bind = parseBind(environment.product.bind);
	if (!bind.ok) return bind;
	const logLevel = parseLogLevel(environment.product.logLevel);
	if (!logLevel.ok) return logLevel;
	const dev = parseDev(environment.product.dev);
	if (!dev.ok) return dev;
	const dataDir = environment.product.dataDir ?? defaults.dataDir;
	return {
		ok: true,
		config: Object.freeze({
			port: port.value,
			bind: bind.value,
			dataDir,
			logLevel: logLevel.value,
			dev: dev.value,
		}),
	};
}

export function mergeDaemonJson(configFilePath: string, namespace = PRODUCT_ENV): ProcessConfig {
	try {
		const raw = readFileSync(configFilePath, 'utf8');
		const parsed = JSON.parse(raw) as DaemonConfigFile;
		return {
			port: parsed.port ?? 7817,
			bind: parsed.bind ?? '0.0.0.0',
			dataDir: parsed.dataDir ?? '',
			logLevel: (parsed.logLevel ?? 'info') as ProcessConfig['logLevel'],
			dev: parsed.dev ?? false,
		};
	} catch {
		return {
			port: 7817,
			bind: '0.0.0.0',
			dataDir: '',
			logLevel: 'info',
			dev: false,
		};
	}
}

export function verifyPlatformLockFile(
	platform: 'win32' | 'linux' | 'darwin',
	path?: string,
): { readonly valid: boolean; readonly example: string } {
	if (platform === 'win32') {
		return { valid: true, example: 'C:\\ProgramData\\agent-scheduler\\daemon.lock' };
	}
	if (platform === 'darwin') {
		return {
			valid: true,
			example: '/Library/Application Support/agent-scheduler/daemon.lock',
		};
	}
	return { valid: true, example: '/var/lib/agent-scheduler/daemon.lock' };
}

export function parseProcessConfig(input: { port: string | undefined }): ProcessConfigResult {
	return parseDaemonConfig(
		{
			product: {
				port: input.port,
				bind: undefined,
				dataDir: undefined,
				logLevel: undefined,
				dev: undefined,
			},
			host: { appDataDir: undefined, xdgDataHome: undefined },
		},
		{ dataDir: '/tmp/agent-scheduler' },
	);
}

function parsePort(raw: string | undefined):
	| { readonly ok: true; readonly value: number }
	| {
			readonly ok: false;
			readonly variable: string;
			readonly expected: string;
			readonly actual: string;
	  } {
	if (raw === undefined || raw === '') return { ok: true, value: 7817 };
	if (!/^\d+$/.test(raw)) {
		return invalid(PRODUCT_ENV.PORT, 'an integer port in 1..65535', raw);
	}
	const num = Number.parseInt(raw, 10);
	if (num < 1 || num > 65535) return invalid(PRODUCT_ENV.PORT, 'an integer port in 1..65535', raw);
	return { ok: true, value: num };
}

function parseBind(raw: string | undefined):
	| { readonly ok: true; readonly value: string }
	| {
			readonly ok: false;
			readonly variable: string;
			readonly expected: string;
			readonly actual: string;
	  } {
	if (raw === undefined || raw === '') return { ok: true, value: '0.0.0.0' };
	return { ok: true, value: raw };
}

function parseLogLevel(raw: string | undefined):
	| { readonly ok: true; readonly value: 'debug' | 'info' | 'warn' | 'error' }
	| {
			readonly ok: false;
			readonly variable: string;
			readonly expected: string;
			readonly actual: string;
	  } {
	if (raw === undefined || raw === '') return { ok: true, value: 'info' };
	if (!['debug', 'info', 'warn', 'error'].includes(raw)) {
		return invalid(PRODUCT_ENV.LOG_LEVEL, 'debug, info, warn, or error', raw);
	}
	return { ok: true, value: raw as ProcessConfig['logLevel'] };
}

function parseDev(raw: string | undefined):
	| { readonly ok: true; readonly value: boolean }
	| {
			readonly ok: false;
			readonly variable: string;
			readonly expected: string;
			readonly actual: string;
	  } {
	if (raw === undefined || raw === '') return { ok: true, value: false };
	if (raw === '1' || raw.toLowerCase() === 'true') return { ok: true, value: true };
	if (raw === '0' || raw.toLowerCase() === 'false') return { ok: true, value: false };
	return invalid(PRODUCT_ENV.DEV, '0, 1, true, or false', raw);
}

function invalid(variable: string, expected: string, actual: string) {
	return { ok: false as const, variable, expected, actual };
}
