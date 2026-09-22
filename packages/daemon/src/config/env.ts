import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { posix, win32 } from 'node:path';
import { isRecord } from '@agent-scheduler/shared/lib/is-record';
import type { SupportedPlatform } from '../platform/contract.ts';
import { hasUnexpandedPathToken } from '../platform/contract.ts';

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
		readonly appData: string | undefined;
		readonly xdgDataHome: string | undefined;
		readonly programData: string | undefined;
		readonly systemRoot: string | undefined;
	};
}

export interface ConfigFileReader {
	readonly read: (path: string) => string;
}

export interface DaemonConfigFile {
	readonly port?: number;
	readonly bind?: string;
	readonly dataDir?: string;
	readonly logLevel?: string;
	readonly dev?: boolean;
}

const CONFIG_FILE_KEYS = ['port', 'bind', 'dataDir', 'logLevel', 'dev'] as const;

const NATIVE_CONFIG_FILE_READER: ConfigFileReader = Object.freeze({
	read: (path: string) => readFileSync(path, 'utf8'),
});

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
			appData: process.env.APPDATA,
			xdgDataHome: process.env.XDG_DATA_HOME,
			programData: process.env.PROGRAMDATA,
			systemRoot: process.env.SystemRoot,
		}),
	});
}

export function loadProcessConfig(input: {
	readonly environment: EnvironmentSnapshot;
	readonly platform: SupportedPlatform;
	readonly defaultDataDir: string;
	readonly configFilePath: string;
	readonly fileReader?: ConfigFileReader;
}): ProcessConfigResult {
	const fileResult = readDaemonConfigFile(
		input.configFilePath,
		input.fileReader ?? NATIVE_CONFIG_FILE_READER,
	);
	if (!fileResult.ok) return fileResult;
	return parseDaemonConfig(input.environment, {
		platform: input.platform,
		dataDir: input.defaultDataDir,
		file: fileResult.config,
	});
}

export function parseDaemonConfig(
	environment: EnvironmentSnapshot,
	defaults: {
		readonly platform: SupportedPlatform;
		readonly dataDir: string;
		readonly file?: DaemonConfigFile;
	},
): ProcessConfigResult {
	const file = defaults.file ?? {};
	const port = parsePort(environment.product.port, file.port);
	if (!port.ok) return port;
	const bind = parseBind(environment.product.bind, file.bind);
	if (!bind.ok) return bind;
	const dataDir = parseDataDir(
		environment.product.dataDir,
		file.dataDir,
		defaults.dataDir,
		defaults.platform,
	);
	if (!dataDir.ok) return dataDir;
	const logLevel = parseLogLevel(environment.product.logLevel, file.logLevel);
	if (!logLevel.ok) return logLevel;
	const dev = parseDev(environment.product.dev, file.dev);
	if (!dev.ok) return dev;
	return {
		ok: true,
		config: Object.freeze({
			port: port.value,
			bind: bind.value,
			dataDir: dataDir.value,
			logLevel: logLevel.value,
			dev: dev.value,
		}),
	};
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
			host: {
				appData: undefined,
				xdgDataHome: undefined,
				programData: undefined,
				systemRoot: undefined,
			},
		},
		{ platform: 'linux', dataDir: '/tmp/agent-scheduler' },
	);
}

function readDaemonConfigFile(
	path: string,
	fileReader: ConfigFileReader,
):
	| { readonly ok: true; readonly config: DaemonConfigFile }
	| Exclude<ProcessConfigResult, { ok: true }> {
	let raw: string;
	try {
		raw = fileReader.read(path);
	} catch (cause) {
		if (getErrorCode(cause) === 'ENOENT') return { ok: true, config: {} };
		return invalid('daemon.json', `a readable JSON object at ${path}`, describeCause(cause));
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return invalid('daemon.json', `valid JSON at ${path}`, 'invalid JSON');
	}
	if (!isRecord(parsed)) {
		return invalid('daemon.json', `a JSON object at ${path}`, describeValue(parsed));
	}
	const unknownKeys = Object.keys(parsed).filter(
		(key) => !CONFIG_FILE_KEYS.includes(key as (typeof CONFIG_FILE_KEYS)[number]),
	);
	if (unknownKeys.length > 0) {
		return invalid(
			'daemon.json',
			`only keys ${CONFIG_FILE_KEYS.join(', ')}`,
			unknownKeys.join(', '),
		);
	}
	return validateConfigFileShape(parsed, path);
}

