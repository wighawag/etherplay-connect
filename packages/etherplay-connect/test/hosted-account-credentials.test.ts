// `getDelegation` and `getSignatureForPublicKeyPublication` on a HOSTED account.
//
// Both have two implementations behind one name, and only the wallet one was tested. On a wallet
// account they ask the wallet to sign, live, through the always-on wrapper (see
// `test/announced-requests.test.ts`). On a hosted account, reached through the email / OAuth /
// mnemonic popup, nothing can be signed after sign-in: the key lives at the wallet host and the
// popup is closed. So the credential either exists from sign-in or it cannot be had at all, and
// what the app gets instead is the reason, which is the difference between "ask again later" and
// "sign in again and ask for it this time".
//
// That is why these paths are worth covering rather than merely uncovered: the message IS the API
// here. An app that cannot tell the two cases apart offers the wrong remedy.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection, type OriginAccount} from '../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const WALLET_HOST = 'https://wallet.example.com';
const PAGE_ORIGIN = 'http://localhost:3000';
const ACCOUNT = '0xaaaa000000000000000000000000000000000aaa' as `0x${string}`;
const SIGNER = '0xbbbb000000000000000000000000000000000bbb' as `0x${string}`;
const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as `0x${string}`;
const OTHER_CONTRACT = '0xcccc000000000000000000000000000000000ccc' as `0x${string}`;
const SIGNATURE = `0x${'ab'.repeat(65)}` as `0x${string}`;

/** What the wallet host sends back when a popup sign-in succeeds. */
function hostedAccount(overrides?: Partial<OriginAccount>): OriginAccount {
	return {
		address: ACCOUNT,
		signer: {
			origin: PAGE_ORIGIN,
			address: SIGNER,
			publicKey: `0x${'cd'.repeat(33)}` as `0x${string}`,
			privateKey: `0x${'ef'.repeat(32)}` as `0x${string}`,
		},
		metadata: {email: 'user@example.com'},
		mechanismUsed: {type: 'email'},
		savedDelegations: [],
		...overrides,
	} as OriginAccount;
}

