import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: ['packages/*/test/**/*.test.ts'],
		environment: 'node',
	},
});