function validateConfigFileShape(
	parsed: Record<string, unknown>,
	path: string,
):
	| { readonly ok: true; readonly config: DaemonConfigFile }
	| Exclude<ProcessConfigResult, { ok: true }> {
	if (parsed.port !== undefined && typeof parsed.port !== 'number') {
		return invalid(
			'daemon.json.port',
			`an integer in 1..65535 at ${path}`,
			describeValue(parsed.port),
		);
	}
	for (const key of ['bind', 'dataDir', 'logLevel'] as const) {
		if (parsed[key] !== undefined && typeof parsed[key] !== 'string') {
			return invalid(`daemon.json.${key}`, `a string at ${path}`, describeValue(parsed[key]));
		}
	}
	if (parsed.dev !== undefined && typeof parsed.dev !== 'boolean') {
		return invalid('daemon.json.dev', `a boolean at ${path}`, describeValue(parsed.dev));
	}
	return { ok: true, config: parsed as DaemonConfigFile };
}

function parsePort(
	environmentValue: string | undefined,
	fileValue: number | undefined,
):
	| { readonly ok: true; readonly value: number }
	| Exclude<ProcessConfigResult, { readonly ok: true }> {
	const source = nonEmpty(environmentValue);
	const raw = source ?? fileValue ?? 7817;
	const variable = source === undefined ? 'daemon.json.port' : PRODUCT_ENV.PORT;
	if (
		(typeof raw === 'string' && !/^\d+$/.test(raw)) ||
		(typeof raw === 'number' && !Number.isInteger(raw))
	) {
		return invalid(variable, 'an integer port in 1..65535', String(raw));
	}
	const value = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
	if (value < 1 || value > 65535) {
		return invalid(variable, 'an integer port in 1..65535', String(raw));
	}
	return { ok: true, value };
}

function parseBind(
	environmentValue: string | undefined,
	fileValue: string | undefined,
):
	| { readonly ok: true; readonly value: string }
	| Exclude<ProcessConfigResult, { readonly ok: true }> {
	const source = nonEmpty(environmentValue);
	const value = source ?? fileValue ?? '0.0.0.0';
	const variable = source === undefined ? 'daemon.json.bind' : PRODUCT_ENV.BIND;
	if (!isValidBind(value)) {
		return invalid(variable, 'an IP address, localhost, or hostname without whitespace', value);
	}
	return { ok: true, value };
}

function parseDataDir(
	environmentValue: string | undefined,
	fileValue: string | undefined,
	defaultValue: string,
	platform: SupportedPlatform,
):
	| { readonly ok: true; readonly value: string }
	| Exclude<ProcessConfigResult, { readonly ok: true }> {
	const source = nonEmpty(environmentValue);
	const value = source ?? fileValue ?? defaultValue;
	const variable = source === undefined ? 'daemon.json.dataDir' : PRODUCT_ENV.DATA_DIR;
	const isAbsolute = platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
	if (!isAbsolute || hasUnexpandedPathToken(value)) {
		return invalid(variable, `an absolute ${platform} path without shell expansion tokens`, value);
	}
	return {
		ok: true,
		value: platform === 'win32' ? win32.normalize(value) : posix.normalize(value),
	};
}

function parseLogLevel(
	environmentValue: string | undefined,
	fileValue: string | undefined,
):
	| { readonly ok: true; readonly value: ProcessConfig['logLevel'] }
	| Exclude<ProcessConfigResult, { readonly ok: true }> {
	const source = nonEmpty(environmentValue);
	const value = source ?? fileValue ?? 'info';
	const variable = source === undefined ? 'daemon.json.logLevel' : PRODUCT_ENV.LOG_LEVEL;
	if (!['debug', 'info', 'warn', 'error'].includes(value)) {
		return invalid(variable, 'debug, info, warn, or error', value);
	}
	return { ok: true, value: value as ProcessConfig['logLevel'] };
}

function parseDev(
	environmentValue: string | undefined,
	fileValue: boolean | undefined,
):
	| { readonly ok: true; readonly value: boolean }
	| Exclude<ProcessConfigResult, { readonly ok: true }> {
	const source = nonEmpty(environmentValue);
	if (source === undefined) return { ok: true, value: fileValue ?? false };
	if (source === '1' || source.toLowerCase() === 'true') return { ok: true, value: true };
	if (source === '0' || source.toLowerCase() === 'false') return { ok: true, value: false };
	return invalid(PRODUCT_ENV.DEV, '0, 1, true, or false', source);
}

function isValidBind(value: string): boolean {
	if (value.length === 0 || value !== value.trim() || /[\s/\\\0]/.test(value)) return false;
	if (value === 'localhost' || value === '*') return true;
	if (isIP(value) !== 0) return true;
	return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value);
}

function invalid(variable: string, expected: string, actual: string) {
	return { ok: false as const, variable, expected, actual };
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

function getErrorCode(cause: unknown): string | undefined {
	if (!isRecord(cause) || typeof cause.code !== 'string') return undefined;
	return cause.code;
}

function describeCause(cause: unknown): string {
	return cause instanceof Error ? cause.name : describeValue(cause);
}

function describeValue(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
