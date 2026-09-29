import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	findFontStacks,
	findRootFontSizeLocks,
	isDeckContainer,
	runForbiddenCheck,
} from '../scripts/check-forbidden.js';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchDirs: string[] = [];

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratchWebDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'agsched-forbidden-'));
	scratchDirs.push(dir);
	for (const [name, content] of Object.entries(files)) {
		const filePath = join(dir, name);
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, content);
	}
	return dir;
}

function ruleHits(dir: string): string[] {
	return runForbiddenCheck(dir, dir).violations.map((v) => `${v.rule}@${basename(v.file)}`);
}

describe('check-forbidden (M9-T1, E-170, E-15)', () => {
	it('passes every architecture check on the clean workspace', () => {
		const report = runForbiddenCheck();
		expect(report.passed).toBe(true);
		expect(report.violations).toEqual([]);
	});

	it('flags a root font-size lock even when the declaration sits on its own line (E-15)', () => {
		expect(findRootFontSizeLocks('html {\n\tfont-size: 14px;\n}\n')).toEqual([1]);
		expect(findRootFontSizeLocks(':root { font-size: 16px; }')).toEqual([1]);
		expect(findRootFontSizeLocks('.html-snippet { font-size: 14px; }')).toEqual([]);
		expect(findRootFontSizeLocks('html { font-size: 100%; }')).toEqual([]);
	});

	it('treats the run-deck lanes as the container that must never scroll sideways (E-145)', () => {
		expect(isDeckContainer('packages/web/src/features/run-deck/run-deck-container.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/stream-column.tsx')).toBe(true);
		expect(isDeckContainer('packages/web/src/components/virtual-rows.tsx')).toBe(false);
	});
});

