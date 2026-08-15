/**
 * Put the built development host inside this package, so what is published is a directory somebody
 * can serve and nothing else.
 *
 * The BUNDLE is built by `web` (one source, two builds: see web/README.md). This package does not
 * own a second copy of that source and must never grow one; it owns the server that puts it on a
 * port, and the promise that what ships is the DEVELOPMENT build.
 */
import {cp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE = resolve(HERE, '..');
const REPO = resolve(PACKAGE, '../..');
const BUILT = resolve(REPO, 'web/dist-dev');
const SITE = resolve(PACKAGE, 'site');

const fresh = process.argv.includes('--fresh');

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

if (fresh || !(await exists(resolve(BUILT, 'login/index.html')))) {
	console.log('[dev-wallet-host] building the development host from web/');
	execFileSync('pnpm', ['run', '--filter', './web', 'build:dev-host'], {cwd: REPO, stdio: 'inherit'});
}

// The one check that matters, and it is worth failing the build over: the production build and the
// development one differ in a single flag, they land in adjacent directories, and copying the wrong
// one in here would publish a host that ignores its own configuration document under a name that
// promises the opposite.
//
// Asked of `build-info.json`, which the build emits for exactly this question, rather than grepped
// out of a bundle: a check that depends on the wording of a `console.log` is a check somebody
// breaks by improving a sentence.
let info;
try {
	info = JSON.parse(await readFile(resolve(BUILT, 'build-info.json'), 'utf-8'));
} catch (err) {
	throw new Error(
		`${BUILT} carries no build-info.json, so which of the two builds it is cannot be established: ${err.message}`,
	);
}
if (info.developmentBuild !== true) {
	throw new Error(
		`${BUILT} is a "${info.mode}" build, not a development one, so it does not honour a runtime ` +
			`configuration document. Build it with \`pnpm --filter ./web build:dev-host\` (vite build --mode development).`,
	);
}

await rm(SITE, {recursive: true, force: true});
await mkdir(SITE, {recursive: true});
await cp(BUILT, SITE, {recursive: true});

// The example document, at the package root, which is where `files` publishes it from and where
// the README tells an adopter to copy it FROM:
// `node_modules/@etherplay/dev-wallet-host/config.example.json`. It is deliberately NOT put inside
// `site/`: everything in there is served, and a served `config.example.json` next to the real
// `/config.json` is one filename away from being mistaken for the live one.
await cp(resolve(REPO, 'web/config.example.json'), resolve(PACKAGE, 'config.example.json'));

// For whoever opens the served directory itself and wonders what it is.
await writeFile(
	resolve(SITE, 'README.txt'),
	[
		'This directory is the Etherplay sign-in host, DEVELOPMENT build.',
		'',
		'It accepts a runtime configuration document at /config.json and is unfit for real',
		'accounts by construction. Serve it with `dev-wallet-host`, or with any static server',
		'that does NOT fall back to index.html for missing paths.',
		'',
		'An example document to copy and edit lives one level up, at the root of this package:',
		'  node_modules/@etherplay/dev-wallet-host/config.example.json',
		'Pass yours with `dev-wallet-host --config ./wallet-host.config.json`; it does not have',
		'to live in here, and is better kept in your own project where you can edit it.',
		'',
		'https://github.com/wighawag/etherplay-connect',
		'',
	].join('\n'),
);

console.log(`[dev-wallet-host] site/ <- web/dist-dev`);
