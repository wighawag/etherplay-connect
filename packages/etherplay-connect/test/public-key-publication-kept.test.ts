// A wallet is asked for the public-key publication signature AT MOST ONCE per account and origin
// key, and the answer is kept on the account.
//
// The signature is the wallet's authorisation of the app's origin key
// (`originPublicKeyPublicationMessage(origin, publicKey)`), and several services verify the very
// same bytes: push-notification-server's `/register`, etherfold's trigger `/subscriptions` (renewed
// on every page load), missiv's `register`. A hosted account signed it once at sign-in and always
// answered from `savedPublicKeyPublicationSignature`; a wallet account asked the wallet EVERY time,
// so a wallet user got one prompt per service per reload, and jolly-roger had to grow its own
// `personal_sign` and localStorage cache to stop it.
//
// What is kept is only ever a signature that RECOVERS to the account for the message about to be
// signed (`delegated-identity`'s `recoverAccount`), checked when it is written and again when it is
// read. That one check is the whole binding to (origin, publicKey, address): a kept value for another
// origin, another key or another account recovers to somebody else and is ignored, and so is
// whatever an older persisted shape left in the field. A wallet answer that does not recover (an
// ERC-1271 smart-contract wallet, a wallet that signed with another account than the one asked
// for) is returned as it always was, and not kept: it would be wrong to make a bad answer permanent,
// and none of the three services above accepts one anyway.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';
import {createConnection, originPublicKeyPublicationMessage, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_NAME = 'Keyed Wallet';
const MNEMONIC = 'test test test test test test test test test test test junk';
const generator = new EthereumAccountGenerator();
const KEYS = [generator.fromMnemonicToAccount(MNEMONIC, 0), generator.fromMnemonicToAccount(MNEMONIC, 1)];
const A = KEYS[0].address.toLowerCase() as `0x${string}`;
const B = KEYS[1].address.toLowerCase() as `0x${string}`;
/** Bytes a wallet could return that recover to nobody in particular. */
const NOT_A_SIGNATURE_OF_A = `0x${'ab'.repeat(65)}` as `0x${string}`;

/** A wallet holding real keys for A and B, so its signatures recover, as an EOA's do. */
function installKeyedWallet(accounts: `0x${string}`[] = [A]): LockableWallet {
	const wallet = installLockableWallet({uuid: 'uuid-keyed', name: WALLET_NAME, rdns: 'com.example.keyed', accounts});
	wallet.setSigner(async (message, account) => {
		const key = KEYS.find((k) => k.address.toLowerCase() === account);
		if (!key) {
			throw new Error(`the wallet holds no key for ${account}`);
		}
		return generator.signTextMessage(message, key.privateKey);
	});
	return wallet;
}

/** The publication prompts the wallet has shown, as opposed to the sign-in one. */
function publicationPrompts(wallet: LockableWallet) {
	return wallet.signRequests().filter((r) => r.message.includes('This authorizes the following Public Key'));
}

function track(connection: {subscribe: (run: (v: Connection<any>) => void) => () => void}) {
	const seen: Connection<any>[] = [];
	connection.subscribe((v) => {
		seen.push(v);
	});
	const now = () => seen[seen.length - 1];
	const account = () => {
		const state = now();
		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}
		return state.account;
	};
	return {seen, now, account};
}

function storedAccount(storage: Storage = localStorage) {
	const raw = storage.getItem('__origin_account');
	return raw ? JSON.parse(raw) : undefined;
}

