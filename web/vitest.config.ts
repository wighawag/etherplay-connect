import {defineConfig} from 'vitest/config';

/**
 * The host has tests because two of its files decide things quietly.
 *
 * `mergeDocument` decides whether an allowlist entry is applied, and an allowlist entry mints
 * credentials with nobody in the loop. Nothing about that is visible when it goes wrong: a refused
 * field looks exactly like a field nobody set.
 *
 * `mode: 'test'` is deliberately NOT `development`, so these run against the same
 * `DEVELOPMENT_BUILD === false` shape a production build has, and a test that wants the other one
 * says so.
 */
export default defineConfig({
	test: {
		environment: 'happy-dom',
		globals: true,
		include: ['test/**/*.test.ts'],
	},
});
