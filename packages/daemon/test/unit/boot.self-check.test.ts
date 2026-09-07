import { describe, expect, it } from 'vitest';
import { checkNodeVersion } from '../../src/boot/node-check.ts';

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
});
