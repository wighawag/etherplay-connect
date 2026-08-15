/**
 * THE GATE FOR THIS PACKAGE, DRIVEN THE WAY AN ADOPTER WOULD.
 *
 * Pack the tarball, install it with npm into a throwaway project that has no workspace, no
 * `node_modules` from this repo and no path back to this checkout, start the bin the way a dev
 * script would, and complete a mnemonic sign-in against it in a real browser.
 *
 * Why this exists as a file rather than as something somebody once ran: everything else here is a
 * unit test, and a unit test cannot fail for the reasons this package actually fails for. The two
 * bugs found the first time this was run were both invisible to unit tests and to a human reading
 * the code: the bin did nothing at all when reached through the `.bin` symlink an install creates,
 * and the startup banner named the origin `127.0.0.1` while the adopter's app said `localhost`,
 * which is the exact confusion the whole artefact exists to prevent.
 *
 * NOT part of `pnpm test` and not in CI: it needs Chrome, and it packs and installs. Run it by hand
 * before publishing, or when the bundle, the bin or the popup contract changes:
 *
 *   node scripts/verify-adopter-install.mjs
 *
 * Set CHROME to point at a browser if `google-chrome` is not on PATH.
 */
import {createServer} from 'node:http';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const PACKAGE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const CHROME = process.env.CHROME || 'google-chrome';
const HOST_PORT = Number(process.env.HOST_PORT || 50400);
const APP_PORT = HOST_PORT + 1;
const APP_ORIGIN = `http://localhost:${APP_PORT}`;
const HOST_ORIGIN = `http://localhost:${HOST_PORT}`;
const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';
const ACCOUNT_0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const DEBUG_PORT = HOST_PORT + 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(ok, what) {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
	if (!ok) failures.push(what);
}

const project = await mkdtemp(join(tmpdir(), 'etherplay-adopter-'));
const cleanup = [];
async function done(code) {
	for (const fn of cleanup.reverse()) {
		try {
			await fn();
		} catch {}
	}
	await rm(project, {recursive: true, force: true});
	process.exit(code);
}

console.log(`\n== packing and installing into ${project}\n`);
execFileSync('pnpm', ['pack', '--pack-destination', project], {cwd: PACKAGE, stdio: 'inherit'});
const tarball = execFileSync('sh', ['-c', `ls ${project}/*.tgz`])
	.toString()
	.trim();
await writeFile(join(project, 'package.json'), JSON.stringify({name: 'adopter-app', private: true, type: 'module'}));
execFileSync('npm', ['install', tarball, '--no-audit', '--no-fund', '--offline'], {cwd: project, stdio: 'inherit'});

// What an adopter writes: one config file, in their own project, not inside node_modules.
await writeFile(
	join(project, 'wallet-host.config.json'),
	JSON.stringify({
		originAllowlist: {[APP_ORIGIN]: [{chainId: 31337, contract: CONTRACT}]},
		autoSignedLifetimeSeconds: 120,
	}),
);

// What an adopter puts in their dev script.
// From the project root, with a RELATIVE config path, because that is how a dev script says it.
const host = spawn(
	join(project, 'node_modules/.bin/dev-wallet-host'),
	['--port', String(HOST_PORT), '--config', './wallet-host.config.json'],
	{cwd: project},
);
cleanup.push(() => host.kill());
let banner = '';
host.stdout.on('data', (d) => (banner += d));
host.stderr.on('data', (d) => (banner += d));

const APP_HTML = `<!doctype html><html><body>app
<script>
window.__result = null;
window.addEventListener('message', (e) => { window.__result = {origin: e.origin, data: e.data}; });
window.openPopup = (url) => { window.open(url, 'login', 'popup=1,width=500,height=700'); };
</script></body></html>`;
const app = createServer((_req, res) => {
	res.writeHead(200, {'content-type': 'text/html', 'cache-control': 'no-store'});
	res.end(APP_HTML);
});
await new Promise((r) => app.listen(APP_PORT, '127.0.0.1', r));
cleanup.push(() => new Promise((r) => app.close(r)));

await sleep(1000);
console.log(banner);
check(banner.includes(`serving   ${HOST_ORIGIN}`), 'the banner names the exact origin to point the app at');
check(banner.includes('DEVELOPMENT ONLY'), 'and says what it is not for');
check((await fetch(`${HOST_ORIGIN}/login/`)).status === 200, 'the login page is served');
check(
	(await fetch(`${HOST_ORIGIN}/config.json`)).status === 200,
	"the config document is served from the adopter's own directory",
);

