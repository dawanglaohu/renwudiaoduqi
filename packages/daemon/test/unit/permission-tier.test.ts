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

describe('M4-T7 permission tier domain logic', () => {
	describe('three-tier abstraction and validation (E-137)', () => {
		it('recognizes valid abstract product tiers', () => {
			expect(isPermissionTier('readOnly')).toBe(true);
			expect(isPermissionTier('workspaceWrite')).toBe(true);
			expect(isPermissionTier('unrestricted')).toBe(true);
		});

		it('rejects raw vendor flags and unknown values (E-137)', () => {
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

			expect(() => assertPermissionTier('acceptEdits')).toThrow(TypeError);
			expect(() => assertPermissionTier('readOnly')).not.toThrow();
		});

		it('defaults to the middle tier workspaceWrite', () => {
			expect(DEFAULT_PERMISSION_TIER).toBe(PERMISSION_TIERS.WORKSPACE_WRITE);
			expect(DEFAULT_PERMISSION_TIER).toBe('workspaceWrite');
		});
	});

	describe('vendor parameter mapping (E-137)', () => {
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

		it('maps pi permissions to tool allowlists', () => {
			expect(resolvePermissionMapping('pi', 'readOnly')).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'readOnly',
				flag: '--tools',
				vendorValue: 'read,grep,find,ls',
				args: ['--tools', 'read,grep,find,ls'],
			});

			expect(resolvePermissionMapping('pi', 'workspaceWrite')).toEqual({
				supported: true,
				agentId: 'pi',
				tier: 'workspaceWrite',
				flag: '--tools',
				vendorValue: 'read,grep,find,ls,edit,write,bash,powershell',
				args: ['--tools', 'read,grep,find,ls,edit,write,bash,powershell'],
			});
		});

		it('maps generic-acp permissions to standard ACP permission modes', () => {
			expect(resolvePermissionMapping('generic-acp', 'readOnly')).toEqual({
				supported: true,
				agentId: 'generic-acp',
				tier: 'readOnly',
				flag: '--permission-mode',
				vendorValue: 'plan',
				args: ['--permission-mode', 'plan'],
			});
		});

		it('returns unsupported status for DeepSeek Harness and unknown agents without defaulting', () => {
			expect(isPermissionSupported('dsh')).toBe(false);
			const dshMapping = resolvePermissionMapping('dsh', 'workspaceWrite');
			expect(dshMapping.supported).toBe(false);
			if (!dshMapping.supported) {
				expect(dshMapping.reason).toContain('DeepSeek Harness');
			}
			expect(getPermissionArgs('dsh', 'workspaceWrite')).toEqual([]);

			expect(isPermissionSupported('unknown-agent')).toBe(false);
			const unknownMapping = resolvePermissionMapping('unknown-agent', 'readOnly');
			expect(unknownMapping.supported).toBe(false);
			expect(getPermissionArgs('unknown-agent', 'readOnly')).toEqual([]);
		});
	});

	describe('highest tier security marking and mode preservation (E-136)', () => {
		it('flags unrestricted tier as highest and elevated', () => {
			expect(isHighestPermissionTier(PERMISSION_TIERS.UNRESTRICTED)).toBe(true);
			expect(hasElevatedPermission(PERMISSION_TIERS.UNRESTRICTED)).toBe(true);

			expect(isHighestPermissionTier(PERMISSION_TIERS.WORKSPACE_WRITE)).toBe(false);
			expect(isHighestPermissionTier(PERMISSION_TIERS.READ_ONLY)).toBe(false);
			expect(hasElevatedPermission(PERMISSION_TIERS.WORKSPACE_WRITE)).toBe(false);
		});

		it('produces persistent marker and styling requirements for highest tier (E-136)', () => {
			const unrestrictedMeta = getPermissionTierSecurityMeta('unrestricted');
			expect(unrestrictedMeta.isElevated).toBe(true);
			expect(unrestrictedMeta.requiresPersistentMarker).toBe(true);
			expect(unrestrictedMeta.styleClass).toBe('--down');

			const workspaceMeta = getPermissionTierSecurityMeta('workspaceWrite');
			expect(workspaceMeta.isElevated).toBe(false);
			expect(workspaceMeta.requiresPersistentMarker).toBe(false);
			expect(workspaceMeta.styleClass).toBe('--default');

			const readOnlyMeta = getPermissionTierSecurityMeta('readOnly');
			expect(readOnlyMeta.isElevated).toBe(false);
			expect(readOnlyMeta.requiresPersistentMarker).toBe(false);
			expect(readOnlyMeta.styleClass).toBe('--default');
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
});