describe('check-forbidden: build configs alias tokens only (M9-T24, E-159)', () => {
	it('findFontStacks reports generic families and non-alias fontFamily entries by line', () => {
		expect(
			findFontStacks(
				[
					"import type { Config } from 'tailwindcss';",
					'const config: Config = {',
					'\ttheme: { extend: { fontFamily: {',
					"\t\tui: 'var(--font-ui)',",
					"\t\tmono: 'var(--font-mono)',",
					'\t} } },',
					'};',
				].join('\n'),
			),
		).toEqual([]);
		expect(
			findFontStacks(
				[
					'const config = { theme: { fontFamily: {',
					"\tui: ['Inter', 'sans-serif'],",
					"\tmono: 'var(--font-mono)',",
					'\tdisplay: \'"Commit Mono"\',',
					'} } };',
				].join('\n'),
			),
		).toEqual([2, 4]);
		expect(findFontStacks("module.exports = { family: 'ui-monospace, Menlo' };")).toEqual([1]);
		// Comments are not stacks, and a token alias written in a comment stays silent
		expect(
			findFontStacks('// falls back to system-ui when the woff2 is missing\nconst a = 1;'),
		).toEqual([]);
		expect(findFontStacks('/* monospace */ const fontFamily = { ui: "var(--font-ui)" };')).toEqual(
			[],
		);
	});

	it('fails when tailwind.config.ts carries a hex colour or a font stack', () => {
		const dir = scratchWebDir({
			'tailwind.config.ts': [
				'const config = {',
				"\ttheme: { colors: { page: '#123456' }, fontFamily: { ui: ['Inter', 'sans-serif'] } },",
				'};',
				'export default config;',
			].join('\n'),
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('COLOR_LITERAL_OUTSIDE_TOKENS_CSS@tailwind.config.ts');
		expect(hits).toContain('FONT_STACK_IN_BUILD_CONFIG@tailwind.config.ts');
	});

	it('fails when postcss.config.cjs carries a hex colour or a font stack', () => {
		const dir = scratchWebDir({
			'postcss.config.cjs': [
				'module.exports = {',
				"\tplugins: [require('tailwindcss')(), require('autoprefixer')()],",
				"\tbrand: { accent: 'rgba(1, 2, 3, 0.5)', family: '\"Public Sans\", system-ui' },",
				'};',
			].join('\n'),
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('COLOR_LITERAL_OUTSIDE_TOKENS_CSS@postcss.config.cjs');
		expect(hits).toContain('FONT_STACK_IN_BUILD_CONFIG@postcss.config.cjs');
	});

	it('accepts build configs that only alias var(--*) tokens', () => {
		const dir = scratchWebDir({
			'tailwind.config.ts': [
				'const config = {',
				"\ttheme: { extend: { colors: { page: 'var(--page)' }, fontFamily: { ui: 'var(--font-ui)' } } },",
				'};',
				'export default config;',
			].join('\n'),
			'postcss.config.cjs':
				"module.exports = { plugins: [require('tailwindcss')(), require('autoprefixer')()] };\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});

	it('the real tailwind.config.ts and postcss.config.cjs declare no font stack', () => {
		for (const name of ['tailwind.config.ts', 'postcss.config.cjs']) {
			expect(findFontStacks(readFileSync(join(webDir, name), 'utf8')), name).toEqual([]);
		}
	});
});

describe('check-forbidden: toggles must not import each other (M9-T22 / AC 1)', () => {
	it('flags gate-toggles importing pipeline-toggles', () => {
		const dir = scratchWebDir({
			'gate-toggles.tsx': "import { PipelineToggles } from './pipeline-toggles.tsx';\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('TOGGLES_MUTUAL_IMPORT@gate-toggles.tsx');
	});

	it('flags pipeline-toggles importing gate-toggles', () => {
		const dir = scratchWebDir({
			'pipeline-toggles.tsx': "import { GateToggles } from './gate-toggles.tsx';\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('TOGGLES_MUTUAL_IMPORT@pipeline-toggles.tsx');
	});

	it('allows both toggles to import ui/segmented-toggle', () => {
		const dir = scratchWebDir({
			'gate-toggles.tsx': "import { SegmentedToggle } from '../ui/segmented-toggle.tsx';\n",
			'pipeline-toggles.tsx': "import { SegmentedToggle } from '../ui/segmented-toggle.tsx';\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: client polling prohibited (Check 16 / AC 5, E-335, 07 节)', () => {
	it('flags setInterval in general code files', () => {
		const dir = scratchWebDir({
			'src/hooks/use-polling.ts': 'export function usePolling() {\n\tsetInterval(() => {}, 5000);\n}\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('CLIENT_POLLING_PROHIBITED@use-polling.ts');
	});

	it('flags use-minute-tick importing src/api', () => {
		const dir = scratchWebDir({
			'src/hooks/use-minute-tick.ts': "import { getAgents } from '../api/agents';\nexport function useMinuteTick() {}\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('CLIENT_POLLING_PROHIBITED@use-minute-tick.ts');
	});

	it('allows use-minute-tick using local setInterval without api imports', () => {
		const dir = scratchWebDir({
			'src/hooks/use-minute-tick.ts': 'export function useMinuteTick() {\n\tsetInterval(() => {}, 60000);\n}\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: agent ID special-casing prohibited (Check 17 / E-338, E-339, E-350)', () => {
	it('flags agentId comparison with claude/pi/dsh', () => {
		const dir = scratchWebDir({
			'src/components/agent-picker.tsx': "export function isClaude(agentId: string) { return agentId === 'claude'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('AGENT_ID_SPECIAL_CASE@agent-picker.tsx');
	});

	it('allows checking capability fields instead of agent IDs', () => {
		const dir = scratchWebDir({
			'src/components/agent-picker.tsx': 'export function hasEffort(agent: any) { return agent.layers?.effortVendorMap !== null; }\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: login state literals in UI layer prohibited (Check 18 / AC 1)', () => {
	it('flags logged_in/logged_out string literals in UI components', () => {
		const dir = scratchWebDir({
			'src/components/login-status.tsx': "export function isReady(login: any) { return login.state === 'logged_in'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('LOGIN_STATE_LITERAL@login-status.tsx');
	});

	it('allows predicates from login-freshness in UI layer and literals inside login-freshness.ts', () => {
		const dir = scratchWebDir({
			'src/lib/login-freshness.ts': "export function isLoggedIn(login: any) { return login?.state === 'logged_in'; }\n",
			'src/components/login-status.tsx': "import { isLoggedIn } from '../lib/login-freshness';\nexport function isReady(login: any) { return isLoggedIn(login); }\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: login state inside disabled expression prohibited (Check 19 / E-336, E-355)', () => {
	it('flags login.state and login predicates in disabled expressions', () => {
		const dir = scratchWebDir({
			'src/components/assign-panel.tsx': 'export function Panel({ login }: any) {\n\treturn <button disabled={isLoggedIn(login)}>OK</button>;\n}\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('LOGIN_STATE_IN_DISABLED@assign-panel.tsx');
	});

	it('allows disabled expressions based on pending state or missing catalog', () => {
		const dir = scratchWebDir({
			'src/components/assign-panel.tsx': 'export function Panel({ isPending, catalog }: any) {\n\treturn <button disabled={isPending || catalog === null}>OK</button>;\n}\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: model source literal comparison in UI layer prohibited (Check 20 / AC 2, E-350)', () => {
	it('flags source literal comparison in UI components', () => {
		const dir = scratchWebDir({
			'src/components/model-item.tsx': "export function isLive(model: any) { return model.source === 'live'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('MODEL_SOURCE_LITERAL@model-item.tsx');
	});

	it('allows grouping via model-groups.ts and shared MODEL_SOURCES', () => {
		const dir = scratchWebDir({
			'src/lib/model-groups.ts': "export function isLive(model: any) { return model.source === 'live'; }\n",
			'src/components/model-item.tsx': "import { MODEL_SOURCES } from '@agent-scheduler/shared';\nexport const list = MODEL_SOURCES;\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: frontend model deduplication prohibited (Check 21 / AC 2, E-350)', () => {
	it('flags new Set / dedupe / uniq in model-picker and model-groups', () => {
		const dir = scratchWebDir({
			'src/components/model-picker.tsx': 'export function unique(models: any[]) { return new Set(models.map(m => m.id)); }\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('FRONTEND_MODEL_DEDUPLICATION@model-picker.tsx');
	});

	it('allows direct rendering of models as received from daemon', () => {
		const dir = scratchWebDir({
			'src/components/model-picker.tsx': 'export function renderList(models: any[]) { return models.map(m => m.id); }\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: cmdk or ui/shadcn/command prohibited in web (Check 22 / AC 2)', () => {
	it('flags importing cmdk or shadcn/command', () => {
		const dir = scratchWebDir({
			'src/components/picker.tsx': "import { Command } from 'cmdk';\nexport const P = Command;\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('CMDK_OR_COMMAND_PROHIBITED@picker.tsx');
	});

	it('allows importing ui/grouped-select', () => {
		const dir = scratchWebDir({
			'src/components/picker.tsx': "import { GroupedSelect } from '../ui/grouped-select';\nexport const P = GroupedSelect;\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

