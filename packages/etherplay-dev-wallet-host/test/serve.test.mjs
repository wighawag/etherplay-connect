/**
 * The server's three opinions, tested, because each one is a silent failure when it is wrong.
 *
 * Deliberately against a temporary fixture rather than the built bundle: this suite is about the
 * SERVER, it runs in CI before anything has been built, and a test that needs a vite build to say
 * anything is a test that gets skipped.
 */
import {test, before, after, describe} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHost} from '../lib/server.js';

let dir;
let configFile;
let server;
let origin;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), 'dev-wallet-host-'));
	await mkdir(join(dir, 'login'), {recursive: true});
	await writeFile(join(dir, 'index.html'), '<!doctype html>root');
	await writeFile(join(dir, 'login', 'index.html'), '<!doctype html>login');
	await writeFile(join(dir, 'login', 'app.js'), 'export const a = 1;');
	configFile = join(dir, 'my-config.json');
	await writeFile(configFile, JSON.stringify({autoSignedLifetimeSeconds: 120}));

	server = createHost({dir, config: configFile});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(dir, {recursive: true, force: true});
});

describe('the development wallet host server', () => {
	test('serves the login page at the path the popup URL uses', async () => {
		const response = await fetch(`${origin}/login/`);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /login/);
	});

	test('never falls back to index.html for a missing path', async () => {
		// The trap this exists to avoid: the host reads /config.json and treats an HTML answer as
		// "no document", so a server that answers everything with the app makes a mistyped filename
		// look like a configuration that quietly did nothing.
		const response = await fetch(`${origin}/login/does-not-exist.js`);
		assert.equal(response.status, 404);
		assert.doesNotMatch(await response.text(), /doctype/i);
	});

	test('serves the configuration document from wherever the developer keeps it', async () => {
		const response = await fetch(`${origin}/config.json`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type'), /json/);
		assert.deepEqual(await response.json(), {autoSignedLifetimeSeconds: 120});
	});

	test('re-reads that document on every request, so editing it and reloading is the whole loop', async () => {
		await writeFile(configFile, JSON.stringify({autoSignedLifetimeSeconds: 7}));
		const response = await fetch(`${origin}/config.json`);
		assert.deepEqual(await response.json(), {autoSignedLifetimeSeconds: 7});
	});

	test('stores nothing, so a reload is a reload', async () => {
		for (const path of ['/login/', '/config.json', '/login/app.js']) {
			const response = await fetch(`${origin}${path}`);
			assert.equal(response.headers.get('cache-control'), 'no-store', path);
		}
	});

	test('refuses to reach outside the directory it was given', async () => {
		// PERCENT-ENCODED, and that is the whole point of the test: `/../../../etc/passwd` is
		// normalised to `/etc/passwd` by the URL parser before the request is even sent, so the
		// server never sees a traversal and the guard is never reached. This form survives to
		// `decodeURIComponent`, which is where the traversal actually appears.
		const traversal = `${origin}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`;
		const response = await fetch(traversal, {redirect: 'manual'});
		assert.equal(response.status, 403);
		assert.doesNotMatch(await response.text(), /root:/);
	});

	test('and the naive form of that request is not what proves it', async () => {
		// Recorded so nobody "simplifies" the test above back into one that passes without ever
		// reaching the code it claims to check.
		assert.equal(new URL('/../../../etc/passwd', 'http://x').pathname, '/etc/passwd');
	});

	test('serves a config.json that is IN the directory, rather than the empty one', async () => {
		// The `--config` flag is one way to hand this host a document; dropping the file next to
		// index.html is the other, and it must not be shadowed by the empty answer above.
		await writeFile(join(dir, 'config.json'), JSON.stringify({devMnemonic: 'from the directory'}));
		const bare = createHost({dir});
		await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
		const bareOrigin = `http://127.0.0.1:${bare.address().port}`;
		try {
			assert.deepEqual(await (await fetch(`${bareOrigin}/config.json`)).json(), {
				devMnemonic: 'from the directory',
			});
		} finally {
			bare.closeAllConnections();
			await new Promise((resolve) => bare.close(resolve));
			await rm(join(dir, 'config.json'), {force: true});
		}
	});

	test('redirects a directory without emitting an invalid header', async () => {
		// `pathname` is decoded on the way in, so a name with a space in it would put a raw space in
		// the Location header, which Node refuses by throwing - inside an async handler, where a
		// throw used to end the process.
		await mkdir(join(dir, 'a folder'), {recursive: true});
		const response = await fetch(`${origin}/a%20folder`, {redirect: 'manual'});
		assert.equal(response.status, 302);
		assert.equal(response.headers.get('location'), '/a%20folder/');
	});

	test('survives a request that makes the handler throw', async () => {
		// The server an adopter puts in their dev script and their CI must answer 500 rather than
		// vanish: a process that exits mid-run reads as a flaky test, not as a bug here.
		const broken = createHost({dir, config: join(dir, 'nope.json')});
		await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve));
		const brokenOrigin = `http://127.0.0.1:${broken.address().port}`;
		try {
			assert.equal((await fetch(`${brokenOrigin}/config.json`)).status, 500);
			// still alive
			assert.equal((await fetch(`${brokenOrigin}/login/`)).status, 200);
		} finally {
			// Otherwise `close` waits for the client's keep-alive socket to time out, and this test
			// spends three seconds doing nothing.
			broken.closeAllConnections();
			await new Promise((resolve) => broken.close(resolve));
		}
	});

	test('answers an EMPTY document, not a 404, when there is no configuration', async () => {
		const bare = createHost({dir});
		await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
		const bareOrigin = `http://127.0.0.1:${bare.address().port}`;
		try {
			// Absence is this file's normal state, and the host asks for it on every popup. A 404
			// would put a red line in the console of a correctly configured host, and the host would
			// then have to describe "no document" and "an empty document" as different things when
			// they mean the same one. It says `{}` instead, and the host reports built-in defaults.
			const response = await fetch(`${bareOrigin}/config.json`);
			assert.equal(response.status, 200);
			assert.match(response.headers.get('content-type'), /json/);
			assert.deepEqual(await response.json(), {});

			// And nothing else gets an answer it did not ask for.
			assert.equal((await fetch(`${bareOrigin}/login/nope.json`)).status, 404);
			assert.equal((await fetch(`${bareOrigin}/login/`)).status, 200);
		} finally {
			bare.closeAllConnections();
			await new Promise((resolve) => bare.close(resolve));
		}
	});
});
