import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: [
			'e2e/smoke.test.ts',
			'e2e/batch-13-smoke.test.ts',
			'e2e/batch-14-composition.test.ts',
		],
		environment: 'node',
		fileParallelism: false,
		maxConcurrency: 1,
		testTimeout: 90000,
		hookTimeout: 150000,
		teardownTimeout: 30000,
	},
});
