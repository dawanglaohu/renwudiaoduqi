import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: ['e2e/smoke.test.ts'],
		environment: 'node',
		testTimeout: 90000,
		hookTimeout: 90000,
		teardownTimeout: 30000,
	},
});
