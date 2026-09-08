import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PERMISSION_TIER,
	PERMISSION_TIERS,
	REVIEW_PERMISSION_TIER,
	enforceRunPermissionTier,
	getPermissionTierSecurityMeta,
	hasElevatedPermission,
	isHighestPermissionTier,
	isPermissionSupported,
	isPermissionTier,
	preservePermissionTierOnModeChange,
	resolvePermissionMapping,
} from '../../src/domain/permission-tier.ts';

describe('permission tier domain', () => {
	it('accepts only the three product-level values and defaults to the middle tier', () => {
		expect(Object.values(PERMISSION_TIERS)).toEqual(['readOnly', 'workspaceWrite', 'unrestricted']);
		expect(DEFAULT_PERMISSION_TIER).toBe('workspaceWrite');
		for (const value of ['--sandbox', 'read-only', 'acceptEdits', 'bypassPermissions', null]) {
			expect(isPermissionTier(value)).toBe(false);
		}
	});

	it('keeps an elevated stored choice across automation-mode changes and exposes a persistent marker', () => {
		for (const isAutoMode of [false, true]) {
			expect(preservePermissionTierOnModeChange('unrestricted', isAutoMode)).toBe('unrestricted');
		}
		expect(isHighestPermissionTier('unrestricted')).toBe(true);
		expect(hasElevatedPermission('unrestricted')).toBe(true);
		expect(getPermissionTierSecurityMeta('unrestricted')).toEqual({
			tier: 'unrestricted',
			isElevated: true,
			requiresPersistentMarker: true,
		});
		expect(getPermissionTierSecurityMeta('workspaceWrite').requiresPersistentMarker).toBe(false);
	});

	it('forces review dispatch to read-only before resolving vendor transport', () => {
		expect(REVIEW_PERMISSION_TIER).toBe('readOnly');
		for (const requested of ['workspaceWrite', 'unrestricted', null] as const) {
			expect(enforceRunPermissionTier('review', requested)).toBe('readOnly');
		}
		expect(resolvePermissionMapping('codex', 'readOnly')).toEqual({
			supported: true,
			agentId: 'codex',
			tier: 'readOnly',
			transport: {
				kind: 'argv',
				flag: '--sandbox',
				value: 'read-only',
				args: ['--sandbox', 'read-only'],
			},
		});
		expect(resolvePermissionMapping('dsh', 'readOnly')).toEqual({
			supported: true,
			agentId: 'dsh',
			tier: 'readOnly',
			transport: { kind: 'env', variables: { DSH_PERMISSION_MODE: 'read-only' } },
		});
	});

	it('maps each verified vendor channel without inventing a generic ACP CLI flag', () => {
		expect(resolvePermissionMapping('claude', 'workspaceWrite')).toMatchObject({
			supported: true,
			transport: { kind: 'argv', args: ['--permission-mode', 'acceptEdits'] },
		});
		expect(resolvePermissionMapping('grok', 'unrestricted')).toMatchObject({
			supported: true,
			transport: { kind: 'argv', args: ['--permission-mode', 'bypassPermissions'] },
		});
		expect(resolvePermissionMapping('generic-acp', 'readOnly')).toMatchObject({
			supported: false,
		});
	});

	it('does not claim Pi can enforce workspace confinement with an absolute-path write tool', () => {
		expect(isPermissionSupported('pi', 'readOnly')).toBe(true);
		expect(isPermissionSupported('pi', 'workspaceWrite')).toBe(false);
		expect(resolvePermissionMapping('pi', 'workspaceWrite')).toMatchObject({
			supported: false,
			tier: 'workspaceWrite',
		});
		expect(resolvePermissionMapping('pi', 'unrestricted')).toMatchObject({
			supported: true,
			transport: {
				kind: 'argv',
				args: ['--tools', 'read,grep,find,ls,edit,write,bash,powershell'],
			},
		});
	});

	it('treats unknown and prototype property names as unsupported', () => {
		for (const agentId of ['unknown-agent', 'constructor', '__proto__', 'toString']) {
			expect(isPermissionSupported(agentId)).toBe(false);
			expect(resolvePermissionMapping(agentId, 'readOnly').supported).toBe(false);
		}
	});

	it('has no dependency on outer daemon layers or frontend presentation tokens', () => {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(currentDir, '../../src/domain/permission-tier.ts'), 'utf8');
		expect(source).not.toMatch(/^import /mu);
		expect(source).not.toContain('--down');
		expect(source).not.toContain('--default');
	});
});