describe('the publication signature of a wallet account', () => {
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

	async function signedIn(options?: {address?: `0x${string}`; signingOrigin?: string}) {
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			autoConnect: false,
			signingOrigin: options?.signingOrigin,
		});
		const view = track(connection);
		const connecting = connection.connect({type: 'wallet', name: WALLET_NAME, address: options?.address});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(view.now().step).toBe('SignedIn');
		return {connection, ...view};
	}

	/** Construct a connection the way a page load does, restoring what storage holds. */
	async function reloaded(options?: {signingOrigin?: string}) {
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			signingOrigin: options?.signingOrigin,
		});
		const view = track(connection);
		await vi.advanceTimersByTimeAsync(200);
		expect(view.now().step).toBe('SignedIn');
		return {connection, ...view};
	}

	async function publication(connection: {getSignatureForPublicKeyPublication: () => Promise<`0x${string}`>}) {
		const getting = connection.getSignatureForPublicKeyPublication();
		await vi.advanceTimersByTimeAsync(50);
		return getting;
	}

	it('asks once, then answers from the account', async () => {
		wallet = installKeyedWallet();
		const {connection, account, seen} = await signedIn();
		expect(account().savedPublicKeyPublicationSignature).toBeUndefined();

		const first = await publication(connection);
		const second = await publication(connection);

		expect(second).toBe(first);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		expect(publicationPrompts(wallet)[0].message).toBe(
			originPublicKeyPublicationMessage(PAGE_ORIGIN, account().signer.publicKey),
		);
		// A subscriber SEES it, so an app reading `$connection.account.savedPublicKeyPublicationSignature`
		// gets it without calling anything.
		expect(account().savedPublicKeyPublicationSignature).toBe(first);
		expect(seen.some((s) => s.step === 'SignedIn' && s.account.savedPublicKeyPublicationSignature === first)).toBe(
			true,
		);
		// And it is in the persisted account, in both storages the sign-in wrote.
		expect(storedAccount(localStorage).savedPublicKeyPublicationSignature).toBe(first);
		expect(storedAccount(sessionStorage).savedPublicKeyPublicationSignature).toBe(first);
	});

	it('still has it after a reload, and asks nothing', async () => {
		wallet = installKeyedWallet();
		const before = await signedIn();
		const kept = await publication(before.connection);
		expect(publicationPrompts(wallet)).toHaveLength(1);

		const after = await reloaded();
		expect(after.account().savedPublicKeyPublicationSignature).toBe(kept);
		await expect(publication(after.connection)).resolves.toBe(kept);
		expect(publicationPrompts(wallet)).toHaveLength(1);
	});

	it('joins the request in flight rather than prompting twice', async () => {
		wallet = installKeyedWallet();
		const {connection} = await signedIn();
		let release!: () => void;
		wallet.whileSigning = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});

		const one = connection.getSignatureForPublicKeyPublication();
		const two = connection.getSignatureForPublicKeyPublication();
		await vi.advanceTimersByTimeAsync(50);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		release();
		const [first, second] = await Promise.all([one, two]);

		expect(second).toBe(first);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		// The request is over, so the next call answers from the account, not from the old promise.
		wallet.whileSigning = undefined;
		await expect(publication(connection)).resolves.toBe(first);
		expect(publicationPrompts(wallet)).toHaveLength(1);
	});

	it('lets every joiner see a refusal, and asks again next time', async () => {
		wallet = installKeyedWallet();
		const {connection, account} = await signedIn();
		wallet.whileSigning = () => {
			throw Object.assign(new Error('User rejected the request'), {code: 4001});
		};

		const one = expect(connection.getSignatureForPublicKeyPublication()).rejects.toThrow('User rejected');
		const two = expect(connection.getSignatureForPublicKeyPublication()).rejects.toThrow('User rejected');
		await vi.advanceTimersByTimeAsync(50);
		await Promise.all([one, two]);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		expect(account().savedPublicKeyPublicationSignature).toBeUndefined();

		wallet.whileSigning = undefined;
		const signature = await publication(connection);
		expect(publicationPrompts(wallet)).toHaveLength(2);
		expect(account().savedPublicKeyPublicationSignature).toBe(signature);
	});

	it('asks again for another account, and never answers it with the first one', async () => {
		wallet = installKeyedWallet([A, B]);
		const asA = await signedIn({address: A});
		const forA = await publication(asA.connection);

		const connecting = asA.connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = asA.connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(asA.account().address).toBe(B);
		// A different account starts empty, as it always did.
		expect(asA.account().savedPublicKeyPublicationSignature).toBeUndefined();

		const forB = await publication(asA.connection);
		expect(forB).not.toBe(forA);
		expect(publicationPrompts(wallet).map((r) => r.account)).toEqual([A, B]);
		expect(asA.account().savedPublicKeyPublicationSignature).toBe(forB);
	});

	it('does not write the answer onto an account that took over while the wallet was asked', async () => {
		wallet = installKeyedWallet([A, B]);
		const {connection, account} = await signedIn({address: A});
		let release!: () => void;
		wallet.whileSigning = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const forA = connection.getSignatureForPublicKeyPublication();
		await vi.advanceTimersByTimeAsync(50);

		// The app moves to B while A's prompt is still open.
		wallet.whileSigning = undefined;
		const connecting = connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(account().address).toBe(B);

		release();
		await forA;
		expect(account().savedPublicKeyPublicationSignature).toBeUndefined();
		expect(storedAccount().address).toBe(B);
		expect(storedAccount().savedPublicKeyPublicationSignature).toBeUndefined();
	});

	it('asks again for another origin key, never answering it with the kept one', async () => {
		// The same stored account restored under another signing origin: the message is now over
		// another origin, which the kept signature does not authorise.
		wallet = installKeyedWallet();
		const before = await signedIn();
		const kept = await publication(before.connection);

		const after = await reloaded({signingOrigin: 'https://other.example.com'});
		const answer = await publication(after.connection);

		expect(answer).not.toBe(kept);
		expect(publicationPrompts(wallet)).toHaveLength(2);
		expect(publicationPrompts(wallet)[1].message).toContain('Origin: https://other.example.com');
	});

	it('ignores a kept value that is not for this key', async () => {
		// A stored account whose kept signature was made for another public key: what a hand-edited
		// or an older persisted shape could hold. It is ignored, asked for again, and replaced.
		wallet = installKeyedWallet();
		const before = await signedIn();
		const kept = await publication(before.connection);
		const stored = storedAccount();
		const otherKey = `0x02${'cd'.repeat(32)}`;
		const forOtherKey = await generator.signTextMessage(
			originPublicKeyPublicationMessage(PAGE_ORIGIN, otherKey as `0x${string}`),
			KEYS[0].privateKey,
		);
		localStorage.setItem(
			'__origin_account',
			JSON.stringify({...stored, savedPublicKeyPublicationSignature: forOtherKey}),
		);

		const after = await reloaded();
		expect(after.account().savedPublicKeyPublicationSignature).toBeUndefined();
		await expect(publication(after.connection)).resolves.toBe(kept);
		expect(publicationPrompts(wallet)).toHaveLength(2);
		expect(after.account().savedPublicKeyPublicationSignature).toBe(kept);
		expect(storedAccount().savedPublicKeyPublicationSignature).toBe(kept);
	});

	it('ignores a stale value an older persisted shape left in the field', async () => {
		wallet = installKeyedWallet();
		await signedIn();
		const stored = storedAccount();
		localStorage.setItem(
			'__origin_account',
			JSON.stringify({...stored, savedPublicKeyPublicationSignature: NOT_A_SIGNATURE_OF_A}),
		);

		const after = await reloaded();
		// Not even SHOWN: an app reading the field to renew a subscription without a prompt would
		// otherwise send bytes every service refuses.
		expect(after.account().savedPublicKeyPublicationSignature).toBeUndefined();
		const answer = await publication(after.connection);
		expect(answer).not.toBe(NOT_A_SIGNATURE_OF_A);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		expect(after.account().savedPublicKeyPublicationSignature).toBe(answer);
	});

	it('checks a kept value again when it returns it, not only when it restores it', async () => {
		// No path in the library puts a foreign value on a live account today: the restore drops one
		// and the write keeps only what recovers. This pins the backstop, the check at the moment of
		// returning, by putting such a value on the live account object directly, as a future path
		// (or an app mutating the account it was handed) could.
		wallet = installKeyedWallet();
		const {connection, account} = await signedIn();
		const live = account() as {savedPublicKeyPublicationSignature?: `0x${string}`};
		live.savedPublicKeyPublicationSignature = NOT_A_SIGNATURE_OF_A;

		const answer = await publication(connection);
		expect(answer).not.toBe(NOT_A_SIGNATURE_OF_A);
		expect(publicationPrompts(wallet)).toHaveLength(1);
		expect(account().savedPublicKeyPublicationSignature).toBe(answer);
	});

	it('writes nothing back after a disconnect made while the wallet was being asked', async () => {
		// The disconnect cleared both storages. An answer arriving afterwards must not write the
		// account back into them, which would restore a session the user just ended.
		wallet = installKeyedWallet();
		const {connection, now} = await signedIn();
		let release!: () => void;
		wallet.whileSigning = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const getting = connection.getSignatureForPublicKeyPublication();
		const settled = getting.then(
			(signature) => ({signature}),
			(error) => ({error}),
		);
		await vi.advanceTimersByTimeAsync(50);

		connection.disconnect();
		expect(now().step).toBe('Idle');
		expect(storedAccount(localStorage)).toBeUndefined();
		expect(storedAccount(sessionStorage)).toBeUndefined();

		release();
		await vi.advanceTimersByTimeAsync(50);
		await settled;
		expect(now().step).toBe('Idle');
		expect(storedAccount(localStorage)).toBeUndefined();
		expect(storedAccount(sessionStorage)).toBeUndefined();
	});

	it('does not persist an account the user asked not to store', async () => {
		wallet = installKeyedWallet();
		const connection = createConnection({walletHost: 'https://wallet.example.com', chainInfo, autoConnect: false});
		const view = track(connection);
		const connecting = connection.connect({type: 'wallet', name: WALLET_NAME}, {doNotStoreLocally: true});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(storedAccount()).toBeUndefined();

		const signature = await publication(connection);
		expect(view.account().savedPublicKeyPublicationSignature).toBe(signature);
		expect(storedAccount()).toBeUndefined();
		expect(storedAccount(sessionStorage)).toBeUndefined();
	});

	describe('keeps only a signature that recovers to the account', () => {
		it('returns a wallet answer that does not recover, but does not keep it', async () => {
			// What an ERC-1271 smart-contract wallet answers, or a wallet that signed with another
			// account than the one it was asked for. Returned as before, so nothing that worked stops
			// working; kept, it would make a bad answer permanent for every service that checks it.
			wallet = installKeyedWallet();
			const {connection, account} = await signedIn();
			wallet.setSigner(undefined);
			wallet.setSignature(NOT_A_SIGNATURE_OF_A);

			await expect(publication(connection)).resolves.toBe(NOT_A_SIGNATURE_OF_A);
			await expect(publication(connection)).resolves.toBe(NOT_A_SIGNATURE_OF_A);

			expect(publicationPrompts(wallet)).toHaveLength(2);
			expect(account().savedPublicKeyPublicationSignature).toBeUndefined();
			expect(storedAccount().savedPublicKeyPublicationSignature).toBeUndefined();
		});

		it('does not keep a valid signature by another account', async () => {
			wallet = installKeyedWallet([A, B]);
			const {connection, account} = await signedIn({address: A});
			const byB = await generator.signTextMessage(
				originPublicKeyPublicationMessage(PAGE_ORIGIN, account().signer.publicKey),
				KEYS[1].privateKey,
			);
			wallet.setSigner(async () => byB);

			await expect(publication(connection)).resolves.toBe(byB);
			expect(account().savedPublicKeyPublicationSignature).toBeUndefined();
		});
	});
});
