// What the popup URL says, which is the entire contract between this library and the wallet host.
//
// The host is deployed SEPARATELY from the app, so this URL is a wire protocol between two things
// that version independently, and a wrong or missing parameter is a broken sign-in with no error
// anywhere on this side: the popup simply asks the wrong question, or none. Nothing exercised most
// of it, so the assertions here are all "what did the user's browser actually get sent to".
//
// The passthroughs (`renraku_*`, `eruda`, `debug`, `log`, `forceBroadcastChannel`) exist so that a
// developer debugging the app gets the same instrumentation inside the popup. They are read off the
// CURRENT page URL, so the tests set one.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection} from '../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const WALLET_HOST = 'https://wallet.example.com';
const PAGE_ORIGIN = 'http://localhost:3000';

describe('the popup URL', () => {
	let originalOpen: typeof window.open;
	let openedUrls: string[];

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		originalOpen = window.open;
		openedUrls = [];
		(window as any).open = vi.fn((url: string) => {
			openedUrls.push(url);
			return {closed: false, close: () => {}} as unknown as Window;
		});
	});

	afterEach(() => {
		(window as any).open = originalOpen;
		window.history.replaceState({}, '', '/');
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function connectionWith(settings?: {signingOrigin?: string}) {
		return createConnection({
			walletHost: WALLET_HOST,
			chainInfo,
			autoConnect: false,
			signingOrigin: settings?.signingOrigin,
		});
	}

	/**
	 * Read the email exactly as the wallet host reads it, which is the only reading that matters.
	 * Mirrors `web/login/src/lib/state.ts`: `decodeURIComponent(searchParams.get('email'))`.
	 */
	function readEmailAsTheHostDoes(url: URL) {
		const raw = url.searchParams.get('email');
		return raw ? decodeURIComponent(raw) : undefined;
	}

	/** Launch, read the URL, and settle the attempt so nothing leaks into the next test. */
	async function urlFor(connection: ReturnType<typeof connectionWith>, mechanism: any) {
		const connecting = connection.connect(mechanism);
		await vi.advanceTimersByTimeAsync(50);
		expect(openedUrls.length, 'the popup never opened').toBeGreaterThan(0);
		const url = new URL(openedUrls[openedUrls.length - 1]);
		connection.cancel();
		await connecting;
		return url;
	}

	it('asks for a mnemonic sign-in by naming the type and nothing else', async () => {
		// A mnemonic is derived by the host locally: there is no hosted provider involved, no email
		// and no oauth parameters to send.
		const url = await urlFor(connectionWith(), {type: 'mnemonic'});

		expect(url.origin + url.pathname).toBe(`${WALLET_HOST}/login/`);
		expect(url.searchParams.get('type')).toBe('mnemonic');
		expect(url.searchParams.has('email')).toBe(false);
		expect(url.searchParams.has('oauth-provider')).toBe(false);
	});

	it('carries the email and its mode when the app already knows them', async () => {
		const url = await urlFor(connectionWith(), {type: 'email', email: 'user@example.com', mode: 'signup'});

		expect(url.searchParams.get('type')).toBe('email');
		expect(readEmailAsTheHostDoes(url)).toBe('user@example.com');
		expect(url.searchParams.get('emailMode')).toBe('signup');
	});

	it('survives an address whose characters mean something in a URL', async () => {
		// `user+tag@example.com` is a valid, ordinary address and the one that catches an encoding
		// mistake: `+` means SPACE in a query string, so a single mis-step anywhere along the chain
		// delivers `user tag@example.com` to the host and the sign-in silently addresses the wrong
		// person.
		//
		// This side encodes twice (`encodeURIComponent`, then `searchParams.append` encodes the `%`),
		// and the host decodes twice to match (`searchParams.get`, then `decodeURIComponent` in
		// `web/login/src/lib/state.ts`). That pairing is what this test pins, END TO END rather than
		// on either side alone: the two are deployed separately, so a tidy-up that removes one encode
		// without the matching decode would break sign-in for these addresses only, and only in
		// production.
		const url = await urlFor(connectionWith(), {type: 'email', email: 'user+tag@example.com'});

		expect(readEmailAsTheHostDoes(url)).toBe('user+tag@example.com');
	});

	it('omits the email when the app does not have one yet', async () => {
		const url = await urlFor(connectionWith(), {type: 'email'});

		expect(url.searchParams.get('type')).toBe('email');
		expect(url.searchParams.has('email')).toBe(false);
	});

	it('names an oauth CONNECTION separately from the provider, when the app gives one', async () => {
		// Two different things: which provider to use, and which named connection at that provider.
		// A host that received only the provider would silently use the default connection.
		const url = await urlFor(connectionWith(), {
			type: 'oauth',
			provider: {id: 'auth0', connection: 'my-enterprise-tenant'},
			usePopup: true,
		});

		expect(url.searchParams.get('type')).toBe('oauth');
		expect(url.searchParams.get('oauth-provider')).toBe('auth0');
		expect(url.searchParams.get('oauth-connection')).toBe('my-enterprise-tenant');
	});

	it('sends only the provider when there is no named connection', async () => {
		const url = await urlFor(connectionWith(), {type: 'oauth', provider: {id: 'google'}, usePopup: true});

		expect(url.searchParams.get('oauth-provider')).toBe('google');
		expect(url.searchParams.has('oauth-connection')).toBe(false);
	});

	it('refuses a mechanism it does not know, rather than opening a popup that asks nothing', async () => {
		const connection = connectionWith();

		await expect(connection.connect({type: 'carrier-pigeon'} as any)).rejects.toThrow(
			'mechanism carrier-pigeon not supported',
		);
		expect(openedUrls).toHaveLength(0);
	});

	it('tells the host which origin the app signs for, when it signs for another', async () => {
		// The cross-origin case: an app asking the host to produce an account for a DIFFERENT origin
		// than its own. The host enforces its own answer, so this is a request and not a claim, but
		// it has to arrive or the host cannot even consider it.
		const url = await urlFor(connectionWith({signingOrigin: 'https://game.example.com'}), {type: 'mnemonic'});

		expect(url.searchParams.get('signingOrigin')).toBe('https://game.example.com');
	});

	it('passes the page debug flags through, so the popup is debuggable too', async () => {
		// `eruda`, `debug` and `log` follow the developer into the popup, which is a separate
		// document on a separate origin and otherwise gets none of the app's instrumentation.
		window.history.replaceState({}, '', '/?eruda=1&debug=connect&log=trace&forceBroadcastChannel=true');
		const url = await urlFor(connectionWith(), {type: 'mnemonic'});

		expect(url.searchParams.get('eruda')).toBe('1');
		expect(url.searchParams.get('debug')).toBe('connect');
		expect(url.searchParams.get('log')).toBe('trace');
		expect(url.searchParams.get('forceBroadcastChannel')).toBe('true');
	});

	it('forwards renraku_-prefixed parameters with the prefix stripped', async () => {
		// The prefix is how the app's own URL namespaces parameters meant for the host, so the host
		// receives them under their real names.
		window.history.replaceState({}, '', '/?renraku_endpoint=https%3A%2F%2Fapi.example.com&renraku_room=7&other=x');
		const url = await urlFor(connectionWith(), {type: 'mnemonic'});

		expect(url.searchParams.get('endpoint')).toBe('https://api.example.com');
		expect(url.searchParams.get('room')).toBe('7');
		// Only the prefixed ones travel: this is a namespace, not a free-for-all.
		expect(url.searchParams.has('other')).toBe(false);
		expect(url.searchParams.has('renraku_endpoint')).toBe(false);
	});

	it('always names the hosted provider and the account type the app expects back', async () => {
		// Both are chosen at build time and sent on every mechanism, including mnemonic, which does
		// not use the hosted provider at all. Asserted so that removing either from the URL is a
		// visible change rather than a silent one, since the host reads them.
		const url = await urlFor(connectionWith(), {type: 'mnemonic'});

		expect(url.searchParams.get('provider')).toBe('openfort');
		expect(url.searchParams.get('account-type')).toBeTruthy();
		// And the identity of the caller, which the host answers back to.
		expect(url.searchParams.get('origin')).toBe(PAGE_ORIGIN);
		expect(url.searchParams.get('id')).toBeTruthy();
	});
});
