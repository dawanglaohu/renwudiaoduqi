/**
 * PostCSS pipeline for the web bundle (M9-T24).
 *
 * Two plugins only: Tailwind turns the `@tailwind` layers in src/styles/base.css into utility
 * rules, autoprefixer adds vendor prefixes for the Android WebView / WebKit targets. Every colour,
 * radius and typeface is declared in src/styles/tokens.css and reaches Tailwind through
 * tailwind.config.ts as `var(--*)` aliases, so this file names no hex value and no font family
 * (E-159, enforced by scripts/check-forbidden.ts).
 *
 * The Tailwind config is addressed by absolute path: Vite (vite.config.ts `css.postcss`) and the
 * style-pipeline test load this file from different working directories, and Tailwind would
 * otherwise look for tailwind.config.* in process.cwd().
 */
const path = require('node:path');

module.exports = {
	plugins: [
		require('tailwindcss')({ config: path.join(__dirname, 'tailwind.config.ts') }),
		require('autoprefixer')(),
	],
};
