// A LATE auto-connect must yield to whatever happened after it started.
//
// Auto-connect runs once, at construction, and has to ask the wallet two questions before it can
// restore anything (`eth_chainId`, then `eth_accounts`). A wallet backed by a chain that is still
// booting answers those slowly, and in that window the app is free to act: an explicit `connect`,
// a `useCurrentAccount` reconnect following the wallet, a signature. When the restore finally lands
// it used to publish the STORED account over all of that.
//
// Measured downstream (template-commit-reveal's hotseat e2e, against 0.17.0), in this order:
// SignedIn as B (just signed), SignedIn as A (the stored account, wallet offering [B, A]), then
// WalletConnected as B with NO signer, because `onAccountChanged` followed the wallet back to B
// without asking for a signature. It needs a slow wallet AND several accounts, which is why a
// single-account app never sees it.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const A = '0xaaaa00000000000000000000000000000000000a' as `0x${string}`;
const B = '0xbbbb00000000000000000000000000000000000b' as `0x${string}`;
const STORED_SIGNER = '0x5555000000000000000000000000000000000005' as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_NAME = 'Slow Wallet';

/** What a previous session signed in as A left behind. */
function rememberSignedInAs(address: `0x${string}`) {
	const mechanism = {type: 'wallet', name: WALLET_NAME, address};
	const account = JSON.stringify({
		address,
		signer: {
			origin: PAGE_ORIGIN,
			address: STORED_SIGNER,
			publicKey: `0x${'cd'.repeat(33)}`,
			privateKey: `0x${'ef'.repeat(32)}`,
		},
		metadata: {},
		mechanismUsed: mechanism,
		savedDelegations: [],
	});
	localStorage.setItem('__origin_account', account);
	sessionStorage.setItem('__origin_account', account);
	rememberWallet(address);
}

function rememberWallet(address: `0x${string}`) {
	const lastWallet = JSON.stringify({type: 'wallet', name: WALLET_NAME, address});
	localStorage.setItem('__last_wallet', lastWallet);
	sessionStorage.setItem('__last_wallet', lastWallet);
}

describe('a late auto-connect', () => {
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

	function snapshotOf(connection: {subscribe: (run: (v: Connection<any>) => void) => () => void}) {
		return () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
	}

	function installSlowWallet() {
		// The wallet is on B now, and still holds A: the user switched since the last visit.
		wallet = installLockableWallet({uuid: 'uuid-slow', name: WALLET_NAME, rdns: 'com.example.slow', accounts: [B, A]});
		return wallet;
	}

	function createSignedInConnection() {
		return createConnection({
			chainInfo,
			walletOnly: true,
			targetStep: 'SignedIn',
			useCurrentAccount: 'always',
		});
	}

	/** The app signs in as B while the restore of A is still waiting on the wallet. */
	async function signInAsB(connection: ReturnType<typeof createSignedInConnection>) {
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await vi.advanceTimersByTimeAsync(10);
		await connection.requestSignature();
		await vi.advanceTimersByTimeAsync(10);
	}

	for (const slowRead of ['eth_chainId', 'eth_accounts'] as const) {
		it(`does not restore the stored account over a sign-in made while ${slowRead} was slow`, async () => {
			rememberSignedInAs(A);
			const release = installSlowWallet().holdNext(slowRead);

			const connection = createSignedInConnection();
			const snapshot = snapshotOf(connection);
			// The wallet announces and the restore starts, then waits on the held read.
			await vi.advanceTimersByTimeAsync(200);
			expect(snapshot().step).toBe('Idle');

			await signInAsB(connection);
			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);
			const signerOfB = snapshot().account.signer.address;
			expect(signerOfB).not.toBe(STORED_SIGNER);

			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);
			expect(snapshot().account.signer.address).toBe(signerOfB);
			expect(snapshot().mechanism.address).toBe(B);
			expect(snapshot().wallet.status).toBe('connected');
		});
	}

	it('does not tear down a newer sign-in when the restore it raced finally times out', async () => {
		// The other ending of the same race: the held read never comes back inside `withTimeout`, and
		// the restore's failure path rests the flow at `Idle`, which tears the wallet down. That is
		// right when nothing else happened, and wrong over a session the app has since signed in.
		rememberSignedInAs(A);
		installSlowWallet().holdNext('eth_accounts');

		const connection = createSignedInConnection();
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		await signInAsB(connection);
		expect(snapshot().step).toBe('SignedIn');

		// Past the 5s `withTimeout` on the held read.
		await vi.advanceTimersByTimeAsync(6000);

		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().wallet.status).toBe('connected');
	});

	it('does not sign the user back in after they disconnected while it was waiting', async () => {
		// `disconnect` from the initial `Idle` lands on `Idle` again, so the step alone does not show
		// that the flow moved: `loading` ending does. A restore that missed it would sign back in an
		// account whose storage `disconnect` has just deleted.
		rememberSignedInAs(A);
		const release = installSlowWallet().holdNext('eth_accounts');

		const connection = createSignedInConnection();
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		connection.disconnect();
		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().wallet).toBeUndefined();
		expect(localStorage.getItem('__origin_account')).toBeNull();
	});

	it('does not restore the last wallet over an explicit connect made meanwhile (WalletConnected)', async () => {
		rememberWallet(A);
		const release = installSlowWallet().holdNext('eth_accounts');

		// No `useCurrentAccount`: with it, the wallet announcing B would drag the connection back to B
		// after the late restore and hide the overwrite behind a second reconnect.
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await vi.advanceTimersByTimeAsync(10);
		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);

		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().mechanism.address).toBe(B);
	});

	it('does not restore the chosen wallet over an explicit connect made meanwhile (WalletChosen)', async () => {
		localStorage.setItem('__last_wallet', JSON.stringify({type: 'wallet', name: WALLET_NAME}));
		sessionStorage.setItem('__last_wallet', JSON.stringify({type: 'wallet', name: WALLET_NAME}));
		const release = installSlowWallet().holdNext('eth_chainId');

		const connection = createConnection({chainInfo, targetStep: 'WalletChosen', prioritizeWalletProvider: true});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await vi.advanceTimersByTimeAsync(10);
		expect(snapshot().step).toBe('WalletConnected');

		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().wallet.status).toBe('connected');
	});

	it('still restores when nothing happened in the meantime, however slow the wallet was', async () => {
		// The guard must only yield to something NEWER: a slow wallet on its own is the ordinary case
		// and still ends signed in as the stored account. Wallet discovery publishing in the meantime
		// (the list growing) is not something newer.
		rememberSignedInAs(A);
		wallet = installLockableWallet({uuid: 'uuid-slow', name: WALLET_NAME, rdns: 'com.example.slow', accounts: [A, B]});
		const release = wallet.holdNext('eth_accounts');

		const connection = createSignedInConnection();
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(2000);
		expect(snapshot().step).toBe('Idle');

		release();
		await vi.advanceTimersByTimeAsync(200);

		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().account.address).toBe(A);
		expect(snapshot().account.signer.address).toBe(STORED_SIGNER);
	});
});
