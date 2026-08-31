// Every request this library sends to the user's wallet has to be VISIBLE while it is outstanding,
// because the wallet popup it opens says nothing about who asked or why. See
// `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`.
//
// The failure this guards is silent by construction: a signature routed past the always-on wrapper
// works perfectly, returns the right bytes, and every test about WHAT was signed still passes. The
// only symptom is a wallet popup with no dialog behind it, which is indistinguishable from a
// phishing prompt and which a careful user is right to refuse. So the assertions here are all about
// what the store said DURING the request, not about its result.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type PendingRequest} from '../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;
const SIGNATURE = `0x${'ab'.repeat(65)}` as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';

/**
 * A wallet that lets the test look at the store WHILE it is holding a signature.
 *
 * The hook runs inside the `personal_sign` handler, which is the only moment that matters: before
 * it the request has not started, after it the request is over, and a check at either end would
 * pass against the very bug this file exists to catch.
 */
function installWallet() {
	const info = {uuid: 'uuid-wallet', name: 'Injected Wallet', icon: '', rdns: 'com.example.injected'};
	let whileSigning: (() => void) | undefined;
	const provider = {
		request: async ({method, params}: {method: string; params?: any[]}) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return [ACCOUNT];
				case 'personal_sign':
					whileSigning?.();
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
		set whileSigning(hook: (() => void) | undefined) {
			whileSigning = hook;
		},
	};
}

describe('what the app can see while the wallet is being asked', () => {
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

	async function signedInWithWallet() {
		wallet = installWallet();
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			autoConnect: false,
		});

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		/** What the store holds right now. */
		const snapshot = () => {
			let state!: any;
			connection.subscribe((v) => {
				state = v;
			})();
			return state;
		};

		return {connection, snapshot, wallet: wallet!};
	}

	it('names the delegation signature while the wallet is holding it', async () => {
		// The reported bug: pressing "Buy an avatar" opened MetaMask with no dialog behind it,
		// because this list stayed empty for the whole duration of the request.
		const {connection, snapshot, wallet} = await signedInWithWallet();

		let during: PendingRequest[] | undefined;
		wallet.whileSigning = () => {
			during = snapshot().wallet?.pendingRequests;
		};

		const getting = connection.getDelegation({chainId: 1, contract: CONTRACT});
		await vi.advanceTimersByTimeAsync(200);
		await getting;

		expect(during).toHaveLength(1);
		expect(during![0].kind).toBe('signature');
		// `kind` alone only supports "your wallet is asking for something". A delegation hands a
		// browser key authority to act for the account, which deserves to be said out loud.
		expect(during![0].purpose).toBe('delegation');

		// And it has to STOP being pending, or the modal it raised never closes.
		expect(snapshot().wallet?.pendingRequests).toEqual([]);
	});

	it('names the public-key publication signature too', async () => {
		const {connection, snapshot, wallet} = await signedInWithWallet();

		let during: PendingRequest[] | undefined;
		wallet.whileSigning = () => {
			during = snapshot().wallet?.pendingRequests;
		};

		const getting = connection.getSignatureForPublicKeyPublication();
		await vi.advanceTimersByTimeAsync(200);
		await getting;

		expect(during).toHaveLength(1);
		expect(during![0].purpose).toBe('public-key-publication');
		expect(snapshot().wallet?.pendingRequests).toEqual([]);
	});

	it('stops announcing when the user refuses', async () => {
		// A rejected request that stays in the list is a modal that never closes, which is worse
		// than the missing modal this file is about.
		const {connection, snapshot, wallet} = await signedInWithWallet();

		wallet.whileSigning = () => {
			throw Object.assign(new Error('User rejected the request'), {code: 4001});
		};

		// The assertion is attached BEFORE the clock is advanced: a rejection with no handler yet is
		// an unhandled rejection, which fails the run for a reason that has nothing to do with the test.
		const rejected = expect(connection.getDelegation({chainId: 1, contract: CONTRACT})).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(200);
		await rejected;

		expect(snapshot().wallet?.pendingRequests).toEqual([]);
	});

	it('signs a delegation for a chain the connection is not on', async () => {
		// The reason this signature is announced through a dedicated `signMessage` rather than sent
		// down `provider.request`: the always-on provider speaks for ONE chain and refuses signing
		// methods when the wallet is elsewhere, but a delegation names the chain it authorises
		// INSIDE the signed bytes and is routinely minted for another one.
		const {connection} = await signedInWithWallet();

		const getting = connection.getDelegation({chainId: 31337, contract: CONTRACT});
		await vi.advanceTimersByTimeAsync(200);

		await expect(getting).resolves.toMatchObject({chainId: 31337, signature: SIGNATURE});
	});

	it('says nothing about purpose when the app asked for itself', async () => {
		// Absence is MEANINGFUL: it is how a consumer tells "the library wants something from you" from
		// "the app you are using sent a request", and only the first needs explaining, because in the
		// second the app already knows what it sent. Asserted with `toStrictEqual` on the key set,
		// because `{purpose: undefined}` would satisfy a laxer check while breaking `'purpose' in req`.
		const {connection, snapshot, wallet} = await signedInWithWallet();

		let during: PendingRequest[] | undefined;
		wallet.whileSigning = () => {
			during = snapshot().wallet?.pendingRequests;
		};

		// The app's own request, down the generic path rather than through `getDelegation`.
		const signing = connection.provider.request({
			method: 'personal_sign',
			params: ['0xdeadbeef', ACCOUNT],
		} as any);
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(during).toHaveLength(1);
		expect(during![0].kind).toBe('signature');
		expect('purpose' in during![0]).toBe(false);
		expect(Object.keys(during![0]).sort()).toStrictEqual(['id', 'kind', 'method', 'startedAt']);
	});

	it('leaves the sign-in signature to its own step, so consumers do not stack two modals', async () => {
		// The one deliberate exception, and the reason it is deliberate: `WaitingForSignature` is a
		// step consumers already render a "please sign" dialog from. Announcing sign-in HERE as well
		// would open that dialog and the generic pending-request modal at the same time, on nothing
		// but a version bump. If `WaitingForSignature` is ever removed, this test is the thing that
		// has to be revisited: see the ADR.
		wallet = installWallet();
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			autoConnect: false,
		});
		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		let during: {step: string; pending: PendingRequest[] | undefined} | undefined;
		wallet.whileSigning = () => {
			let state!: any;
			connection.subscribe((v) => {
				state = v;
			})();
			during = {step: state.step, pending: state.wallet?.pendingRequests};
		};

		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(during!.step).toBe('WaitingForSignature');
		expect(during!.pending).toEqual([]);
	});
});
