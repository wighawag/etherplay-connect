import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { viteCommonjs } from '@originjs/vite-plugin-commonjs';

export default defineConfig({
	plugins: [sveltekit(), viteCommonjs()],
	build: {
		minify: false,
		sourcemap: 'inline'
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}']
	}
});
