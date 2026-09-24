import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: false,
		include: ['e2e/pairing-entry.test.ts'],
		environment: 'node',
		testTimeout: 90000,
		hookTimeout: 90000,
	},
});
