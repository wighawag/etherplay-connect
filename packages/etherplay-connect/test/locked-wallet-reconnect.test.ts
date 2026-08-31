// What happens to a wallet the user has LOCKED while it is still holding a request.
//
// This is the ordinary flow, not an exotic one: a send against a locked wallet raises the
// connection flow, so the app re-enters `connect`/`ensureConnected` while the user's wallet is
// holding the transaction. Both bugs below were found from the consumer side, in that exact
// window, and neither is visible from inside a test that cannot lock a wallet mid-request.
//
// See `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: a request the user
// must answer and the app cannot see is a request nothing can explain, cancel or recover from.

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

describe('a locked wallet that is still holding a request', () => {
	let wallet: LockableWallet | undefined;
	let otherWallet: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		wallet?.uninstall();
		otherWallet?.uninstall();
		wallet = undefined;
		otherWallet = undefined;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	/**
	 * A connection on a wallet that is holding a transaction and has since been locked.
	 *
	 * TWO wallets are announced on purpose. With one, `connect()` falls back to "the only wallet
	 * there is" and reconnects by accident; with two it has to derive the name from the state, and
	 * that is the path the consumer reported. A real user with MetaMask and Rabby installed is in
	 * the second case, not the first.
	 */
	async function lockedWhileHoldingATransaction() {
		wallet = installLockableWallet({uuid: 'uuid-stalling', name: 'Stalling Test Wallet', rdns: 'com.example.stalling'});
		otherWallet = installLockableWallet({uuid: 'uuid-other', name: 'Other Wallet', rdns: 'com.example.other'});

		const connection = createConnection({
			chainInfo,
			targetStep: 'WalletConnected',
			autoConnect: false,
		});

		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'wallet', name: 'Stalling Test Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		expect(snapshot().step).toBe('WalletConnected');

		// Parked in the wallet, and it stays parked for the whole test: the user never answers it.
		const sending = connection.provider
			.request({method: 'eth_sendTransaction', params: [{from: ACCOUNT, to: ACCOUNT}]} as any)
			.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet?.pendingRequests).toHaveLength(1);

		// The user locks their wallet with the prompt still on screen.
		wallet.lock();
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet?.status).toBe('locked');

		return {connection, snapshot, wallet: wallet!, sending};
	}

	// THE THREE ENTRY POINTS MEAN THREE DIFFERENT THINGS ON A LOCKED WALLET, deliberately. They are
	// pinned together, in order, because the asymmetry is the kind that reads as a bug from outside
	// (a consumer's navbar calls `connect()` and its Send path calls `ensureConnected()`), and the
	// obvious "fix" is to collapse one into another. Each of these tests fails if you do.
	//
	// What made the asymmetry look destructive was a SEPARATE defect, now fixed: the picker tears the
	// live wallet down, and the teardown used to erase the announcement of whatever that wallet was
	// still holding. Every one of these tests keeps a transaction parked throughout and asserts the
	// announcement survives, which is what makes the difference between them a UX choice rather than
	// a data loss.

	it('connect() means the user is choosing, so a bare call opens the picker even on a locked wallet', async () => {
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		const connecting = connection.connect();
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// The picker, with the wallet torn down: `connect` drives the flow from the user's choice and
		// nothing here names a wallet. It does not read `wallet.status` and has no second meaning on a
		// locked one. A consumer that wants the wallet back calls `unlock()` (below), or
		// `ensureConnected()` if what it actually wants is a usable connection.
		expect(snapshot().step).toBe('WalletToChoose');
		expect(snapshot().wallet).toBeUndefined();
		// It did NOT prompt the wallet: nothing was attempted, the user was asked to choose.
		expect(wallet.requestAccountsCalls()).toBe(0);

		// And this is why that is acceptable: the transaction is still in the user's wallet, and the
		// app can still say so, name the account it is waiting on, and offer its escape hatch. Erasing
		// this is what made the picker look like data loss.
		expect(snapshot().pendingRequests).toHaveLength(1);
		expect(snapshot().pendingRequests[0].account).toBe(ACCOUNT);

		// It also still ends when answered, with no wallet in the state at all.
		wallet.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('ensureConnected() promises a usable connection, so it reconnects the locked wallet', async () => {
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		const ensuring = connection.ensureConnected();
		await vi.advanceTimersByTimeAsync(200);
		await ensuring;

		// It cannot hand back a connection the caller can use without doing this, which is exactly why
		// it may do it and `connect()` may not.
		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().mechanism).toMatchObject({type: 'wallet', name: 'Stalling Test Wallet'});
		expect(snapshot().wallet.status).toBe('connected');
		expect(wallet.requestAccountsCalls()).toBe(1);
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});

	it('unlock() is the narrow remedy: it keeps the wallet and the mechanism the state already had', async () => {
		// What a consumer should call when it renders "Unlock" instead of "Connect" on
		// `wallet.status === 'locked'`. It prompts the wallet and rebuilds nothing.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();
		const mechanismBefore = snapshot().mechanism;

		await connection.unlock();
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().wallet.status).toBe('connected');
		expect(snapshot().mechanism).toEqual(mechanismBefore);
		expect(wallet.requestAccountsCalls()).toBe(1);
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});

	// ISSUE 2. The 0.10.0 fix taught every `wallet: {...}` rebuild to copy the live list from the
	// wrapper. It does nothing for the paths that build NO wallet at all, and those are on the same
	// road: `connect` sets `wallet: undefined` on entry, and `setConnectionFailure` tears the wallet
	// down entirely. The list is the only announcement that the user's wallet is holding something,
	// so while `wallet` is undefined there is nowhere left to read it from — even though the
	// wrapper still has it and the wallet is still holding it.
	it('never stops announcing the parked request, at any point during the reconnect', async () => {
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		// Every state the store publishes during the reconnect, not just the one at the end: the
		// window where this went missing is transient on the success path, and a check at either
		// end passes against the bug.
		const announcedDuring: number[] = [];
		const unsubscribe = connection.subscribe((state) => {
			announcedDuring.push(state.pendingRequests.length);
		});

		const reconnecting = connection.connect();
		await vi.advanceTimersByTimeAsync(200);
		await reconnecting;
		unsubscribe();

		expect(announcedDuring.length).toBeGreaterThan(1);
		expect(announcedDuring.every((n) => n === 1)).toBe(true);

		wallet.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		// And it still clears when answered: a request that never leaves the list is a modal that
		// never closes, which is the failure this must not trade itself for.
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('still announces the parked request after a FAILED reconnect', async () => {
		// The success path above is transient. This one is not: the flow comes to REST on a step
		// with `wallet: undefined` while the user's wallet is still holding the transaction, and it
		// stays there for as long as the user leaves it. That is the original bug's user-visible
		// symptom reached by a different route, and it is the case that makes `pendingRequests` a
		// property of the WRAPPER rather than of any particular wallet state.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		wallet.rejectRequestAccounts(Object.assign(new Error('User rejected the request'), {code: 4001}));

		// Through `ensureConnected`, because that is the entry point that ATTEMPTS a reconnect and so
		// the one that can fail one. The user refuses the password prompt.
		const reconnecting = expect(connection.ensureConnected()).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(200);
		await reconnecting;

		// The failure did what it is supposed to do: no wallet is left routing requests.
		expect(snapshot().wallet).toBeUndefined();
		expect(snapshot().error).toBeDefined();

		// But the transaction is still in the user's wallet, so the app can still say so.
		expect(snapshot().pendingRequests).toHaveLength(1);
		expect(snapshot().pendingRequests[0].kind).toBe('transaction');
		expect(snapshot().pendingRequests[0].account).toBe(ACCOUNT);

		wallet.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('announces the parked request beside a wallet that is present too', async () => {
		// The connection-level list is not a fallback for when `wallet` is missing: it is where the
		// list lives now. It has to be right in both cases, or a consumer would have to read two
		// places and decide which one to believe.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		expect(snapshot().wallet).toBeDefined();
		expect(snapshot().pendingRequests).toHaveLength(1);
		// The deprecated mirror still agrees, so consumers can migrate on their own schedule.
		expect(snapshot().wallet.pendingRequests).toEqual(snapshot().pendingRequests);

		wallet.releaseTransaction();
		await sending;
	});

	it('keeps the wallet object identity when a publish does not change the list', async () => {
		// `set` re-reads the wrapper on EVERY publish, so it must not hand back a new `wallet` object
		// each time: consumers key `derived` stores, `{#key}` blocks and effects off it, and rebuilding
		// it on unrelated publishes would re-run all of them on request churn.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		const before = snapshot();
		connection.clearError();
		const after = snapshot();

		expect(after).not.toBe(before); // the connection object is new, as a publish should be
		expect(after.wallet).toBe(before.wallet);
		expect(after.pendingRequests).toBe(before.pendingRequests);

		// And it DOES change when the list changes, or the announcement would not reach anyone.
		wallet.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().pendingRequests).not.toBe(before.pendingRequests);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('still announces requests made after a disconnect and a reconnect', async () => {
		// `disconnect()` used to unsubscribe from the wrapper's request events, and nothing
		// re-subscribes, so it silenced announcements for the REST OF THE CONNECTION'S LIFE. Nothing
		// is parked here on purpose: the bug is about requests made LATER, so a test that parks one
		// first would pass either way (the disconnect publish re-reads the wrapper and reports it).
		wallet = installLockableWallet({uuid: 'uuid-stalling', name: 'Stalling Test Wallet', rdns: 'com.example.stalling'});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'wallet', name: 'Stalling Test Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		connection.disconnect();
		await vi.advanceTimersByTimeAsync(50);

		const reconnecting = connection.connect({type: 'wallet', name: 'Stalling Test Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await reconnecting;
		expect(snapshot().step).toBe('WalletConnected');

		const sending = connection.provider
			.request({method: 'eth_sendTransaction', params: [{from: ACCOUNT, to: ACCOUNT}]} as any)
			.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('keeps announcing when the user unlocks the wallet themselves', async () => {
		// The other way out of a locked wallet: the user unlocks the extension directly, so the wallet
		// announces `accountsChanged` and no connection flow runs at all. The list has to survive that
		// too, and by a different route (the event handlers spread the existing wallet state).
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		wallet.unlock();
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().wallet.status).toBe('connected');
		expect(snapshot().pendingRequests).toHaveLength(1);
		// Nothing prompted: the user did it in the wallet, not through us.
		expect(wallet.requestAccountsCalls()).toBe(0);

		wallet.releaseTransaction();
		await sending;
	});

	it('keeps announcing across disconnect(), which does not answer anything either', async () => {
		// `disconnect()` drops the wallet by design. It does not reach into the user's wallet and
		// withdraw a prompt that is already on their screen, so the app must not start claiming
		// nothing is outstanding.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();

		connection.disconnect();
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().step).toBe('Idle');
		expect(snapshot().wallet).toBeUndefined();
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});

	// A REPLAYED ADDRESS IS A PREFERENCE; A CALLER'S ADDRESS IS A DEMAND. The two tests below are a
	// pair and only make sense together.
	//
	// `ensureConnected`'s reconnect replays the whole mechanism, address included, which is what
	// keeps the ordinary case (several accounts, unlock, come back to the same one) from bouncing
	// the user into the account picker. But the user is free to unlock on a DIFFERENT account, and
	// treating the replayed address as a demand then failed the attempt, which landed in the catch
	// and tore the wallet down: the reconnect performed the very teardown it exists to prevent, one
	// step later.
	it('reconnects on the account the user actually unlocked, rather than failing on the old one', async () => {
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();
		const OTHER = '0xb0b0000000000000000000000000000000000b0b' as `0x${string}`;

		wallet.switchAccount(OTHER);
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = connection.ensureConnected();
		await vi.advanceTimersByTimeAsync(200);
		await ensuring;

		// Degraded to an ordinary connect, which is what the caller asked for: it asked to be
		// connected and named no account. The wallet is kept, and the state says who it is now.
		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().wallet).toBeDefined();
		expect(snapshot().mechanism).toMatchObject({type: 'wallet', name: 'Stalling Test Wallet', address: OTHER});
		expect(snapshot().account.address).toBe(OTHER);
		expect(snapshot().error).toBeUndefined();
		// The transaction the OLD account is still holding stays announced, and still says whose it
		// is, which is what `PendingRequest.account` exists for: a consumer must not tell the user
		// to approve it in the account they have just switched to.
		expect(snapshot().pendingRequests).toHaveLength(1);
		expect(snapshot().pendingRequests[0].account).toBe(ACCOUNT);

		wallet.releaseTransaction();
		await sending;
	});

	it('still fails when the CALLER named an address the wallet does not have', async () => {
		// The other half of the pair. `connectToAddress(a)` and `connect({type: 'wallet', address:
		// a})` mean that account and no other, so connecting to a different one would be answering
		// a question nobody asked. Only a REPLAYED address degrades.
		const {connection, snapshot, wallet, sending} = await lockedWhileHoldingATransaction();
		const ABSENT = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as `0x${string}`;

		const connecting = connection.connect({type: 'wallet', name: 'Stalling Test Wallet', address: ABSENT});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(snapshot().error).toBeDefined();
		expect(snapshot().step).not.toBe('WalletConnected');
		// And even a failed attempt keeps announcing what the wallet is holding.
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});
});

describe('a locked wallet under SignedIn', () => {
	// The same three-way split, one step higher, where the difference between the remedies is at its
	// starkest: `unlock()` keeps the sign-in and `connect()` does not, because `connect()` is the
	// user choosing to start over. `ensureConnected()` resolves immediately here rather than doing
	// either, since its target IS satisfied: a signed-in app acts through its session account, which
	// a locked wallet does not invalidate.
	let wallet: LockableWallet | undefined;
	let otherWallet: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		wallet?.uninstall();
		otherWallet?.uninstall();
		wallet = undefined;
		otherWallet = undefined;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	async function signedInWithAParkedTransaction() {
		wallet = installLockableWallet({uuid: 'uuid-stalling', name: 'Stalling Test Wallet', rdns: 'com.example.stalling'});
		otherWallet = installLockableWallet({uuid: 'uuid-other', name: 'Other Wallet', rdns: 'com.example.other'});

		const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'wallet', name: 'Stalling Test Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(snapshot().step).toBe('SignedIn');

		const sending = connection.provider
			.request({method: 'eth_sendTransaction', params: [{from: ACCOUNT, to: ACCOUNT}]} as any)
			.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().pendingRequests).toHaveLength(1);

		return {connection, snapshot, wallet: wallet!, sending};
	}

	it('unlock() keeps the sign-in, the account and the wallet', async () => {
		// THE CALL TO REACH FOR on a locked wallet, and the reason the state publishes
		// `wallet.status`: a consumer renders "Unlock" rather than "Connect" and lands here.
		const {connection, snapshot, wallet, sending} = await signedInWithAParkedTransaction();
		const account = snapshot().account;

		wallet.lock();
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet.status).toBe('locked');

		await connection.unlock();
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().account).toEqual(account);
		expect(snapshot().wallet.status).toBe('connected');
		expect(snapshot().mechanism).toMatchObject({type: 'wallet', name: 'Stalling Test Wallet'});
		expect(wallet.requestAccountsCalls()).toBe(1);
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});

	it('connect() starts over, which costs the sign-in: that is the cost unlock() exists to avoid', async () => {
		// Pinned so the difference is on the record rather than discovered. `connect()` is the user
		// asking to connect something, and from a state where nothing names a wallet that is the
		// picker, which drops the session too. It is the wrong call here, and the README says so; what
		// matters is that it is not DESTRUCTIVE of anything the app still needs to report.
		const {connection, snapshot, wallet, sending} = await signedInWithAParkedTransaction();

		wallet.lock();
		await vi.advanceTimersByTimeAsync(50);

		const connecting = connection.connect();
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(snapshot().step).toBe('WalletToChoose');
		expect(snapshot().wallet).toBeUndefined();
		expect(wallet.requestAccountsCalls()).toBe(0);
		// The transaction is still in the wallet and still announced, so the app can still explain it,
		// cancel it, or warn on unload.
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});

	it('connectToAddress() is the remedy when the user moved to another account', async () => {
		// The other unusable status, where `unlock()` does not apply: the wallet is not locked, it is
		// on an account this connection is not signed in as. `accountChanged` on the state is the
		// affordance for it, and `connectToAddress` reuses the wallet the state names.
		const {connection, snapshot, wallet, sending} = await signedInWithAParkedTransaction();
		const OTHER = '0xb0b0000000000000000000000000000000000b0b' as `0x${string}`;

		wallet.switchAccount(OTHER);
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet.status).toBe('disconnected');
		expect(snapshot().wallet.accountChanged).toBe(OTHER);

		connection.connectToAddress(OTHER);
		await vi.advanceTimersByTimeAsync(200);

		expect(snapshot().step).not.toBe('WalletToChoose');
		expect(snapshot().wallet).toBeDefined();
		expect(snapshot().mechanism).toMatchObject({type: 'wallet', name: 'Stalling Test Wallet', address: OTHER});
		expect(snapshot().pendingRequests).toHaveLength(1);

		wallet.releaseTransaction();
		await sending;
	});
});
