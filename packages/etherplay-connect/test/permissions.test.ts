// What the app declares at connect time has to REACH the host, because the host is the only party
// that can ask the user and the only party that can mint a credential. The declaration travels on
// the popup URL, which makes it a wire format: an app on one version of this package talks to a
// host on another, so the shape it puts on that URL is a contract rather than an internal detail.
//
// Nothing here trusts the declaration. It is a request: the host decides each entry, and enforces
// its decision by withholding what it did not grant.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type PermissionDeclaration} from '../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;

describe('declaring permissions at connect time', () => {
	let originalOpen: typeof window.open;
	let openedURLs: string[];

	beforeEach(() => {
		originalOpen = window.open;
		openedURLs = [];
		(window as any).open = vi.fn((url?: string | URL) => {
			openedURLs.push(String(url));
			// A popup that never answers: these tests are about what was ASKED, and the request is
			// fully formed by the time `window.open` is called.
			return {closed: false, close: vi.fn()} as unknown as Window;
		});
	});

	afterEach(() => {
		(window as any).open = originalOpen;
		vi.restoreAllMocks();
	});

	async function popupURLFor(permissions?: PermissionDeclaration[]): Promise<URL> {
		openedURLs.length = 0;
		const store = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			permissions,
		});
		// The popup never resolves in these tests, so the connect promise is deliberately not
		// awaited; what matters is the URL the launcher opened.
		store.connect({type: 'email', email: 'test@example.com', mode: 'otp'}).catch(() => {});
		await vi.waitFor(() => expect(openedURLs.length).toBe(1));
		return new URL(openedURLs[0]);
	}

	it('carries the declaration to the host', async () => {
		const permissions: PermissionDeclaration[] = [
			{type: 'delegation', required: false, chainId: 31337, contract: CONTRACT},
		];
		const url = await popupURLFor(permissions);

		expect(JSON.parse(url.searchParams.get('permissions')!)).toEqual(permissions);
	});

	it('carries several, in the order the app asked', async () => {
		// Order is the app's, and the host preserves it: the user is asked in the order the app
		// considered sensible rather than in whatever order a map happened to iterate.
		const permissions: PermissionDeclaration[] = [
			{type: 'delegation', chainId: 1, contract: CONTRACT},
			{type: 'delegation', chainId: 31337, contract: CONTRACT},
		];
		const url = await popupURLFor(permissions);

		expect(JSON.parse(url.searchParams.get('permissions')!).map((p: any) => p.chainId)).toEqual([1, 31337]);
	});

	it('carries a type this version does not know about', async () => {
		// The escape hatch has to survive the wire, because the whole point of it is that a NEWER
		// app can ask an OLDER host for something and be told it did not get it. Dropping it here
		// would turn that into silence.
		const url = await popupURLFor([{type: 'teleport', required: true, destination: 'moon'}]);

		expect(JSON.parse(url.searchParams.get('permissions')!)).toEqual([
			{type: 'teleport', required: true, destination: 'moon'},
		]);
	});

	it('asks for nothing when the app declares nothing', async () => {
		// An app that wants no onchain authority must not have any requested on its behalf, and the
		// absence has to be an absent parameter rather than an empty list the host has to interpret.
		expect((await popupURLFor(undefined)).searchParams.has('permissions')).toBe(false);
		expect((await popupURLFor([])).searchParams.has('permissions')).toBe(false);
	});

	it('survives a round trip through the URL unchanged', async () => {
		// The contract addresses and the JSON both go through percent-encoding. A checksummed
		// address must come out spelled exactly as it went in: the host lowercases it deliberately,
		// at parse time, and that has to be the only place the spelling changes.
		const checksummed = '0xE7F1725E7734CE288F8367E1bB143E90bb3F0512' as const;
		const url = await popupURLFor([{type: 'delegation', chainId: 1, contract: checksummed}]);

		expect(JSON.parse(url.searchParams.get('permissions')!)[0].contract).toBe(checksummed);
	});
});
