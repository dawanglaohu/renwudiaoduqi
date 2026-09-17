import { describe, expect, it } from 'vitest';
import { collectHostResults } from '../launchers/evaluate-release-gate.ts';
import { assertReleaseVerification } from '../src/platform-support.ts';

const STEP_NAMES = {
	check: 'Workspace Verification Check (pnpm -w check, AC 1, E-265)',
	platform: 'Platform Integration Tests (AC 1, E-265)',
	smoke: 'Staged Unpack, Launch Spec & Real Daemon Smoke (AC 2, E-209, E-257, E-265)',
	build: 'Build Tauri Desktop Shell (AC 1, E-265)',
} as const;

function job(
	name: string,
	conclusion: string,
	overrides: Partial<Record<keyof typeof STEP_NAMES, string>> = {},
) {
	return {
		name,
		conclusion,
		steps: (Object.keys(STEP_NAMES) as (keyof typeof STEP_NAMES)[]).map((key) => ({
			name: STEP_NAMES[key],
			conclusion: overrides[key] ?? 'success',
		})),
	};
}

const noSigning = { isSigned: false, isNotarized: false };

describe('M10-T5: release gate reads real job conclusions (AC 1, AC 6, E-265, E-267)', () => {
	it('maps the three platform jobs and their four steps from the Actions payload', () => {
		const results = collectHostResults(
			[
				job('Desktop CI / Windows (x64)', 'success'),
				job('Desktop CI / macOS (Apple Silicon)', 'success'),
				job('Desktop CI / Linux (Ubuntu LTS x64)', 'success'),
				{ name: 'Release Gate Evaluation', conclusion: null, steps: [] },
			],
			noSigning,
		);

		expect(results.map((r) => r.platform)).toEqual(['win32', 'darwin', 'linux']);
		for (const result of results) {
			expect(result.workspaceCheckPassed).toBe(true);
			expect(result.platformTestsPassed).toBe(true);
			expect(result.smokePassed).toBe(true);
			expect(result.shellBuildPassed).toBe(true);
			expect(result.failureReason).toBeUndefined();
		}
		expect(() => assertReleaseVerification(results)).not.toThrow();
	});

	it('names the failing platform and step instead of only failing the aggregate (E-265)', () => {
		const results = collectHostResults(
			[
				job('Desktop CI / Windows (x64)', 'success'),
				job('Desktop CI / macOS (Apple Silicon)', 'success'),
				job('Desktop CI / Linux (Ubuntu LTS x64)', 'failure', { smoke: 'failure' }),
			],
			noSigning,
		);

		const linux = results.find((r) => r.platform === 'linux');
		expect(linux?.smokePassed).toBe(false);
		expect(linux?.shellBuildPassed).toBe(true);
		expect(linux?.failureReason).toContain('Staged Unpack');
		expect(() => assertReleaseVerification(results)).toThrow(
			/linux \(daemon-smoke: .*Staged Unpack/,
		);
	});

	it('treats a skipped or cancelled step as not passed', () => {
		const results = collectHostResults(
			[
				job('Desktop CI / Windows (x64)', 'cancelled', { build: 'skipped', smoke: 'cancelled' }),
				job('Desktop CI / macOS (Apple Silicon)', 'success'),
				job('Desktop CI / Linux (Ubuntu LTS x64)', 'success'),
			],
			noSigning,
		);

		const windows = results.find((r) => r.platform === 'win32');
		expect(windows?.shellBuildPassed).toBe(false);
		expect(windows?.smokePassed).toBe(false);
		expect(() => assertReleaseVerification(results)).toThrow(/win32 \(daemon-smoke, shell-build/);
	});

	it('reports a platform whose job never ran as missing (E-265)', () => {
		const results = collectHostResults(
			[
				job('Desktop CI / Windows (x64)', 'success'),
				job('Desktop CI / Linux (Ubuntu LTS x64)', 'success'),
			],
			noSigning,
		);
		expect(results.map((r) => r.platform)).toEqual(['win32', 'linux']);
		expect(() => assertReleaseVerification(results)).toThrow(/Missing platform hosts: darwin/);
	});

	it('applies the signing gate verdict to macOS only (E-267)', () => {
		const jobs = [
			job('Desktop CI / Windows (x64)', 'success'),
			job('Desktop CI / macOS (Apple Silicon)', 'success'),
			job('Desktop CI / Linux (Ubuntu LTS x64)', 'success'),
		];
		const unsigned = collectHostResults(jobs, noSigning);
		expect(() => assertReleaseVerification(unsigned, { isFormalRelease: true })).toThrow(
			/Formal release blocked \(E-267\)/,
		);
		expect(unsigned.find((r) => r.platform === 'win32')?.isSigned).toBeUndefined();

		const signed = collectHostResults(jobs, { isSigned: true, isNotarized: true });
		expect(() => assertReleaseVerification(signed, { isFormalRelease: true })).not.toThrow();
	});
});
