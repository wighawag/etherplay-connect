// An account from before the publication named the key set signs out, and an out-of-date wallet
// host cannot sign in.
//
// The public-key publication (`originPublicKeyPublicationMessage`, from `delegated-identity`) used to
// name the origin signer's secp256k1 key; it now names an Ed25519 signing key and an X25519
// encryption key (`keySet`, derived beside the signer). Every service checks the new message, so a
// saved signature over the old one is worth nothing, and a hosted account cannot sign again after
// sign-in. So an account is only restored or signed in when it carries a key set and its saved
// signature VERIFIES for it (`recoverAccount({appOrigin, keySet, ownershipSignature})` is the
// account): the presence of a key set is not enough, since one can sit beside an old signature.
//
// A wallet account is the exception for an ABSENT signature only: the wallet path asks for the
// publication lazily, so a stored wallet account with a key set and no signature yet is kept, and
// signs the new message the first time the app asks.
//
// The check is asynchronous, so a hosted session lands a moment after construction rather than
// during it, tracked like a wallet restore so an `ensureConnected()` made meanwhile joins it.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, ConnectionFailure, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';
import {hostedAccount, keySetOf, signAsHostedAccount} from './fixtures/current-accounts.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_HOST = 'https://wallet.example.com';
const WALLET_NAME = 'Returning Wallet';
const A = '0xaaaa00000000000000000000000000000000000a' as `0x${string}`;
const STORED_SIGNER_PRIVATE_KEY = `0x${'ef'.repeat(32)}` as `0x${string}`;

/** The publication message before it named the key set, frozen here: what older accounts signed. */
function oldPublicationMessage(origin: string, publicKey: string): string {
	return (
		`Origin: ${origin}\n` +
		'\n' +
		'IMPORTANT: Only sign on trusted websites.\n' +
		'\n' +
		'This authorizes the following Public Key to represent your account:\n' +
		'\n' +
		`${publicKey}\n` +
		'\n' +
		'Others can use this key to write encrypted messages to you securely.'
	);
}

/** A hosted account as an older wallet host returned it: no key set, a signature over the old message. */
async function olderHostAccount() {
	const {keySet, ...account} = await hostedAccount(PAGE_ORIGIN);
	return {
		...account,
		savedPublicKeyPublicationSignature: await signAsHostedAccount(
			oldPublicationMessage(PAGE_ORIGIN, account.signer.publicKey),
		),
	};
}

/** A key set derived beside an old signature: the shape the presence check alone would accept. */
async function keySetBesideOldSignature() {
	return {...(await olderHostAccount()), keySet: (await hostedAccount(PAGE_ORIGIN)).keySet};
}

function seed(account: unknown) {
	const raw = JSON.stringify(account);
	localStorage.setItem('__origin_account', raw);
	sessionStorage.setItem('__origin_account', raw);
}

function rememberWalletAccount(account: Record<string, unknown>) {
	const mechanism = {type: 'wallet', name: WALLET_NAME, address: A};
	seed({
		address: A,
		signer: {
			origin: PAGE_ORIGIN,
			address: '0x5555000000000000000000000000000000000005',
			publicKey: `0x${'cd'.repeat(33)}`,
			privateKey: STORED_SIGNER_PRIVATE_KEY,
		},
		metadata: {},
		mechanismUsed: mechanism,
		savedDelegations: [],
		...account,
	});
	localStorage.setItem('__last_wallet', JSON.stringify(mechanism));
	sessionStorage.setItem('__last_wallet', JSON.stringify(mechanism));
}

function track(connection: {subscribe: (run: (v: Connection<any>) => void) => () => void}) {
	const seen: Connection<any>[] = [];
	connection.subscribe((v) => {
		seen.push(v);
	});
	return {seen, now: () => seen[seen.length - 1] as any};
}

describe('a stored account from before the publication named the key set', () => {
	let wallet: LockableWallet | undefined;

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

	function load() {
		return track(createConnection({walletHost: WALLET_HOST, chainInfo}));
	}

	it('signs a hosted account out when it has no key set, and drops it from both storages', async () => {
		seed(await olderHostAccount());

		const {seen, now} = load();
		await vi.advanceTimersByTimeAsync(200);

		expect(now().step).toBe('Idle');
		expect(now().loading).toBe(false);
		expect(seen.some((s) => s.step === 'SignedIn')).toBe(false);
		expect(localStorage.getItem('__origin_account')).toBeNull();
		expect(sessionStorage.getItem('__origin_account')).toBeNull();
	});

	it('signs a hosted account out when its key set has no matching signature', async () => {
		seed(await keySetBesideOldSignature());

		const {seen, now} = load();
		await vi.advanceTimersByTimeAsync(200);

		expect(now().step).toBe('Idle');
		expect(seen.some((s) => s.step === 'SignedIn')).toBe(false);
		expect(localStorage.getItem('__origin_account')).toBeNull();
	});

	it('signs a hosted account out when it carries no publication signature at all', async () => {
		// A hosted account cannot sign after the fact, so one without a signature is unusable.
		const {savedPublicKeyPublicationSignature, ...account} = await hostedAccount(PAGE_ORIGIN);
		seed(account);

		const {now} = load();
		await vi.advanceTimersByTimeAsync(200);

		expect(now().step).toBe('Idle');
	});

	it('drops it even when the app never auto-connects', async () => {
		seed(await olderHostAccount());

		createConnection({walletHost: WALLET_HOST, chainInfo, autoConnect: false});
		await vi.advanceTimersByTimeAsync(0);

		expect(localStorage.getItem('__origin_account')).toBeNull();
		expect(sessionStorage.getItem('__origin_account')).toBeNull();
	});

	it('signs a wallet account out when it has no key set', async () => {
		wallet = installLockableWallet({uuid: 'uuid-r', name: WALLET_NAME, rdns: 'com.example.r', accounts: [A]});
		rememberWalletAccount({});

		const {seen, now} = load();
		await vi.advanceTimersByTimeAsync(500);

		expect(now().step).toBe('Idle');
		expect(seen.some((s) => s.step === 'SignedIn')).toBe(false);
		// Not even waited for: the wallet was never asked for its accounts.
		expect(wallet.getAccountsCalls()).toBe(0);
	});

	it('keeps a wallet account with a key set and no publication signature yet', async () => {
		// The wallet path asks for the publication lazily, so this is what it stores until the app
		// first asks: the next `getSignatureForPublicKeyPublication` signs the current message.
		wallet = installLockableWallet({uuid: 'uuid-r', name: WALLET_NAME, rdns: 'com.example.r', accounts: [A]});
		rememberWalletAccount({keySet: keySetOf(STORED_SIGNER_PRIVATE_KEY)});

		const {now} = load();
		await vi.advanceTimersByTimeAsync(500);

		expect(now().step).toBe('SignedIn');
		expect(now().account.address).toBe(A);
		expect(now().account.keySet).toEqual(keySetOf(STORED_SIGNER_PRIVATE_KEY));
		expect(localStorage.getItem('__origin_account')).not.toBeNull();
	});
});

