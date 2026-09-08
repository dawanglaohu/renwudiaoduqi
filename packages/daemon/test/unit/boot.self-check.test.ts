import { describe, expect, it } from 'vitest';
import { checkNodeVersion } from '../../src/boot/node-check.ts';
import {
	type EnvironmentSnapshot,
	loadProcessConfig,
	parseProcessConfig,
} from '../../src/config/env.ts';

describe('boot self-check', () => {
	it('E-139 rejects Node 20 with the required version', () => {
		expect(checkNodeVersion('v20.19.5')).toEqual({
			ok: false,
			currentVersion: 'v20.19.5',
			requiredMajor: 22,
			message:
				'agent-scheduler daemon requires Node.js >= 22.0.0, current version is v20.19.5. Upgrade Node.js and start again.',
		});
	});

	it('E-139 accepts Node 22', () => {
		expect(checkNodeVersion('v22.17.0')).toEqual({ ok: true });
	});

	it('validates AGSCHED_PORT and reports the product variable name', () => {
		expect(parseProcessConfig({ port: 'abc' })).toEqual({
			ok: false,
			variable: 'AGSCHED_PORT',
			expected: 'an integer port in 1..65535',
			actual: 'abc',
		});
	});

	it('loads daemon.json once, applies environment precedence, and freezes five process settings', () => {
		let reads = 0;
		const result = loadProcessConfig({
			environment: environment({ port: '9001', dev: '0' }),
			platform: 'linux',
			defaultDataDir: '/home/user/.local/share/agent-scheduler',
			configFilePath: '/home/user/.local/share/agent-scheduler/daemon.json',
			fileReader: {
				read: () => {
					reads += 1;
					return JSON.stringify({
						port: 8000,
						bind: '127.0.0.1',
						dataDir: '/srv/agent scheduler',
						logLevel: 'warn',
						dev: true,
					});
				},
			},
		});

		expect(reads).toBe(1);
		expect(result).toEqual({
			ok: true,
			config: {
				port: 9001,
				bind: '127.0.0.1',
				dataDir: '/srv/agent scheduler',
				logLevel: 'warn',
				dev: false,
			},
		});
		if (result.ok) expect(Object.isFrozen(result.config)).toBe(true);
	});

	it('rejects malformed daemon.json and relative data directories without DEV bypasses', () => {
		const malformed = loadProcessConfig({
			environment: environment(),
			platform: 'linux',
			defaultDataDir: '/home/user/.local/share/agent-scheduler',
			configFilePath: '/config/daemon.json',
			fileReader: { read: () => '{' },
		});
		expect(malformed).toMatchObject({ ok: false, variable: 'daemon.json' });

		const relative = loadProcessConfig({
			environment: environment({ dataDir: 'relative/path', dev: '1' }),
			platform: 'linux',
			defaultDataDir: '/home/user/.local/share/agent-scheduler',
			configFilePath: '/config/daemon.json',
			fileReader: { read: () => '{}' },
		});
		expect(relative).toMatchObject({ ok: false, variable: 'AGSCHED_DATA_DIR' });
	});
});

function environment(product: Partial<EnvironmentSnapshot['product']> = {}): EnvironmentSnapshot {
	return Object.freeze({
		product: Object.freeze({
			port: product.port,
			bind: product.bind,
			dataDir: product.dataDir,
			logLevel: product.logLevel,
			dev: product.dev,
		}),
		host: Object.freeze({
			appData: undefined,
			xdgDataHome: undefined,
			programData: undefined,
			systemRoot: undefined,
		}),
	});
}
