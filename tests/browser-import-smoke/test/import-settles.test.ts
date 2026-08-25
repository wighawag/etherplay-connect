import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {build} from 'vite';
import {chromium, type Browser} from 'playwright';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveDirectory, type StaticServer} from '../src/static-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, '..', 'app');
const outDir = path.join(here, '..', 'dist-app');

// Generous enough that a slow CI machine never flakes, short enough that a genuine hang fails the
// run instead of wedging it. A healthy import settles in single-digit milliseconds.
const SETTLE_TIMEOUT_MS = 15_000;

let server: StaticServer;
let browser: Browser;

beforeAll(async () => {
	await build({
		root: appRoot,
		logLevel: 'warn',
		build: {
			outDir,
			emptyOutDir: true,
			// Unminified with sourcemaps: when this test does fail, the next step is opening the built
			// bundle in a headed browser, and minified output makes that far harder than it needs to be.
			minify: false,
			sourcemap: true,
			rollupOptions: {
				input: {
					static: path.join(appRoot, 'static.html'),
					dynamic: path.join(appRoot, 'dynamic.html'),
				},
			},
		},
	});

	server = await serveDirectory(outDir);
	browser = await chromium.launch();
});

afterAll(async () => {
	await browser?.close();
	await server?.close();
});

type PageOutcome = {
	smoke: {mode: string; settled: boolean; ok: boolean; exportCount?: number; error?: string} | null;
	readyState: string;
	isSecureContext: boolean;
	subtleType: string;
	consoleErrors: string[];
	pageErrors: string[];
	unfinishedRequests: string[];
};

// A blocked module can block the main thread two different ways: idle (awaiting something that never
// arrives) or spinning (a runaway loop). In the spinning case the page cannot answer `evaluate` at
// all, so an unguarded probe would hang the whole test run instead of failing it. Every probe is
// therefore bounded, and reports the thread as unresponsive rather than waiting forever.
async function probe<T>(work: Promise<T>, fallback: T): Promise<T> {
	let timer: NodeJS.Timeout;
	const timeout = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(fallback), 5_000);
	});
	try {
		return await Promise.race([work, timeout]);
	} catch {
		return fallback;
	} finally {
		clearTimeout(timer!);
	}
}

async function loadPage(pagePath: string): Promise<PageOutcome> {
	const page = await browser.newPage();
	const consoleErrors: string[] = [];
	const pageErrors: string[] = [];
	// Track delivery separately from execution. If a request never finishes, the page's silence is the
	// harness's fault, not the package's, and the assertions below say so explicitly.
	const pending = new Map<string, boolean>();

	page.on('request', (r) => pending.set(r.url(), false));
	page.on('requestfinished', (r) => pending.set(r.url(), true));
	page.on('requestfailed', (r) => pending.set(r.url(), true));
	page.on('console', (m) => {
		if (m.type() === 'error') consoleErrors.push(m.text());
	});
	page.on('pageerror', (e) => pageErrors.push(e.message));

	try {
		// 'commit' rather than 'load': waiting for load would itself hang on the very bug under test,
		// turning a clear assertion failure into an opaque timeout.
		await page.goto(`${server.url}/${pagePath}`, {waitUntil: 'commit'});

		try {
			await page.waitForFunction(() => window.__smoke !== undefined, undefined, {
				timeout: SETTLE_TIMEOUT_MS,
			});
		} catch {
			// Swallow: the assertions report the hang far better than a raw Playwright timeout does.
		}

		return {
			smoke: await probe(
				page.evaluate(() => window.__smoke ?? null),
				null,
			),
			readyState: await probe(
				page.evaluate(() => document.readyState),
				'unresponsive (main thread blocked)',
			),
			isSecureContext: await probe(
				page.evaluate(() => window.isSecureContext),
				false,
			),
			subtleType: await probe(
				page.evaluate(() => typeof globalThis.crypto?.subtle),
				'unknown',
			),
			consoleErrors,
			pageErrors,
			unfinishedRequests: [...pending].filter(([, done]) => !done).map(([url]) => url),
		};
	} finally {
		// A page whose thread is wedged still has to be torn down, or the run leaks a browser context.
		await probe(page.close(), undefined);
	}
}

describe('@etherplay/connect imports cleanly in a real browser', () => {
	// This whole file guards a class of bug that is invisible to node-based tests and to type checks,
	// which is how it survived into shipped releases: module evaluation that blocks only under a real
	// browser. happy-dom and a file:// import in node both evaluate the same bundle happily.

	it('reports a healthy harness before blaming the package', async () => {
		const outcome = await loadPage('static.html');

		// A stalled or mistyped response is indistinguishable, from inside the page, from a hung
		// import. Rule it out first so a failure below can only mean the package.
		expect(outcome.unfinishedRequests, 'a response never completed: the static server stalled').toEqual([]);
		// 127.0.0.1 must be a secure context, otherwise crypto.subtle is undefined and any module
		// touching it behaves differently than in production.
		expect(outcome.isSecureContext).toBe(true);
		expect(outcome.subtleType).toBe('object');
	});

	it('settles a static import, and lets the document finish loading', async () => {
		const outcome = await loadPage('static.html');

		expect(
			outcome.smoke,
			`static import never evaluated (readyState=${outcome.readyState}, ` +
				`consoleErrors=${JSON.stringify(outcome.consoleErrors)}, ` +
				`pageErrors=${JSON.stringify(outcome.pageErrors)}, ` +
				`unfinishedRequests=${JSON.stringify(outcome.unfinishedRequests)})`,
		).not.toBeNull();
		expect(outcome.smoke?.ok, 'createConnection missing from the imported namespace').toBe(true);
		expect(outcome.smoke!.exportCount).toBeGreaterThan(0);
		expect(outcome.pageErrors).toEqual([]);

		// The precise signature of the shipped bug: a blocked entry module keeps the document at
		// 'interactive' forever, so the app never starts and shows no error.
		expect(outcome.readyState, 'document never finished loading').toBe('complete');
	});

	it('settles a dynamic import, resolving rather than rejecting', async () => {
		const outcome = await loadPage('dynamic.html');

		expect(
			outcome.smoke,
			`dynamic import neither resolved nor rejected within ${SETTLE_TIMEOUT_MS}ms ` +
				`(readyState=${outcome.readyState}, ` +
				`unfinishedRequests=${JSON.stringify(outcome.unfinishedRequests)})`,
		).not.toBeNull();
		expect(outcome.smoke?.settled).toBe(true);
		expect(outcome.smoke?.error, 'dynamic import rejected').toBeUndefined();
		expect(outcome.smoke?.ok).toBe(true);
	});

	it('settles with a wallet-shaped window.ethereum present', async () => {
		const page = await browser.newPage();
		try {
			// Wallet presence changes which discovery paths run at import time, so both directions are
			// covered: the bug reproduced with and without an injected provider.
			await page.addInitScript(() => {
				(window as unknown as {ethereum: unknown}).ethereum = {
					request: async () => '0x1',
					on() {},
					removeListener() {},
				};
			});
			await page.goto(`${server.url}/dynamic.html`, {waitUntil: 'commit'});
			await page.waitForFunction(() => window.__smoke !== undefined, undefined, {
				timeout: SETTLE_TIMEOUT_MS,
			});
			expect(
				await probe(
					page.evaluate(() => window.__smoke?.ok),
					undefined,
				),
			).toBe(true);
		} finally {
			await probe(page.close(), undefined);
		}
	});
});
