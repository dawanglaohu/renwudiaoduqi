import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	findFontStacks,
	findRootFontSizeLocks,
	findSpacingGrowth,
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

describe('M9-T29 density guards', () => {
	it('requires a base for arbitrary breakpoint spacing and honors narrower axes regardless of class order', () => {
		expect(findSpacingGrowth('md:p-[calc(var(--sp-3)*2)]')).toEqual(['md:p-[calc(var(--sp-3)*2)]']);
		expect(findSpacingGrowth('px-2 p-4 sm:px-3')).toEqual(['sm:px-3']);
		expect(findSpacingGrowth('p-4 px-2 sm:px-3')).toEqual(['sm:px-3']);
		expect(findSpacingGrowth('pt-2 py-4 p-6 md:pt-3')).toEqual(['md:pt-3']);
	});
	it('checks joined class lists and keeps each conditional template alternative', () => {
		const dir = scratchWebDir({
			'src/pages/joined.tsx':
				"export const view = <><div className={['max-w-4xl', 'mx-auto'].join(' ')} /><div className={`p-3 ${true ? 'md:p-2' : 'md:p-4'}`} /><div className={cn('p-4', 'sm:p-3')} /></>;",
		});
		expect(ruleHits(dir)).toEqual([
			'CENTERED_WORK_SURFACE@joined.tsx',
			'RESPONSIVE_SPACING_GROWTH@joined.tsx',
		]);
	});
	it.each([
		'p-4 sm:p-6',
		'gap-2 md:gap-3',
		'lg:m-2',
		'space-y-1 xl:space-y-2',
		'p-3 sm:px-4',
		'px-2 min-[1100px]:pl-[12px]',
		'py-2 md:pt-3',
		'p-[1rem] sm:p-[18px]',
		'hover:sm:gap-4',
		'p-[var(--sp-3)] md:p-4',
	])('rejects spacing growth: %s', (classes) => {
		expect(findSpacingGrowth(classes, new Map([['--sp-3', '12px']]))).not.toEqual([]);
	});
	it.each([
		'p-4 sm:p-3',
		'gap-3 md:gap-3',
		'p-4 sm:px-3',
		'p-3.5 max-[767px]:p-3',
		'py-4 md:pt-3',
		'p-4 sm:p-0',
		'-m-2 md:-m-4',
		'm-auto sm:mx-auto',
		'p-3 hover:p-4',
		'p-[var(--custom)] md:p-4',
	])('allows equal or smaller breakpoint spacing: %s', (classes) => {
		expect(findSpacingGrowth(classes)).toEqual([]);
	});
	it.each(['pages', 'features', 'components', 'app'])(
		'scans %s, including multiline templates, and ignores comments',
		(layer) => {
			const dir = scratchWebDir({
				[`src/${layer}/example.tsx`]:
					'// "p-1 sm:p-8"\nexport const view = <div className={`p-2\n md:p-4 ${true ? "flex" : "grid"}`} />;',
			});
			const hits = ruleHits(dir);
			expect(hits.filter((hit) => hit.startsWith('RESPONSIVE_SPACING_GROWTH'))).toEqual([
				'RESPONSIVE_SPACING_GROWTH@example.tsx',
			]);
		},
	);
	it('compares each string separately instead of borrowing a base from another element', () => {
		const dir = scratchWebDir({
			'src/pages/page.tsx': '<><div className="p-8"/><div className="md:p-4"/></>',
		});
		expect(ruleHits(dir)).toContain('RESPONSIVE_SPACING_GROWTH@page.tsx');
	});
	it.each(['2xl', '3xl', '4xl', '5xl', '6xl', '7xl'])(
		'rejects centered max-w-%s outside a single-card page',
		(width) => {
			const dir = scratchWebDir({
				'src/pages/task-list-page.tsx': `export const classes = "mx-auto max-w-${width}";`,
			});
			expect(ruleHits(dir)).toContain('CENTERED_WORK_SURFACE@task-list-page.tsx');
		},
	);
	it('allows the two single-card paths and left-aligned or uncapped work surfaces', () => {
		const dir = scratchWebDir({
			'src/features/pairing/pairing-container.tsx':
				'export const classes = "max-w-2xl mx-auto p-3";',
			'src/app/connect-failed.tsx': 'export const classes = "mx-auto max-w-3xl p-3";',
			'src/pages/settings.tsx': 'export const a = "max-w-4xl"; export const b = "mx-auto w-full";',
			'src/lib/example.ts': 'export const classes = "p-1 sm:p-8 mx-auto max-w-4xl";',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
	it('does not whitelist a legacy component or a matching basename in another directory', () => {
		const dir = scratchWebDir({
			'src/components/batch-summary-bar.tsx': 'export const classes = "max-w-4xl mx-auto";',
			'src/pages/connect-failed.tsx': 'export const classes = "max-w-4xl mx-auto";',
		});
		expect(ruleHits(dir)).toEqual([
			'CENTERED_WORK_SURFACE@batch-summary-bar.tsx',
			'CENTERED_WORK_SURFACE@connect-failed.tsx',
		]);
	});
});

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
			'src/hooks/use-polling.ts':
				'export function usePolling() {\n\tsetInterval(() => {}, 5000);\n}\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('CLIENT_POLLING_PROHIBITED@use-polling.ts');
	});

	it('flags use-minute-tick importing src/api', () => {
		const dir = scratchWebDir({
			'src/hooks/use-minute-tick.ts':
				"import { getAgents } from '../api/agents';\nexport function useMinuteTick() {}\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('CLIENT_POLLING_PROHIBITED@use-minute-tick.ts');
	});

	it('allows use-minute-tick using local setInterval without api imports', () => {
		const dir = scratchWebDir({
			'src/hooks/use-minute-tick.ts':
				'export function useMinuteTick() {\n\tsetInterval(() => {}, 60000);\n}\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: agent ID special-casing prohibited (Check 17 / E-338, E-339, E-350)', () => {
	it('flags agentId comparison with claude/pi/dsh', () => {
		const dir = scratchWebDir({
			'src/components/agent-picker.tsx':
				"export function isClaude(agentId: string) { return agentId === 'claude'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('AGENT_ID_SPECIAL_CASE@agent-picker.tsx');
	});

	it('allows checking capability fields instead of agent IDs', () => {
		const dir = scratchWebDir({
			'src/components/agent-picker.tsx':
				'export function hasEffort(agent: any) { return agent.layers?.effortVendorMap !== null; }\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: login state literals in UI layer prohibited (Check 18 / AC 1)', () => {
	it('flags logged_in/logged_out string literals in UI components', () => {
		const dir = scratchWebDir({
			'src/components/login-status.tsx':
				"export function isReady(login: any) { return login.state === 'logged_in'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('LOGIN_STATE_LITERAL@login-status.tsx');
	});

	it('allows predicates from login-freshness in UI layer and literals inside login-freshness.ts', () => {
		const dir = scratchWebDir({
			'src/lib/login-freshness.ts':
				"export function isLoggedIn(login: any) { return login?.state === 'logged_in'; }\n",
			'src/components/login-status.tsx':
				"import { isLoggedIn } from '../lib/login-freshness';\nexport function isReady(login: any) { return isLoggedIn(login); }\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: login state inside disabled expression prohibited (Check 19 / E-336, E-355)', () => {
	it('flags login.state and login predicates in disabled expressions', () => {
		const dir = scratchWebDir({
			'src/components/assign-panel.tsx':
				'export function Panel({ login }: any) {\n\treturn <button disabled={isLoggedIn(login)}>OK</button>;\n}\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('LOGIN_STATE_IN_DISABLED@assign-panel.tsx');
	});

	it('allows disabled expressions based on pending state or missing catalog', () => {
		const dir = scratchWebDir({
			'src/components/assign-panel.tsx':
				'export function Panel({ isPending, catalog }: any) {\n\treturn <button disabled={isPending || catalog === null}>OK</button>;\n}\n',
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: model source literal comparison in UI layer prohibited (Check 20 / AC 2, E-350)', () => {
	it('flags source literal comparison in UI components', () => {
		const dir = scratchWebDir({
			'src/components/model-item.tsx':
				"export function isLive(model: any) { return model.source === 'live'; }\n",
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('MODEL_SOURCE_LITERAL@model-item.tsx');
	});

	it('allows grouping via model-groups.ts and shared MODEL_SOURCES', () => {
		const dir = scratchWebDir({
			'src/lib/model-groups.ts':
				"export function isLive(model: any) { return model.source === 'live'; }\n",
			'src/components/model-item.tsx':
				"import { MODEL_SOURCES } from '@agent-scheduler/shared';\nexport const list = MODEL_SOURCES;\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('check-forbidden: frontend model deduplication prohibited (Check 21 / AC 2, E-350)', () => {
	it('flags new Set / dedupe / uniq in model-picker and model-groups', () => {
		const dir = scratchWebDir({
			'src/components/model-picker.tsx':
				'export function unique(models: any[]) { return new Set(models.map(m => m.id)); }\n',
		});
		const hits = ruleHits(dir);
		expect(hits).toContain('FRONTEND_MODEL_DEDUPLICATION@model-picker.tsx');
	});

	it('allows direct rendering of models as received from daemon', () => {
		const dir = scratchWebDir({
			'src/components/model-picker.tsx':
				'export function renderList(models: any[]) { return models.map(m => m.id); }\n',
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
			'src/components/picker.tsx':
				"import { GroupedSelect } from '../ui/grouped-select';\nexport const P = GroupedSelect;\n",
		});
		expect(ruleHits(dir)).toEqual([]);
	});
});

describe('R5: M9-T23 one-way presentation architecture', () => {
	it('display components import no stores, APIs, features or shells', () => {
		for (const file of [
			'assign-panel',
			'agent-card',
			'gate-card',
			'model-picker',
			'effort-picker',
			'pipeline-assignment',
			'login-badge',
			'login-hint',
		]) {
			const source = readFileSync(join(webDir, 'src/components', `${file}.tsx`), 'utf8');
			expect(source).not.toMatch(/from\s+['"]\.\.\/(?:store|api|features|shell)\//);
		}
	});
	it('gate uses the DTO and model picker has no hidden SSR substitutes or invented history', () => {
		const gate = readFileSync(join(webDir, 'src/components/gate-card.tsx'), 'utf8');
		const picker = readFileSync(join(webDir, 'src/components/model-picker.tsx'), 'utf8');
		expect(gate).not.toMatch(/as\s+any/);
		expect(gate).not.toContain('loginStatus');
		expect(picker).not.toContain("source: 'history'");
		expect(picker).not.toMatch(/display:\s*'none'/);
	});
	it('task approval delegates confirmation presentation without container colors or a global modal', () => {
		const view = readFileSync(join(webDir, 'src/features/run-deck/run-deck-view.tsx'), 'utf8');
		const taskApproval = view.slice(
			view.indexOf('export function TaskApprovalCard'),
			view.indexOf('function laneBodySlot'),
		);
		expect(taskApproval).toContain('<GateRejectConfirmation');
		expect(taskApproval).not.toMatch(/className=|<dialog|showModal/);
		const gate = readFileSync(join(webDir, 'src/components/gate-card.tsx'), 'utf8');
		expect(gate).not.toMatch(/<dialog|createPortal\s*\(|showModal\s*\(/);
	});
});
