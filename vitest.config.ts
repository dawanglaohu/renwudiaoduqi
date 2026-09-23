import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: ['packages/*/test/**/*.test.ts'],
		environment: 'node',
		testTimeout: 30000,
		hookTimeout: 30000,
		teardownTimeout: 30000,
	},
});
