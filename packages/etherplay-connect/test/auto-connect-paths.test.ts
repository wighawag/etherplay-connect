// Auto-connect: what a RETURNING user gets on page load, before touching anything.
//
// This is the most-taken path in the library and the least visible one, because it runs once at
// construction with no call site to read. It restores from storage and then waits for the wallet to
// announce itself, which is a race by nature: EIP-6963 announcements arrive asynchronously, and the
// wallet the user signed in with last time may be slow, disabled, or gone.
//
// The failures are the interesting part. Every one of them has to end somewhere the user can act
// from, with no wallet left routing, because "we tried to restore your session and could not" is a
// state the app must render rather than hang in.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_NAME = 'Returning Wallet';

/** What a previous session left behind for the wallet mechanism. */
function rememberWallet(name = WALLET_NAME, address: `0x${string}` = ACCOUNT) {
	const value = JSON.stringify({type: 'wallet', name, address});
	localStorage.setItem('__last_wallet', value);
	sessionStorage.setItem('__last_wallet', value);
}

/** What a previous session left behind for a HOSTED account. */
function rememberHostedAccount() {
	localStorage.setItem(
		'__origin_account',
		JSON.stringify({
			address: '0xaaaa000000000000000000000000000000000aaa',
			signer: {
				origin: PAGE_ORIGIN,
				address: '0xbbbb000000000000000000000000000000000bbb',
				publicKey: `0x${'cd'.repeat(33)}`,
				privateKey: `0x${'ef'.repeat(32)}`,
			},
			metadata: {email: 'user@example.com'},
			mechanismUsed: {type: 'email'},
			savedDelegations: [],
		}),
	);
}

describe('auto-connect on page load', () => {
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

	it('restores the remembered wallet without prompting for anything', async () => {
		// The point of remembering: a returning user is connected again without a click, and
		// crucially without `eth_requestAccounts`, which would raise a wallet popup on page load.
		wallet = installLockableWallet({uuid: 'uuid-r', name: WALLET_NAME, rdns: 'com.example.returning'});
		rememberWallet();

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(500);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(ACCOUNT);
		expect(snapshot().wallet.status).toBe('connected');
		expect(wallet.requestAccountsCalls()).toBe(0);
	});

	it('gives up on a wallet that never announces itself, and says so by resting', async () => {
		// The wallet was uninstalled, or disabled, or is simply slower than the window. There is
		// nothing to wait for indefinitely: the flow rests where the user can start over, and
		// `loading` stops, which is what an app renders its spinner from.
		rememberWallet('Wallet That Is Gone');

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		expect(snapshot().loading).toBe(true);

		await vi.advanceTimersByTimeAsync(3000);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().loading).toBe(false);
		expect(snapshot().wallet).toBeUndefined();
	});

	it('rests, with no wallet left routing, when the remembered wallet cannot answer', async () => {
		// It announced itself and then failed the first question. The wallet may already be
		// registered on the wrapper at that point, so what matters is that nothing is left behind:
		// an `Idle` state that kept routing through a broken wallet would fail every read after.
		wallet = installLockableWallet({uuid: 'uuid-b', name: WALLET_NAME, rdns: 'com.example.broken'});
		wallet.setChainIdFailure(true);
		rememberWallet();

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(3000);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().loading).toBe(false);
		expect(snapshot().wallet).toBeUndefined();
	});

	it('restores the identity of a wallet that comes back LOCKED, and says it is locked', async () => {
		// I expected this to rest at `Idle`, and it does something better: it restores WHO the user
		// was and reports that the wallet cannot act. The remembered address is still true, and
		// `status: 'locked'` is exactly the state an app renders an "Unlock" button from.
		//
		// So a returning user with a locked wallet lands on `WalletConnected` + `locked`, which is the
		// state the whole locked-wallet contract is about (`unlock()` is the call, see
		// `test/locked-wallet-reconnect.test.ts`). Worth knowing that auto-connect is one of the
		// ordinary ways to arrive there, without the user having touched anything.
		//
		// It gets there optimistically: the restore publishes `connected` from what it remembered and
		// then corrects itself from the wallet's real answer. Nothing can act in between, but a
		// subscriber does see both, which is why it is written down.
		wallet = installLockableWallet({uuid: 'uuid-l', name: WALLET_NAME, rdns: 'com.example.locked'});
		wallet.lockSilently();
		rememberWallet();

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(3000);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().wallet.status).toBe('locked');
		expect(snapshot().account.address).toBe(ACCOUNT);
		// Still no password prompt on page load: arriving at a page must not raise a wallet popup.
		expect(wallet.requestAccountsCalls()).toBe(0);
	});

	it('restores a hosted session with no wallet involved at all', async () => {
		// The other kind of returning user: signed in through the popup, with a session account in
		// storage and no wallet to wait for. It resolves without any EIP-6963 announcement.
		rememberHostedAccount();

		const connection = createConnection({walletHost: 'https://wallet.example.com', chainInfo});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(500);

		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().wallet).toBeUndefined();
		expect(snapshot().mechanism).toEqual({type: 'email'});
	});

	it('restores a chosen-for-reads wallet without connecting it', async () => {
		// The `WalletChosen` shape: the wallet is the read provider again on the next page load,
		// still with no accounts requested and signing still refused.
		wallet = installLockableWallet({uuid: 'uuid-c', name: WALLET_NAME, rdns: 'com.example.chosen'});
		localStorage.setItem('__last_wallet', JSON.stringify({type: 'wallet', name: WALLET_NAME}));
		sessionStorage.setItem('__last_wallet', JSON.stringify({type: 'wallet', name: WALLET_NAME}));

		const connection = createConnection({chainInfo, targetStep: 'WalletChosen', prioritizeWalletProvider: true});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(500);

		expect(snapshot().step).toBe('WalletChosen');
		expect(snapshot().wallet.status).toBe('disconnected');
		// Neither question was asked: not the prompt, and not the silent one either. That is the
		// whole promise of this shape, and asserting only the prompt would miss half of it.
		expect(wallet.requestAccountsCalls()).toBe(0);
		expect(wallet.getAccountsCalls()).toBe(0);
	});

	it('does nothing at all when the app turned auto-connect off', async () => {
		// An app that wants the first move to be the user's. It must not read the wallet, and it
		// must still finish loading, or the UI waits for something that is never coming.
		wallet = installLockableWallet({uuid: 'uuid-n', name: WALLET_NAME, rdns: 'com.example.no'});
		rememberWallet();

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(500);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().loading).toBe(false);
		expect(wallet.requestAccountsCalls()).toBe(0);
	});

	it('rests when nothing was remembered', async () => {
		wallet = installLockableWallet({uuid: 'uuid-f', name: WALLET_NAME, rdns: 'com.example.fresh'});

		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(500);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().loading).toBe(false);
	});
});
