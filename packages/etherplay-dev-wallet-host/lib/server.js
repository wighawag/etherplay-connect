/**
 * The static server the bin puts on a port.
 *
 * Zero dependencies on purpose: this is the thing an adopter starts in their dev script and in CI,
 * next to their faucet, and every dependency it has is one more thing that can stop their CI for a
 * reason that has nothing to do with them.
 *
 * It is a static file server with three opinions:
 *
 * 1. NEVER falls back to index.html for a missing path. The host asks for `/config.json` and treats
 *    an HTML answer as "no document", so a server that helpfully returns the app for every path
 *    turns a typo in a filename into a configuration that silently did nothing.
 * 2. Answers with `cache-control: no-store`. The whole point of the runtime document is that you
 *    edit it and reload; a cached bundle or a cached document makes that a lie.
 * 3. Reads the configuration document on every request rather than at startup, so editing it and
 *    reloading the popup is the whole loop.
 *
 * Separate from the bin so the tests exercise the server without spawning a process, and so the bin
 * has no "am I the entry point" question to get wrong.
 */
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../site');
export const DEFAULT_PORT = 50000;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
};

/** Inside the served root, and provably so: `..` in a URL must not reach the rest of the disk. */
function resolveWithin(root, pathname) {
	const target = resolve(join(root, pathname));
	if (target !== root && !target.startsWith(root + sep)) {
		return undefined;
	}
	return target;
}

export function createHost(options) {
	const root = resolve(options.dir || DEFAULT_DIR);
	return createServer(async (request, response) => {
		try {
			await handle(request, response, root, options);
		} catch (err) {
			// AN UNCAUGHT THROW IN AN ASYNC HANDLER IS AN UNHANDLED REJECTION, and on Node 18+ that
			// ends the process. This one is somebody's dev script and somebody's CI, where a server
			// that vanishes mid-run reads as a flaky test rather than as a bug here.
			console.error(`[dev-wallet-host] ${request.method} ${request.url} failed: ${err?.stack || err}`);
			if (!response.headersSent) {
				response.writeHead(500, {'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store'});
			}
			response.end('the development wallet host failed to answer this request; see its console');
		}
	});
}

async function handle(request, response, root, options) {
	const send = (status, body, type = 'text/plain; charset=utf-8') => {
		response.writeHead(status, {'content-type': type, 'cache-control': 'no-store'});
		response.end(body);
	};

	let pathname;
	try {
		pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
	} catch {
		return send(400, 'bad request');
	}

	// The runtime configuration document, from wherever the developer keeps it.
	if (pathname === '/config.json' && options.config) {
		try {
			const body = await readFile(options.config);
			return send(200, body, MIME['.json']);
		} catch (err) {
			console.error(`[dev-wallet-host] could not read ${options.config}: ${err.message}`);
			return send(500, 'the configuration document could not be read');
		}
	}

	if (pathname.endsWith('/')) {
		pathname += 'index.html';
	}
	const file = resolveWithin(root, pathname);
	if (!file) {
		return send(403, 'forbidden');
	}

	let info;
	try {
		info = await stat(file);
	} catch {
		// THE ONE PATH WITH AN ANSWER FOR "ABSENT", because absent is its normal state. The host
		// asks for this on every popup, the document is optional, and a 404 in the console of a
		// correctly configured host is a red line that means nothing is wrong, which is exactly the
		// kind of noise that gets real errors ignored. An empty document is what "no configuration"
		// IS, and the host says so in as many words rather than claiming it was configured.
		//
		// Only when there is no such file: a `config.json` sitting in the served directory is served
		// above, and `--config` is answered earlier still.
		if (pathname === '/config.json') {
			return send(200, '{}', MIME['.json']);
		}
		// DELIBERATELY NOT index.html for anything else. See the header of this file: a fallback
		// turns a missing configuration document into one that silently did nothing.
		return send(404, `not found: ${pathname}`);
	}
	if (info.isDirectory()) {
		// RE-ENCODED. `pathname` was decoded on the way in, so putting it back verbatim would emit a
		// header with raw spaces or control characters in it, which Node rejects by throwing.
		const location = `${pathname.split('/').map(encodeURIComponent).join('/')}/`;
		response.writeHead(302, {location, 'cache-control': 'no-store'});
		return response.end();
	}

	response.writeHead(200, {
		'content-type': MIME[extname(file)] || 'application/octet-stream',
		'content-length': info.size,
		'cache-control': 'no-store',
	});
	createReadStream(file).pipe(response);
}