describe('a current hosted account restores asynchronously', () => {
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

	it('lands a moment after construction, as the stored account', async () => {
		const stored = await hostedAccount(PAGE_ORIGIN);
		seed(stored);

		const {now} = track(createConnection({walletHost: WALLET_HOST, chainInfo}));
		// Not during construction: the verification of its publication signature is asynchronous.
		expect(now().step).toBe('Idle');
		expect(now().loading).toBe(true);

		await vi.advanceTimersByTimeAsync(0);
		expect(now().step).toBe('SignedIn');
		expect(now().account).toEqual(stored);
		expect(now().wallet).toBeUndefined();
	});

	it('is joined by an ensureConnected() made before it lands, with no popup', async () => {
		const stored = await hostedAccount(PAGE_ORIGIN);
		seed(stored);

		const connection = createConnection({walletHost: WALLET_HOST, chainInfo});
		const ensuring = connection.ensureConnected();
		await vi.advanceTimersByTimeAsync(50);
		const result = await ensuring;

		expect(result.step).toBe('SignedIn');
		expect(result.account.address).toBe(stored.address);
		expect(openedUrls).toEqual([]);
	});
});

describe('an account from an out-of-date wallet host', () => {
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

	/** Sign in through the popup with `ensureConnected`, the host answering with `result`. */
	async function signInWith(result: unknown) {
		const connection = createConnection({walletHost: WALLET_HOST, chainInfo, autoConnect: false});
		const view = track(connection);
		const settled: {error?: unknown; value?: unknown} = {};
		const ensuring = connection.ensureConnected('SignedIn', {type: 'email', email: 'user@example.com'}).then(
			(value) => {
				settled.value = value;
			},
			(error) => {
				settled.error = error;
			},
		);
		await vi.advanceTimersByTimeAsync(50);
		const id = Number(new URL(openedUrls[openedUrls.length - 1]).searchParams.get('id'));
		window.dispatchEvent(new MessageEvent('message', {data: {id, result}, origin: WALLET_HOST}));
		await vi.advanceTimersByTimeAsync(200);
		await ensuring;
		return {...view, settled};
	}

	it('fails sign-in with "the wallet host is out of date" when the account has no key set', async () => {
		const {seen, now, settled} = await signInWith(await olderHostAccount());

		expect(seen.some((s) => s.step === 'SignedIn')).toBe(false);
		expect(now().step).toBe('Idle');
		expect(now().error.message).toMatch(/the wallet host is out of date/);
		expect(now().error.cause).toEqual({type: 'wallet-host-out-of-date'});
		expect(settled.error).toBeInstanceOf(ConnectionFailure);
		expect((settled.error as Error).message).toMatch(/the wallet host is out of date/);
		// Refused, not stored.
		expect(localStorage.getItem('__origin_account')).toBeNull();
		expect(sessionStorage.getItem('__origin_account')).toBeNull();
	});

	it('fails sign-in the same way when its key set has no matching signature', async () => {
		const {now, settled} = await signInWith(await keySetBesideOldSignature());

		expect(now().step).toBe('Idle');
		expect(now().error.message).toMatch(/the wallet host is out of date/);
		expect((settled.error as Error).message).toMatch(/the wallet host is out of date/);
		expect(localStorage.getItem('__origin_account')).toBeNull();
	});

	it('requires a publication signature whatever mechanism the host names', async () => {
		// The lazy wallet-path exception is for accounts this library derived itself, not for
		// whatever the host returns: a host result claiming a wallet mechanism still needs one.
		const {savedPublicKeyPublicationSignature, ...account} = await hostedAccount(PAGE_ORIGIN);
		const {now} = await signInWith({...account, mechanismUsed: {type: 'wallet', name: 'X', address: account.address}});

		expect(now().step).toBe('Idle');
		expect(now().error.message).toMatch(/the wallet host is out of date/);
	});

	it('signs in with a current account', async () => {
		const current = await hostedAccount(PAGE_ORIGIN);
		const {now, settled} = await signInWith(current);

		expect(settled.error).toBeUndefined();
		expect(now().step).toBe('SignedIn');
		expect(now().account.keySet).toEqual(current.keySet);
	});
});
