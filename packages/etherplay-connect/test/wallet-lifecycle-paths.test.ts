// The lifecycle paths around a live wallet: locking, unlocking, switching wallet, asking for the
// sign-in signature twice, and what the store reports as "target reached".
//
// These are the paths where the store and the always-on wrapper have to stay in agreement about
// which wallet is live, which is the seam every bug in this file's history has come through. They
// are also the ones a user reaches by fiddling with their wallet rather than with the app, so
// nothing about them is exotic.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, isTargetStepReached, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SECOND_ACCOUNT = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';

describe('wallet lifecycle', () => {
	let wallet: LockableWallet | undefined;
	let other: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		wallet?.uninstall();
		other?.uninstall();
		wallet = other = undefined;
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

	describe('locking', () => {
		it('notices a lock the wallet never announced, by asking', async () => {
			// MetaMask does not emit `accountsChanged` when the user locks it, so the connection
			// polls `eth_accounts` as well. Without that, an app keeps offering to send from a wallet
			// that will refuse everything, and the user is told nothing.
			wallet = installLockableWallet({uuid: 'uuid-q', name: 'Quiet Wallet', rdns: 'com.example.quiet'});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Quiet Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;
			expect(snapshot().wallet.status).toBe('connected');

			// Locked WITHOUT announcing it: the fixture's silent lock.
			wallet.lockSilently();
			await vi.advanceTimersByTimeAsync(1500);

			expect(snapshot().wallet.status).toBe('locked');
		});

		it('refuses to unlock what is not locked', async () => {
			wallet = installLockableWallet({uuid: 'uuid-u', name: 'Unlock Wallet', rdns: 'com.example.unlock'});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});

			// No wallet at all.
			await expect(connection.unlock()).rejects.toThrow('invalid state');

			const connecting = connection.connect({type: 'wallet', name: 'Unlock Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			// A wallet, but a perfectly usable one: there is nothing to unlock.
			await expect(connection.unlock()).rejects.toThrow('invalid state');
		});

		it('stops saying it is unlocking when the user dismisses the prompt', async () => {
			// `unlocking: true` is what a consumer renders a spinner from. If a refusal left it set,
			// the app would sit there claiming to be waiting on a prompt that is gone.
			wallet = installLockableWallet({uuid: 'uuid-r', name: 'Refusing Wallet', rdns: 'com.example.refusing'});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Refusing Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			wallet.lock();
			await vi.advanceTimersByTimeAsync(50);
			expect(snapshot().wallet.status).toBe('locked');
			expect(snapshot().wallet.unlocking).toBe(false);

			wallet.rejectRequestAccounts(Object.assign(new Error('User rejected the request'), {code: 4001}));
			await connection.unlock();
			await vi.advanceTimersByTimeAsync(50);

			expect(snapshot().wallet.status).toBe('locked');
			expect(snapshot().wallet.unlocking).toBe(false);
		});
	});

	describe('following the account the user picked', () => {
		it('follows a switch when the app asked to, instead of reporting it', async () => {
			// `useCurrentAccount` is the app saying "whatever they pick is who they are". Without it
			// the switch is REPORTED (`accountChanged`) and the app offers the move; with it the
			// connection just moves.
			wallet = installLockableWallet({uuid: 'uuid-f', name: 'Follow Wallet', rdns: 'com.example.follow'});
			const connection = createConnection({
				chainInfo,
				targetStep: 'WalletConnected',
				autoConnect: false,
				useCurrentAccount: 'always',
			});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Follow Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;
			expect(snapshot().account.address).toBe(ACCOUNT);

			wallet.switchAccount(SECOND_ACCOUNT);
			await vi.advanceTimersByTimeAsync(200);

			expect(snapshot().account.address).toBe(SECOND_ACCOUNT);
			expect(snapshot().wallet.status).toBe('connected');
			expect(snapshot().wallet.accountChanged).toBeUndefined();
		});
	});

	describe('switching wallet', () => {
		it('stops watching the old wallet when a new one is chosen', async () => {
			// Both wallets stay installed, so the old one can still shout. If its listeners were left
			// attached, its `accountsChanged` would rewrite the state of a connection that has moved
			// on: the user would see the wallet they left driving the app they are using.
			wallet = installLockableWallet({uuid: 'uuid-1', name: 'First Wallet', rdns: 'com.example.first'});
			other = installLockableWallet({
				uuid: 'uuid-2',
				name: 'Second Wallet',
				rdns: 'com.example.second',
				accounts: [SECOND_ACCOUNT],
			});
			const connection = createConnection({chainInfo, targetStep: 'WalletChosen', autoConnect: false});
			const snapshot = snapshotOf(connection);

			await connection.selectWallet('First Wallet');
			await vi.advanceTimersByTimeAsync(100);
			expect(snapshot().mechanism.name).toBe('First Wallet');

			await connection.selectWallet('Second Wallet');
			await vi.advanceTimersByTimeAsync(100);
			expect(snapshot().mechanism.name).toBe('Second Wallet');

			// The wallet that was left has nobody listening to it any more.
			expect(wallet.listenerCount('accountsChanged')).toBe(0);
			expect(wallet.listenerCount('chainChanged')).toBe(0);
		});

		it('comes to rest, and drops the wallet, when the chosen one cannot answer', async () => {
			wallet = installLockableWallet({uuid: 'uuid-b', name: 'Broken Wallet', rdns: 'com.example.broken'});
			wallet.setChainIdFailure(true);
			const connection = createConnection({chainInfo, targetStep: 'WalletChosen', autoConnect: false});
			const snapshot = snapshotOf(connection);

			await connection.selectWallet('Broken Wallet');
			await vi.advanceTimersByTimeAsync(200);

			expect(snapshot().error?.message).toContain('failed to select wallet Broken Wallet');
			expect(snapshot().wallet).toBeUndefined();
		});
	});

	describe('asking for the sign-in signature', () => {
		it('refuses from a step where there is nothing to sign for', async () => {
			wallet = installLockableWallet({uuid: 'uuid-s', name: 'Sig Wallet', rdns: 'com.example.sig'});
			const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});

			await expect(connection.requestSignature()).rejects.toThrow('invalid step');
		});

		it('lets a second request replace the first, without reporting the replacement as a failure', async () => {
			// Two requests can be in flight when a user clicks twice, or when an app retries. The
			// first is abandoned deliberately, so it must not land as an error on the state: the user
			// did not refuse anything, and a banner saying they did would be a lie.
			wallet = installLockableWallet({uuid: 'uuid-s', name: 'Sig Wallet', rdns: 'com.example.sig'});
			const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Sig Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			// Hold the wallet inside `personal_sign` so both requests are outstanding at once.
			let release: (() => void) | undefined;
			wallet.whileSigning = () => {
				if (!release) {
					const held = new Promise<void>((resolve) => (release = resolve));
					return held;
				}
				return undefined;
			};

			const first = connection.requestSignature();
			await vi.advanceTimersByTimeAsync(10);
			const second = connection.requestSignature();
			await vi.advanceTimersByTimeAsync(10);
			release?.();
			await vi.advanceTimersByTimeAsync(200);
			await Promise.all([first, second]);

			// Whatever happened between them, the user is signed in and nothing claims a failure.
			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().error).toBeUndefined();
		});
	});

	describe('is the target reached', () => {
		it('answers for the configured target, from the store and from the free function', async () => {
			// Consumers branch on this rather than on the step name, so it has to agree with itself:
			// the store's method and the exported guard are the same question asked twice.
			wallet = installLockableWallet({uuid: 'uuid-t', name: 'Target Wallet', rdns: 'com.example.target'});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
			const snapshot = snapshotOf(connection);

			expect(connection.isTargetStepReached(snapshot())).toBe(false);
			expect(isTargetStepReached(snapshot(), 'WalletConnected')).toBe(false);

			const connecting = connection.connect({type: 'wallet', name: 'Target Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			expect(connection.isTargetStepReached(snapshot())).toBe(true);
			expect(isTargetStepReached(snapshot(), 'WalletConnected')).toBe(true);
			// A lower target is satisfied by a higher state, which is what lets a read-only consumer
			// share a connection with one that signs.
			expect(isTargetStepReached(snapshot(), 'WalletChosen')).toBe(true);
			// And the higher one is not satisfied by this.
			expect(isTargetStepReached(snapshot(), 'SignedIn')).toBe(false);
		});

		it('requires a wallet for a SignedIn target when the connection is wallet-only', async () => {
			// `walletOnly` narrows what counts: a hosted account reaching `SignedIn` does not satisfy
			// a connection that exists to have a wallet behind it.
			wallet = installLockableWallet({uuid: 'uuid-w', name: 'Wallet Only', rdns: 'com.example.wo'});
			const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Wallet Only'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;
			const signing = connection.requestSignature();
			await vi.advanceTimersByTimeAsync(200);
			await signing;

			expect(snapshot().step).toBe('SignedIn');
			expect(connection.isTargetStepReached(snapshot())).toBe(true);
			// The same state, judged as if the wallet were not required.
			expect(isTargetStepReached(snapshot(), 'SignedIn')).toBe(true);
		});
	});
});
