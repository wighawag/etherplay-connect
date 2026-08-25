import {defineConfig} from 'vitest/config';

export default defineConfig({
	test: {
		// A real browser is driven from node, so the test process itself stays in node.
		environment: 'node',
		globals: true,
		include: ['test/**/*.test.ts'],
		// Building the fixture app and launching Chromium is slower than a unit test.
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