// ---------------------------------------------------------------- the browser
let nextId = 1;
const pendingCalls = new Map();
const listeners = new Set();
let ws;
function send(method, params = {}, sessionId) {
	const id = nextId++;
	ws.send(JSON.stringify({id, method, params, sessionId}));
	return new Promise((res, rej) => pendingCalls.set(id, {res, rej}));
}
async function evaluate(sessionId, expression) {
	const result = await send('Runtime.evaluate', {expression, returnByValue: true, userGesture: true}, sessionId);
	if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails.exception));
	return result.result.value;
}
async function waitFor(fn, timeout, what) {
	const start = Date.now();
	for (;;) {
		const value = await fn();
		if (value) return value;
		if (Date.now() - start > timeout) throw new Error(`timeout waiting for ${what}`);
		await sleep(100);
	}
}

const profile = join(project, 'chrome-profile');
const chrome = spawn(
	CHROME,
	[
		'--headless=new',
		`--remote-debugging-port=${DEBUG_PORT}`,
		`--user-data-dir=${profile}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-gpu',
		'--disable-popup-blocking',
		'about:blank',
	],
	{stdio: 'ignore'},
);
cleanup.push(() => chrome.kill());
chrome.on('error', (err) => {
	console.error(`could not start ${CHROME}: ${err.message}. Set CHROME to a browser binary.`);
	done(1);
});

let wsUrl;
for (let i = 0; i < 80 && !wsUrl; i++) {
	try {
		wsUrl = (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;
	} catch {
		await sleep(250);
	}
}
if (!wsUrl) {
	console.error(`no browser on the debugging port; is ${CHROME} installed?`);
	await done(1);
}
ws = new WebSocket(wsUrl);
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (message) => {
	const msg = JSON.parse(message.data);
	if (msg.id && pendingCalls.has(msg.id)) {
		const {res, rej} = pendingCalls.get(msg.id);
		pendingCalls.delete(msg.id);
		msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
	} else if (msg.method) {
		for (const fn of [...listeners]) fn(msg);
	}
};

const {targetId} = await send('Target.createTarget', {url: APP_ORIGIN});
const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
await send('Runtime.enable', {}, sessionId);
await send('Target.setDiscoverTargets', {discover: true});

let popupSession;
const logs = [];
listeners.add(async (msg) => {
	if (
		msg.method === 'Target.targetCreated' &&
		msg.params.targetInfo.type === 'page' &&
		msg.params.targetInfo.targetId !== targetId
	) {
		popupSession = (await send('Target.attachToTarget', {targetId: msg.params.targetInfo.targetId, flatten: true}))
			.sessionId;
		await send('Runtime.enable', {}, popupSession);
	}
	if (msg.method === 'Runtime.consoleAPICalled') {
		logs.push(
			(msg.params.args || []).map((a) => (a.value !== undefined ? String(a.value) : a.description || '')).join(' '),
		);
	}
});

const params = new URLSearchParams({
	origin: APP_ORIGIN,
	id: '1',
	'account-type': 'ethereum',
	type: 'mnemonic',
	debug: '1',
	permissions: JSON.stringify([{type: 'delegation', required: true, chainId: 31337, contract: CONTRACT}]),
});

try {
	await waitFor(() => evaluate(sessionId, `typeof window.openPopup === 'function'`), 10000, 'the app page');
	await evaluate(sessionId, `window.openPopup(${JSON.stringify(`${HOST_ORIGIN}/login/?${params}`)})`);
	await waitFor(() => !!popupSession, 10000, 'the popup');
	await waitFor(
		() => evaluate(popupSession, `!!document.querySelector('#account-0')`).catch(() => false),
		20000,
		'the account picker',
	);
	await evaluate(popupSession, `document.querySelector('#account-0').click()`);
	const delivered = await waitFor(() => evaluate(sessionId, `window.__result`), 20000, 'the result');

	const account = delivered?.data?.result;
	check(
		account?.address === ACCOUNT_0,
		`a mnemonic sign-in completed with no key and no network (${account?.address})`,
	);
	check(account?.signer?.origin === APP_ORIGIN, 'with an origin signer for the app origin');
	check(!!account?.savedPublicKeyPublicationSignature, 'and a publication signature');
	check(account?.savedDelegations?.length === 1, "and the credential the adopter's config file allowlisted");
	const seconds = account?.savedDelegations?.[0]?.deadline - Math.floor(Date.now() / 1000);
	check(seconds > 60 && seconds <= 130, `with the deadline that file asked for (~${seconds}s, expected ~120)`);
	check(
		logs.some((l) => l.includes(`login host serving ${HOST_ORIGIN}`) && l.includes('DEVELOPMENT build')),
		'and the popup said which origin it is on and which build it is',
	);
	check(
		logs.some((l) => l.includes('configured by /config.json')),
		'and that it took the runtime document',
	);
} catch (err) {
	console.error(err.message);
	console.error(logs.join('\n'));
	failures.push(String(err.message));
}

console.log(`\n${failures.length === 0 ? 'ADOPTER GATE: PASS' : `ADOPTER GATE: FAIL\n- ${failures.join('\n- ')}`}`);
await done(failures.length === 0 ? 0 : 1);
