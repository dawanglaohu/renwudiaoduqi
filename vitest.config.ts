import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: [
			'packages/*/test/**/*.test.ts',
			'packages/*/test/**/*.test.tsx',
			'packages/*/src/lib/**/*.test.ts',
		],
		environment: 'node',
	},
});
