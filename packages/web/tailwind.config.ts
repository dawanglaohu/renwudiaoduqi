import type { Config } from 'tailwindcss';

const config: Config = {
	// `relative: true` resolves the globs against this file rather than process.cwd(): Vite runs
	// from packages/web, but postcss.config.cjs is also loaded from the workspace root by the
	// style-pipeline test, and a cwd-relative scan from there would find no source and emit no
	// utilities (M9-T24).
	content: {
		files: ['./index.html', './src/**/*.{ts,tsx,css}'],
		relative: true,
	},
	darkMode: ['class', '[data-theme="dark"]'],
	theme: {
		extend: {
			spacing: {
				1: 'var(--sp-1)',
				2: 'var(--sp-2)',
				3: 'var(--sp-3)',
				4: 'var(--sp-4)',
				5: 'var(--sp-5)',
				6: 'var(--sp-6)',
				8: 'var(--sp-8)',
				rail: 'var(--rail-w)',
				'rail-collapsed': 'var(--rail-w-collapsed)',
				topbar: 'var(--topbar-h)',
				'stream-head': 'var(--stream-head-h)',
				'stream-foot': 'var(--stream-foot-h)',
				row: 'var(--row-h)',
				'row-touch': 'var(--row-h-touch)',
				btn: 'var(--h-btn)',
				'btn-sm': 'var(--h-btn-sm)',
				'btn-lg': 'var(--h-btn-lg)',
				input: 'var(--h-input)',
				'input-touch': 'var(--h-input-touch)',
				badge: 'var(--badge-h)',
				thumbbar: 'var(--thumbbar-h)',
				runstrip: 'var(--runstrip-h)',
			},
			borderRadius: {
				DEFAULT: 'var(--r)',
				sm: 'var(--r-sm)',
				lg: 'var(--r-lg)',
				pill: 'var(--r-pill)',
			},
			colors: {
				page: 'var(--page)',
				bg: 'var(--bg)',
				'panel-2': 'var(--panel-2)',
				border: 'var(--border)',
				'border-strong': 'var(--border-strong)',
				'ink-1': 'var(--ink-1)',
				'ink-2': 'var(--ink-2)',
				'ink-3': 'var(--ink-3)',
				needs: 'var(--needs)',
				'needs-ink': 'var(--needs-ink)',
				'needs-soft': 'var(--needs-soft)',
				'on-needs': 'var(--on-needs)',
				auto: 'var(--auto)',
				'auto-ink': 'var(--auto-ink)',
				'auto-soft': 'var(--auto-soft)',
				'on-auto': 'var(--on-auto)',
				down: 'var(--down)',
				'down-ink': 'var(--down-ink)',
				'down-soft': 'var(--down-soft)',
				'on-down': 'var(--on-down)',
				warn: 'var(--warn)',
				'warn-soft': 'var(--warn-soft)',
				stopped: 'var(--stopped)',
				'spine-done': 'var(--spine-done)',
				'spine-pending': 'var(--spine-pending)',
				'spine-live': 'var(--spine-live)',
				'spine-needs': 'var(--spine-needs)',
				'spine-dead': 'var(--spine-dead)',
				'row-hover': 'var(--row-hover)',
			},
			// Preflight paints every element's default border-color from `borderColor.DEFAULT`, so a
			// bare `border` utility must land on the token and not on the framework's grey (M9-T24).
			borderColor: {
				DEFAULT: 'var(--border)',
			},
			boxShadow: {
				DEFAULT: 'var(--shadow)',
				lg: 'var(--shadow-lg)',
				glow: 'var(--glow)',
			},
			fontFamily: {
				ui: 'var(--font-ui)',
				mono: 'var(--font-mono)',
			},
			fontSize: {
				micro: ['var(--fs-micro)', { lineHeight: 'var(--lh-ui)' }],
				meta: ['var(--fs-meta)', { lineHeight: 'var(--lh-ui)' }],
				log: ['var(--fs-log)', { lineHeight: 'var(--lh-log)' }],
				dense: ['var(--fs-dense)', { lineHeight: 'var(--lh-ui)' }],
				body: ['var(--fs-body)', { lineHeight: 'var(--lh-ui)' }],
				lead: ['var(--fs-lead)', { lineHeight: 'var(--lh-ui)' }],
				num: ['var(--fs-num)', { letterSpacing: 'var(--tracking-num)' }],
				'num-lg': ['var(--fs-num-lg)', { letterSpacing: 'var(--tracking-num)' }],
			},
			transitionDuration: {
				fast: 'var(--dur-fast)',
				DEFAULT: 'var(--dur)',
			},
			transitionTimingFunction: {
				DEFAULT: 'var(--ease)',
			},
		},
	},
	plugins: [],
};

export default config;
