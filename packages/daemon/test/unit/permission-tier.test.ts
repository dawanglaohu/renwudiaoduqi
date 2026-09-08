import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_PERMISSION_TIER,
	PERMISSION_TIERS,
	REVIEW_PERMISSION_TIER,
	assertPermissionTier,
	enforceRunPermissionTier,
	getPermissionArgs,
	getPermissionTierSecurityMeta,
	hasElevatedPermission,
	isHighestPermissionTier,
	isPermissionSupported,
	isPermissionTier,
	preservePermissionTierOnModeChange,
	resolvePermissionMapping,
} from '../../src/domain/permission-tier.ts';
import { AppError } from '../../src/errors/app-error.ts';

describe('M4-T7 permission tier domain logic', () => {
	describe('three-tier abstraction and validation (E-137, R1, R4)', () => {
		it('recognizes valid abstract product tiers', () => {
			expect(isPermissionTier('readOnly')).toBe(true);
			expect(isPermissionTier('workspaceWrite')).toBe(true);
			expect(isPermissionTier('unrestricted')).toBe(true);
		});

		it('rejects raw vendor flags and unknown values with AppError E_VALIDATION (E-137, R4)', () => {
			expect(isPermissionTier('--sandbox')).toBe(false);
			expect(isPermissionTier('read-only')).toBe(false);
			expect(isPermissionTier('workspace-write')).toBe(false);
			expect(isPermissionTier('danger-full-access')).toBe(false);
			expect(isPermissionTier('--permission-mode')).toBe(false);
			expect(isPermissionTier('plan')).toBe(false);
			expect(isPermissionTier('acceptEdits')).toBe(false);
			expect(isPermissionTier('bypassPermissions')).toBe(false);
			expect(isPermissionTier(null)).toBe(false);
			expect(isPermissionTier(undefined)).toBe(false);
			expect(isPermissionTier(123)).toBe(false);

			expect(() => assertPermissionTier('acceptEdits')).toThrow(AppError);
			try {
				assertPermissionTier('acceptEdits');
			} catch (error) {
				expect(error).toBeInstanceOf(AppError);
				expect((error as AppError).code).toBe('E_VALIDATION');
			}
			expect(() => assertPermissionTier('readOnly')).not.toThrow();
		});

		it('defaults to the middle tier workspaceWrite', () => {
			expect(DEFAULT_PERMISSION_TIER).toBe(PERMISSION_TIERS.WORKSPACE_WRITE);
			expect(DEFAULT_PERMISSION_TIER).toBe('workspaceWrite');
		});
	});

	describe('vendor parameter mapping (E-137, R2)', () => {
		it('maps codex permissions to --sandbox modes', () => {
			expect(resolvePermissionMapping('codex', 'readOnly')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'readOnly',
				flag: '--sandbox',
				vendorValue: 'read-only',
				args: ['--sandbox', 'read-only'],
			});

			expect(resolvePermissionMapping('codex', 'workspaceWrite')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'workspaceWrite',
				flag: '--sandbox',
				vendorValue: 'workspace-write',
				args: ['--sandbox', 'workspace-write'],
			});

			expect(resolvePermissionMapping('codex', 'unrestricted')).toEqual({
				supported: true,
				agentId: 'codex',
				tier: 'unrestricted',
				flag: '--sandbox',
				vendorValue: 'danger-full-access',
				args: ['--sandbox', 'danger-full-access'],
			});

			expect(getPermissionArgs('codex', 'workspaceWrite')).toEqual([
				'--sandbox',
				'workspace-write',
			]);
		});

		it('maps claude permissions to --permission-mode modes', () => {
			expect(resolvePermissionMapping('claude', 'readOnly')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'readOnly',
				flag: '--permission-mode',
				vendorValue: 'plan',
				args: ['--permission-mode', 'plan'],
			});

			expect(resolvePermissionMapping('claude', 'workspaceWrite')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'workspaceWrite',
				flag: '--permission-mode',
				vendorValue: 'acceptEdits',
				args: ['--permission-mode', 'acceptEdits'],
			});

			expect(resolvePermissionMapping('claude', 'unrestricted')).toEqual({
				supported: true,
				agentId: 'claude',
				tier: 'unrestricted',
				flag: '--permission-mode',
				vendorValue: 'bypassPermissions',
				args: ['--permission-mode', 'bypassPermissions'],
			});
		});

		it('maps grok permissions to --permission-mode modes', () => {
			expect(resolvePermissionMapping('grok', 'readOnly')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'readOnly',
				flag: '--permission-mode',
				vendorValue: 'plan',
				args: ['--permission-mode', 'plan'],
			});

			expect(resolvePermissionMapping('grok', 'workspaceWrite')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'workspaceWrite',
				flag: '--permission-mode',
				vendorValue: 'acceptEdits',
				args: ['--permission-mode', 'acceptEdits'],
			});

			expect(resolvePermissionMapping('grok', 'unrestricted')).toEqual({
				supported: true,
				agentId: 'grok',
				tier: 'unrestricted',
				flag: '--permission-mode',
				vendorValue: 'bypassPermissions',
				args: ['--permission-mode', 'bypassPermissions'],
			});
		});

		it('distinguishes Pi workspaceWrite from unrestricted to prevent out-of-bounds writes (R2)', () => {
			const readOnly = resolvePermissionMapping('pi', 'readOnly');
			expect(readOnly).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'readOnly',
				flag: '--tools',
				vendorValue: 'read,grep,find,ls',
				args: ['--tools', 'read,grep,find,ls'],
			});

			const workspaceWrite = resolvePermissionMapping('pi', 'workspaceWrite');
			expect(workspaceWrite).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'workspaceWrite',
				flag: '--tools',
				vendorValue: 'read,grep,find,ls,edit,write',
				args: ['--tools', 'read,grep,find,ls,edit,write'],
			});

			const unrestricted = resolvePermissionMapping('pi', 'unrestricted');
			expect(unrestricted).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'unrestricted',
				flag: '--tools',
				vendorValue: 'read,grep,find,ls,edit,write,bash,powershell',
				args: ['--tools', 'read,grep,find,ls,edit,write,bash,powershell', '--approve'],
			});

			// Verify middle and high tiers are NOT identical and workspaceWrite does not expose bash/powershell
			expect(workspaceWrite.supported).toBe(true);
			expect(unrestricted.supported).toBe(true);
			if (workspaceWrite.supported && unrestricted.supported) {
				expect(workspaceWrite.args).not.toEqual(unrestricted.args);
				expect(workspaceWrite.args[1]).not.toContain('bash');
				expect(workspaceWrite.args[1]).not.toContain('powershell');
				expect(unrestricted.args[1]).toContain('bash');
			}
		});

		it('rejects generic-acp CLI flags as unsupported because ACP negotiates in-protocol (R2)', () => {
			expect(isPermissionSupported('generic-acp')).toBe(false);
			const acpMapping = resolvePermissionMapping('generic-acp', 'readOnly');
			expect(acpMapping.supported).toBe(false);
			if (!acpMapping.supported) {
				expect(acpMapping.reason).toContain('Generic ACP');
			}
			expect(() => getPermissionArgs('generic-acp', 'readOnly')).toThrow(AppError);
		});

		it('rejects DeepSeek Harness and throws E_CAPABILITY_UNSUPPORTED instead of launching empty (R2)', () => {
			expect(isPermissionSupported('dsh')).toBe(false);
			const dshMapping = resolvePermissionMapping('dsh', 'readOnly');
			expect(dshMapping.supported).toBe(false);
			if (!dshMapping.supported) {
				expect(dshMapping.reason).toContain('DeepSeek Harness');
			}

			// Must throw AppError('E_CAPABILITY_UNSUPPORTED') instead of returning [] and silently launching (R2)
			expect(() => getPermissionArgs('dsh', 'readOnly')).toThrow(AppError);
			try {
				getPermissionArgs('dsh', 'readOnly');
			} catch (error) {
				expect(error).toBeInstanceOf(AppError);
				expect((error as AppError).code).toBe('E_CAPABILITY_UNSUPPORTED');
			}
		});

		it('safely handles prototype property names without crashing (R3)', () => {
			expect(isPermissionSupported('constructor')).toBe(false);
			expect(isPermissionSupported('__proto__')).toBe(false);
			expect(isPermissionSupported('toString')).toBe(false);
			expect(isPermissionSupported('valueOf')).toBe(false);

			const ctorMapping = resolvePermissionMapping('constructor', 'workspaceWrite');
			expect(ctorMapping.supported).toBe(false);
			expect(() => getPermissionArgs('constructor', 'workspaceWrite')).toThrow(AppError);
		});
	});

	describe('highest tier security marking and mode preservation (E-136, R4)', () => {
		it('flags unrestricted tier as highest and elevated', () => {
			expect(isHighestPermissionTier(PERMISSION_TIERS.UNRESTRICTED)).toBe(true);
			expect(hasElevatedPermission(PERMISSION_TIERS.UNRESTRICTED)).toBe(true);

			expect(isHighestPermissionTier(PERMISSION_TIERS.WORKSPACE_WRITE)).toBe(false);
			expect(isHighestPermissionTier(PERMISSION_TIERS.READ_ONLY)).toBe(false);
			expect(hasElevatedPermission(PERMISSION_TIERS.WORKSPACE_WRITE)).toBe(false);
		});

		it('produces persistent marker and warning alert severity without UI CSS tokens (E-136, R4)', () => {
			const unrestrictedMeta = getPermissionTierSecurityMeta('unrestricted');
			expect(unrestrictedMeta.isElevated).toBe(true);
			expect(unrestrictedMeta.requiresPersistentMarker).toBe(true);
			expect(unrestrictedMeta.alertSeverity).toBe('warning');
			expect('styleClass' in unrestrictedMeta).toBe(false);

			const workspaceMeta = getPermissionTierSecurityMeta('workspaceWrite');
			expect(workspaceMeta.isElevated).toBe(false);
			expect(workspaceMeta.requiresPersistentMarker).toBe(false);
			expect(workspaceMeta.alertSeverity).toBe('none');

			const readOnlyMeta = getPermissionTierSecurityMeta('readOnly');
			expect(readOnlyMeta.isElevated).toBe(false);
			expect(readOnlyMeta.requiresPersistentMarker).toBe(false);
			expect(readOnlyMeta.alertSeverity).toBe('none');
		});

		it('does not implicitly change permission tier when switching auto mode (E-136)', () => {
			expect(preservePermissionTierOnModeChange('unrestricted', true)).toBe('unrestricted');
			expect(preservePermissionTierOnModeChange('unrestricted', false)).toBe('unrestricted');
			expect(preservePermissionTierOnModeChange('workspaceWrite', true)).toBe('workspaceWrite');
			expect(preservePermissionTierOnModeChange('readOnly', true)).toBe('readOnly');
		});
	});

	describe('review agent permission enforcement (E-135)', () => {
		it('strictly locks review runs to readOnly tier regardless of requested override', () => {
			expect(REVIEW_PERMISSION_TIER).toBe('readOnly');

			expect(enforceRunPermissionTier('review', 'unrestricted')).toBe('readOnly');
			expect(enforceRunPermissionTier('review', 'workspaceWrite')).toBe('readOnly');
			expect(enforceRunPermissionTier('review', null)).toBe('readOnly');
			expect(enforceRunPermissionTier('review', undefined)).toBe('readOnly');
		});

		it('allows implement runs to specify permission tier or default to workspaceWrite', () => {
			expect(enforceRunPermissionTier('implement', 'unrestricted')).toBe('unrestricted');
			expect(enforceRunPermissionTier('implement', 'workspaceWrite')).toBe('workspaceWrite');
			expect(enforceRunPermissionTier('implement', 'readOnly')).toBe('readOnly');
			expect(enforceRunPermissionTier('implement', null)).toBe('workspaceWrite');
			expect(enforceRunPermissionTier('implement', undefined)).toBe('workspaceWrite');
		});
	});

	describe('M4-T7 architecture and consumer semantic compliance (R4)', () => {
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const permissionTierPath = join(currentDir, '../../src/domain/permission-tier.ts');
		const effortTierPath = join(currentDir, '../../src/domain/effort-tier.ts');

		it('ensures domain modules do not import from the config layer (no domain->config backward dependency)', () => {
			const permissionCode = readFileSync(permissionTierPath, 'utf8');
			const effortCode = readFileSync(effortTierPath, 'utf8');

			expect(/from ['"]\.\.\/config/g.test(permissionCode)).toBe(false);
			expect(/from ['"]\.\.\/config/g.test(effortCode)).toBe(false);
		});

		it('ensures domain modules do not throw bare Error or bare TypeError', () => {
			const permissionCode = readFileSync(permissionTierPath, 'utf8');
			const effortCode = readFileSync(effortTierPath, 'utf8');

			expect(/throw new (?:Type)?Error\(/g.test(permissionCode)).toBe(false);
			expect(/throw new (?:Type)?Error\(/g.test(effortCode)).toBe(false);
		});

		it('ensures domain modules do not embed frontend CSS tokens', () => {
			const permissionCode = readFileSync(permissionTierPath, 'utf8');
			const effortCode = readFileSync(effortTierPath, 'utf8');

			expect(permissionCode.includes('--down')).toBe(false);
			expect(permissionCode.includes('--default')).toBe(false);
			expect(effortCode.includes('--down')).toBe(false);
		});

		it('verifies consumer launch lifecycle semantics for permission enforcement and security tagging', () => {
			// Review flow: always gets readOnly args for codex, regardless of request
			const reviewTier = enforceRunPermissionTier('review', 'unrestricted');
			expect(reviewTier).toBe('readOnly');
			const reviewArgs = getPermissionArgs('codex', reviewTier);
			expect(reviewArgs).toEqual(['--sandbox', 'read-only']);
			const reviewMeta = getPermissionTierSecurityMeta(reviewTier);
			expect(reviewMeta.requiresPersistentMarker).toBe(false);
			expect(reviewMeta.alertSeverity).toBe('none');

			// Implementation flow with elevation: gets unrestricted args and persistent warning marker
			const implTier = enforceRunPermissionTier('implement', 'unrestricted');
			expect(implTier).toBe('unrestricted');
			const implArgs = getPermissionArgs('codex', implTier);
			expect(implArgs).toEqual(['--sandbox', 'danger-full-access']);
			const implMeta = getPermissionTierSecurityMeta(implTier);
			expect(implMeta.isElevated).toBe(true);
			expect(implMeta.requiresPersistentMarker).toBe(true);
			expect(implMeta.alertSeverity).toBe('warning');

			// Unsupported agent execution must be blocked with AppError
			expect(() => getPermissionArgs('dsh', 'readOnly')).toThrow(AppError);
		});
	});
});
