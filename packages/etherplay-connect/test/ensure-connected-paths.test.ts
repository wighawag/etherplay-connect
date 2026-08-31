// `ensureConnected`'s argument forms and its waiting conditions.
//
// It is the promise-shaped entry point, so the parts nothing exercised are the ones a consumer
// reaches by calling it the OTHER way round: with a step first, with a mechanism first, or with
// only options. Those overloads are hand-parsed from `arguments`, which is exactly the kind of code
// that keeps working until somebody reorders a branch.
//
// The second half is about when it must NOT resolve. `ensureConnected` promises a usable connection
// at a target step, and "connected to the wrong chain" is not that, so it waits rather than handing
// back something the caller cannot send with.
//
// Deliberately not covered, per the stopping rule in `work/notes/observations`: the `if (settled)`
// re-entry guards inside the subscription. Their false side needs two settlements racing, and a
// test for them would assert the shape of the code rather than anything a consumer can observe.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const PAGE_ORIGIN = 'http://localhost:3000';

describe('ensureConnected: argument forms and waiting conditions', () => {
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

	function install(options?: {chainId?: string; second?: boolean}) {
		wallet = installLockableWallet({
			uuid: 'uuid-main',
			name: 'Main Wallet',
			rdns: 'com.example.main',
			chainId: options?.chainId,
		});
		if (options?.second) {
			other = installLockableWallet({uuid: 'uuid-other', name: 'Other Wallet', rdns: 'com.example.other'});
		}
	}

	function connectionFor(targetStep: 'WalletChosen' | 'WalletConnected') {
		const connection = createConnection({chainInfo, targetStep, autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		return {connection, snapshot};
	}

	describe('the argument forms', () => {
		it('takes a step and a mechanism, with two wallets installed so the name has to be used', async () => {
			// Two wallets on purpose: with one, any argument-parsing bug is hidden by the
			// single-wallet fallback, and the test would pass while reading nothing.
			install({second: true});
			const {connection, snapshot} = connectionFor('WalletConnected');

			const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().mechanism.name).toBe('Other Wallet');
		});

		it('takes a step and options, with no mechanism between them', async () => {
			// The form that made the parsing non-trivial: the second argument may be EITHER a mechanism
			// or options, told apart by whether it has a `type`.
			//
			// Asserted with an option that CHANGES THE OUTCOME rather than one that merely leaves a
			// trace. On the wrong chain, `ensureConnected` waits (the test below proves it), so if this
			// argument were mistaken for a mechanism, or dropped, this call would never resolve. An
			// assertion that passes whether or not the option arrived is worse than no assertion.
			install({chainId: '0x89'});
			const {connection, snapshot} = connectionFor('WalletConnected');

			const ensuring = connection.ensureConnected('WalletConnected', {skipChainCheck: true});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().wallet.invalidChainId).toBe(true);
		});

		it('remembers the wallet even under doNotStoreLocally, which covers the origin account only', async () => {
			// Pinned because it is easy to assume the opposite, and I did while writing the test above.
			// The README says it outright ("`doNotStoreLocally` does not cover the last wallet"): the
			// wallet is a useful hint next time, and namespacing keeps it from colliding, so the remedy
			// for not remembering a wallet is `disconnect()` rather than this option.
			install();
			const {connection} = connectionFor('WalletConnected');

			const ensuring = connection.ensureConnected('WalletConnected', {doNotStoreLocally: true});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(JSON.parse(localStorage.getItem('__last_wallet')!)).toMatchObject({
				type: 'wallet',
				name: 'Main Wallet',
			});

			// And `disconnect()` is what actually clears it.
			connection.disconnect();
			expect(localStorage.getItem('__last_wallet')).toBeNull();
		});

		it('takes a mechanism on its own, defaulting the step to the configured target', async () => {
			install({second: true});
			const {connection, snapshot} = connectionFor('WalletConnected');

			const ensuring = connection.ensureConnected({type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().mechanism.name).toBe('Other Wallet');
		});

		it('passes a named mechanism on to selectWallet for a WalletChosen target', async () => {
			// The `WalletChosen` target does not connect: it picks a wallet for READS. So the name
			// has to travel to `selectWallet`, and nothing may prompt for accounts.
			install({second: true});
			const {connection, snapshot} = connectionFor('WalletChosen');

			const ensuring = connection.ensureConnected('WalletChosen', {type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(snapshot().step).toBe('WalletChosen');
			expect(snapshot().mechanism.name).toBe('Other Wallet');
			expect(other!.requestAccountsCalls()).toBe(0);
		});
	});

	describe('when it must not resolve yet', () => {
		it('waits for the chain, rather than handing back a connection that cannot send', async () => {
			// A wallet on the wrong chain IS connected, so the step matches, but `ensureConnected`
			// promises a usable connection at that step and this one would reject every transaction.
			// So it waits, and the user switching chain in their wallet is what resolves it.
			install({chainId: '0x89'}); // Polygon, not the chain this connection is for
			const {connection, snapshot} = connectionFor('WalletConnected');

			let resolved = false;
			const ensuring = connection.ensureConnected().then((v) => {
				resolved = true;
				return v;
			});
			await vi.advanceTimersByTimeAsync(200);

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().wallet.invalidChainId).toBe(true);
			expect(resolved).toBe(false);

			wallet!.setChainId('0x1');
			await vi.advanceTimersByTimeAsync(50);
			await ensuring;

			expect(resolved).toBe(true);
			expect(snapshot().wallet.invalidChainId).toBe(false);
		});

		it('resolves on the wrong chain when the caller says the chain does not matter', async () => {
			// `skipChainCheck` is for callers that only need an address: a signature over text is
			// chain-independent, so waiting for a switch would block them on nothing.
			install({chainId: '0x89'});
			const {connection, snapshot} = connectionFor('WalletConnected');

			const ensuring = connection.ensureConnected({skipChainCheck: true});
			await vi.advanceTimersByTimeAsync(200);
			await ensuring;

			expect(snapshot().wallet.invalidChainId).toBe(true);
		});

		it('accepts a merely-chosen wallet for a WalletChosen target', async () => {
			// The lower target is satisfied by the lower state: `WalletChosen` resolves as itself,
			// without waiting for a connection that a read-only consumer never wanted.
			install();
			const {connection, snapshot} = connectionFor('WalletChosen');

			await connection.selectWallet('Main Wallet');
			await vi.advanceTimersByTimeAsync(100);
			expect(snapshot().step).toBe('WalletChosen');

			const ensuring = connection.ensureConnected();
			await vi.advanceTimersByTimeAsync(50);
			const result = await ensuring;

			expect(result.step).toBe('WalletChosen');
			expect(wallet!.requestAccountsCalls()).toBe(0);
		});
	});
});
