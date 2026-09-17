import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from 'tailwindcss';
import { defineConfig } from 'vite';

function getAppVersion(): string {
	try {
		const pkgPath = resolve(__dirname, 'package.json');
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		return pkg.version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

function getBuildId(): string {
	try {
		return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
	} catch {
		return 'dev';
	}
}

export default defineConfig({
	base: './',
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	build: {
		outDir: 'dist',
		target: 'es2020',
		sourcemap: 'hidden',
		minify: 'esbuild',
		assetsInlineLimit: 4096,
		rollupOptions: {
			output: {
				manualChunks(id: string) {
					if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
						return 'vendor-react';
					}
					if (
						id.includes('node_modules/@radix-ui') ||
						id.includes('node_modules/clsx') ||
						id.includes('node_modules/class-variance-authority') ||
						id.includes('node_modules/tailwind-merge') ||
						id.includes('node_modules/lucide-react') ||
						id.includes('node_modules/@tanstack/react-virtual')
					) {
						return 'vendor-ui';
					}
				},
			},
		},
	},
	define: {
		'import.meta.env.VITE_APP_VERSION': JSON.stringify(getAppVersion()),
		'import.meta.env.VITE_BUILD_ID': JSON.stringify(getBuildId()),
	},
});
