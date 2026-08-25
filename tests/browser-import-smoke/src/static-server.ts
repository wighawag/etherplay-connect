import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type {AddressInfo} from 'node:net';

// Deliberately strict, and deliberately tiny.
//
// A browser reports a stalled module download and a hung module evaluation IDENTICALLY: no console
// output, no error, `import()` never settles, and `document.readyState` stuck at 'interactive'. A
// sloppy static server (wrong MIME type, a Content-Length larger than the body it actually writes, a
// response whose body is never ended) therefore looks exactly like a bug in the imported package.
// This server exists so that when the test fails, the failure belongs to the package.
const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
};

export type StaticServer = {
	url: string;
	close: () => Promise<void>;
};

export async function serveDirectory(root: string): Promise<StaticServer> {
	const absoluteRoot = path.resolve(root);

	const server = http.createServer((req, res) => {
		let pathname: string;
		try {
			pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
		} catch {
			res.writeHead(400).end('bad request');
			return;
		}
		if (pathname.endsWith('/')) pathname += 'index.html';

		const file = path.join(absoluteRoot, pathname);
		// Refuse traversal rather than silently serving something unexpected.
		if (file !== absoluteRoot && !file.startsWith(absoluteRoot + path.sep)) {
			res.writeHead(403).end('forbidden');
			return;
		}
		if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404).end('not found');
			return;
		}

		const extension = path.extname(file);
		const contentType = MIME[extension];
		// An unknown type would be sent as octet-stream, which a browser refuses to execute as a
		// module. Failing loudly here beats debugging that refusal through the page.
		if (!contentType) {
			res.writeHead(500).end(`no MIME type configured for ${extension}`);
			return;
		}

		// Read the whole file first so Content-Length always describes the bytes actually written.
		const body = fs.readFileSync(file);
		res.writeHead(200, {
			'content-type': contentType,
			'content-length': String(body.length),
			'cache-control': 'no-store',
		});
		res.end(body);
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const {port} = server.address() as AddressInfo;

	return {
		// 127.0.0.1 is a secure context in Chromium, so crypto.subtle is available and the bundle runs
		// under the same Web Crypto assumptions as production.
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}
