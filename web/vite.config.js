import {resolve} from 'path';
import {sri} from 'vite-plugin-sri3';
import {defineConfig} from 'vite';
import {nodePolyfills} from 'vite-plugin-node-polyfills'; // required by oauth login (google) due to error: `Buffer is not defined`
import {svelte} from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

// Middleware to add trailing slash to /login
// needed for some reason when testing in vscode browser
function trailingSlashPlugin() {
	return {
		name: 'trailing-slash',
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				// Redirect /login to /login/
				if (req.url === '/login') {
					res.writeHead(301, {Location: '/login/'});
					res.end();
					return;
				}
				next();
			});
		},
	};
}

export default defineConfig({
	plugins: [svelte(), tailwindcss(), trailingSlashPlugin(), nodePolyfills(), sri()],
	resolve: {
		alias: {
			$lib: resolve(__dirname, './src/lib'),
		},
	},
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
});
