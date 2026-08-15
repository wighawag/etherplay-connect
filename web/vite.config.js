import {resolve} from 'path';
import {sri} from 'vite-plugin-sri3';
import {defineConfig} from 'vite';
import {nodePolyfills} from 'vite-plugin-node-polyfills'; // required by oauth login (google) due to error: `Buffer is not defined`
import {svelte} from '@sveltejs/vite-plugin-svelte';

/**
 * WHICH OF THE TWO BUILDS THIS IS, stated in a file rather than left to be inferred.
 *
 * One source produces two artefacts that differ in one flag: the production host bakes its
 * configuration, the development host accepts a runtime document and is unfit for real accounts.
 * They look alike on disk, land in adjacent directories, and the wrong one shipped under the other
 * one's name is a silent failure in the dangerous direction, so whatever packages or deploys one
 * needs to be able to ASK which it has.
 *
 * A file and not a string grepped out of a bundle: the answer must not depend on the wording of a
 * `console.log`, which is a thing people edit.
 */
function buildInfo(mode) {
	return {
		name: 'etherplay-build-info',
		apply: 'build',
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: 'build-info.json',
				source: `${JSON.stringify({mode, developmentBuild: mode === 'development'}, null, 2)}\n`,
			});
		},
	};
}

export default defineConfig(({mode}) => ({
	plugins: [svelte(), nodePolyfills(), sri(), buildInfo(mode)],
	build: {
		emptyOutDir: true,
		minify: false,
		sourcemap: true,
		rollupOptions: {
			input: {
				index: resolve(__dirname, 'index.html'),
				login: resolve(__dirname, 'login/index.html'),
			},
		},
	},
}));
