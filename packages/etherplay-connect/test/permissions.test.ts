// What the app declares at connect time has to REACH the host, because the host is the only party
// that can ask the user and the only party that can mint a credential. The declaration travels on
// the popup URL, which makes it a wire format: an app on one version of this package talks to a
// host on another, so the shape it puts on that URL is a contract rather than an internal detail.
//
// Nothing here trusts the declaration. It is a request: the host decides each entry, and enforces
// its decision by withholding what it did not grant.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, delegationMessage, type PermissionDeclaration} from '../src/index.js';

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

// The case no overload can express: a connection that CAN reach a host (so declaring permissions
// type-checks) where the user then picks the injected wallet as the owner. Nothing about
// `createConnection` can know that in advance, so the answer has to come at runtime.
//
// A minimal EIP-6963 wallet, deliberately not the fuller one in `wallet-only-no-host.test.ts`:
// only the four methods this flow touches, kept local so a change there cannot quietly change what
// is being asserted here.
function installWallet() {
	const info = {uuid: 'uuid-wallet', name: 'Injected Wallet', icon: '', rdns: 'com.example.injected'};
	const signMessageCalls: {message: string; account: string}[] = [];
	const provider = {
		request: async ({method, params}: {method: string; params?: any[]}) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return [ACCOUNT];
				case 'personal_sign':
					signMessageCalls.push({message: params?.[0], account: params?.[1]});
					return SIGNATURE;
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: () => {},
		removeListener: () => {},
	};
	const onRequest = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info, provider}}));
	window.addEventListener('eip6963:requestProvider', onRequest);
	return {
		uninstall: () => window.removeEventListener('eip6963:requestProvider', onRequest),
		signMessageCalls: () => signMessageCalls,
	};
}

/**
 * What the wallet actually received.
 *
 * `personal_sign` takes HEX-ENCODED data, so the connector encodes the message before handing it
 * over. Decoding here rather than comparing hex keeps the assertion about the bytes the user is
 * shown and the contract rebuilds, which is what has to match.
 */
function decodeSignedMessage(param: string): string {
	if (!param.startsWith('0x')) {
		return param;
	}
	const bytes = new Uint8Array((param.slice(2).match(/.{2}/g) || []).map((b) => parseInt(b, 16)));
	return new TextDecoder().decode(bytes);
}

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SIGNATURE = `0x${'ab'.repeat(65)}` as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';

describe('a live wallet answering a declaration it cannot pre-generate', () => {
	let wallet: ReturnType<typeof installWallet> | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		wallet?.uninstall();
		wallet = undefined;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	async function signedInWithWallet(permissions?: PermissionDeclaration[]) {
		wallet = installWallet();
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			autoConnect: false,
			permissions,
		});

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		let state!: any;
		connection.subscribe((v) => {
			state = v;
		})();
		return {connection, state, wallet: wallet!};
	}

	it('answers every declared permission rather than ignoring it', async () => {
		// The failure this prevents: `savedDelegations: []` with no outcomes is indistinguishable
		// from "the app never asked", so the app would offer a re-prompt for something that was
		// never refused and needs no prompt at all.
		const {state} = await signedInWithWallet([
			{type: 'delegation', chainId: 1, contract: CONTRACT},
			{type: 'teleport', required: false},
		]);

		expect(state.step).toBe('SignedIn');
		expect(state.account.savedDelegations).toEqual([]);
		expect(state.account.permissions).toEqual([
			{
				request: {type: 'delegation', required: false, chainId: 1, contract: CONTRACT},
				granted: false,
				reason: 'sign-on-demand',
			},
			{
				request: {type: 'unrecognized', required: false, requestedType: 'teleport'},
				granted: false,
				reason: 'sign-on-demand',
			},
		]);
	});

	it('says nothing when the app asked for nothing', async () => {
		// `undefined` is "nobody asked", and it has to stay distinguishable from an answer.
		const {state} = await signedInWithWallet(undefined);
		expect(state.account.permissions).toBeUndefined();
	});

	it('signs the credential on demand, at the moment it is wanted', async () => {
		const {connection, state, wallet} = await signedInWithWallet([
			{type: 'delegation', chainId: 1, contract: CONTRACT},
		]);
		const before = wallet.signMessageCalls().length;

		const credential = await connection.getDelegation({chainId: 1, contract: CONTRACT});

		// The record is self-describing: a signature alone is unusable, because the delegate and
		// the deadline it was made over are inside the bytes.
		expect(credential).toEqual({
			chainId: 1,
			contract: CONTRACT,
			delegate: state.account.signer.address,
			deadline: 0,
			signature: SIGNATURE,
		});

		// Signed live by the OWNER wallet, over exactly the bytes the contract rebuilds.
		const call = wallet.signMessageCalls()[before];
		expect(decodeSignedMessage(call.message)).toBe(
			delegationMessage({delegate: state.account.signer.address, contract: CONTRACT, chainId: 1, deadline: 0}),
		);
		expect(call.account.toLowerCase()).toBe(ACCOUNT.toLowerCase());
	});

	it('puts the requested deadline inside the signed bytes', async () => {
		const {connection, state, wallet} = await signedInWithWallet();
		const deadline = 1767225600;

		const credential = await connection.getDelegation({chainId: 31337, contract: CONTRACT, deadline});

		expect(credential.deadline).toBe(deadline);
		const call = wallet.signMessageCalls()[wallet.signMessageCalls().length - 1];
		expect(decodeSignedMessage(call.message)).toBe(
			delegationMessage({delegate: state.account.signer.address, contract: CONTRACT, chainId: 31337, deadline}),
		);
		expect(decodeSignedMessage(call.message)).toContain('Expires: 1767225600');
	});

	it('lowercases the contract, whatever casing the app holds it in', async () => {
		// One spelling in the record and in the signed message, or the two disagree and the
		// signature recovers to nobody.
		const {connection} = await signedInWithWallet();
		const credential = await connection.getDelegation({
			chainId: 1,
			contract: '0xE7F1725E7734CE288F8367E1BB143E90BB3F0512',
		});
		expect(credential.contract).toBe(CONTRACT);
	});
});