describe('credentials on a hosted account', () => {
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
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	/** Sign in through the popup, answering as the host would. */
	async function signedInAsHosted(account: OriginAccount) {
		const connection = createConnection({walletHost: WALLET_HOST, chainInfo, autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'email', email: 'user@example.com'});
		await vi.advanceTimersByTimeAsync(50);
		const id = Number(new URL(openedUrls[openedUrls.length - 1]).searchParams.get('id'));
		window.dispatchEvent(new MessageEvent('message', {data: {id, result: account}, origin: WALLET_HOST}));
		await vi.advanceTimersByTimeAsync(50);
		await connecting;

		expect(snapshot().step).toBe('SignedIn');
		// No wallet is involved at all: this is the shape these paths exist for.
		expect(snapshot().wallet).toBeUndefined();
		return {connection, snapshot};
	}

	it('returns the credential minted at sign-in for the pair the app asked about', async () => {
		const saved = {chainId: 1, contract: CONTRACT, delegate: SIGNER, deadline: 0, signature: SIGNATURE};
		const {connection} = await signedInAsHosted(hostedAccount({savedDelegations: [saved]}));

		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT})).resolves.toEqual(saved);
	});

	it('matches the contract case-insensitively, since an address is not a string to a chain', async () => {
		// Addresses arrive checksummed from some sources and lower-cased from others, and the same
		// account is the same account. A lookup that missed on case would report "no credential" for
		// one the user had already granted, and send them back through sign-in for nothing.
		const saved = {chainId: 1, contract: CONTRACT, delegate: SIGNER, deadline: 0, signature: SIGNATURE};
		const {connection} = await signedInAsHosted(hostedAccount({savedDelegations: [saved]}));

		const upperCased = CONTRACT.toUpperCase().replace('0X', '0x') as `0x${string}`;
		await expect(connection.getDelegation({chainId: 1, contract: upperCased})).resolves.toEqual(saved);
	});

	it('does not hand back a credential for a different contract or a different chain', async () => {
		// The pair is the whole extent of the authority: the contract's address is inside the signed
		// bytes, so a credential for another contract is worth nothing and returning it would fail
		// onchain instead of here.
		const saved = {chainId: 1, contract: CONTRACT, delegate: SIGNER, deadline: 0, signature: SIGNATURE};
		const {connection} = await signedInAsHosted(hostedAccount({savedDelegations: [saved]}));

		await expect(connection.getDelegation({chainId: 1, contract: OTHER_CONTRACT})).rejects.toThrow(
			'no delegation credential',
		);
		await expect(connection.getDelegation({chainId: 137, contract: CONTRACT})).rejects.toThrow(
			'no delegation credential',
		);
	});

	it('refuses a stored credential when the app asks for a DIFFERENT deadline', async () => {
		// The deadline is inside the signature too, so a record signed for one deadline cannot
		// answer a request naming another: those are different bytes, and they would not verify.
		const saved = {chainId: 1, contract: CONTRACT, delegate: SIGNER, deadline: 1893456000, signature: SIGNATURE};
		const {connection} = await signedInAsHosted(hostedAccount({savedDelegations: [saved]}));

		// Asking for the same deadline is answered.
		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT, deadline: 1893456000})).resolves.toEqual(
			saved,
		);
		// Asking for another one is not.
		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT, deadline: 42})).rejects.toThrow(
			'no delegation credential',
		);
		// Asking for none at all takes whatever was minted, since the caller expressed no requirement.
		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT})).resolves.toEqual(saved);
	});

	it('says to sign in again, because a hosted account cannot sign after the fact', async () => {
		// The message is the remedy: there is nothing the app can do at this point except take the
		// user back through sign-in and declare the permission that time.
		const {connection} = await signedInAsHosted(hostedAccount());

		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT})).rejects.toThrow(/sign in again/);
	});

	it('returns the publication signature the host produced', async () => {
		const {connection} = await signedInAsHosted(
			hostedAccount({savedPublicKeyPublicationSignature: SIGNATURE as `0x${string}`}),
		);

		await expect(connection.getSignatureForPublicKeyPublication()).resolves.toBe(SIGNATURE);
	});

	it('names the account it has no publication signature for', async () => {
		// Named rather than a bare failure, because an app running several accounts needs to know
		// WHICH one is unusable for this.
		//
		// Asserted synchronously because that is what it currently does. See the `it.fails` below.
		const {connection} = await signedInAsHosted(hostedAccount());

		expect(() => connection.getSignatureForPublicKeyPublication()).toThrow(ACCOUNT);
	});

	it('refuses both before sign-in, rather than reporting an absent credential', async () => {
		// A different failure from "signed in, nothing granted", and it must stay different: the
		// remedy is to sign in at all, not to sign in AGAIN.
		const connection = createConnection({walletHost: WALLET_HOST, chainInfo, autoConnect: false});

		await expect(connection.getDelegation({chainId: 1, contract: CONTRACT})).rejects.toThrow('Not signed in');
		expect(() => connection.getSignatureForPublicKeyPublication()).toThrow('Not signed in');
	});

	// KNOWN BUG, recorded rather than fixed. `it.fails` passes while the bug exists and turns red
	// the moment somebody fixes it, so the marker cannot be forgotten, and the suite (which gates
	// the release) stays green meanwhile.
	//
	// `getSignatureForPublicKeyPublication` is declared `(): Promise<`0x${string}`>` and its two
	// failure paths `throw` from a NON-async function, so they throw SYNCHRONOUSLY. `getDelegation`
	// beside it is `async`, so its identical-looking `throw` becomes a rejection. Two sibling
	// methods on the same object, both typed as returning a promise, failing in two different ways.
	//
	// A consumer writing the obvious `getSignatureForPublicKeyPublication().catch(showTheReason)`
	// gets an uncaught exception instead of its reason, and the shape of the code gives no warning:
	// the signature says Promise. The fix is one word, `async`, but it changes when a caller's
	// error arrives, so it belongs in its own change with a changeset that says so.
	it.fails('reports its failure as a rejection, like getDelegation does', async () => {
		const {connection} = await signedInAsHosted(hostedAccount());

		await expect(connection.getSignatureForPublicKeyPublication()).rejects.toThrow(ACCOUNT);
	});
});
