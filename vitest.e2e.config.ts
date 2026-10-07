import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include:
			process.env.R17_REAL_PROVIDER === '1'
				? ['e2e/batch-17-real-provider.test.ts']
				: [
						'e2e/smoke.test.ts',
						'e2e/batch-13-smoke.test.ts',
						'e2e/batch-14-composition.test.ts',
						'e2e/pipeline-settings.test.ts',
					],
		environment: 'node',
		fileParallelism: false,
		maxConcurrency: 1,
		testTimeout: 180000,
		hookTimeout: 150000,
		teardownTimeout: 30000,
	},
});
