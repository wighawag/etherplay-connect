// `ensureConnected` delivers a TARGET, not a step comparison.
//
// Every test here is a shape a consumer hit while recording, per transaction, which signing route
// produced it. Replacing or cancelling a stuck transaction reuses its ORIGINAL NONCE, so it has to
// be signed by the same key: `ensureConnected('WalletConnected', {type: 'wallet', name, address})`
// means that account and no other, and an answer about a different one is not a smaller version of
// the right answer, it is a wrong one.
//
// The four things pinned here:
//
// 1. An address (or a wallet name) the CALLER passes is part of what satisfies the call. A
//    connection at rest holding somebody else must attempt, not resolve.
// 2. The steps are ordered, so a connection BEYOND the requested step satisfies it.
// 3. Nothing waits unless something is in progress. `ensure-connected-settles.test.ts` is the
//    enumeration; the individual hangs are pinned here.
// 4. An address the wallet cannot offer becomes a resting state the user can read and answer,
//    rather than a throw that tears the wallet down.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, canActAs, ConnectionFailure, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const A = '0xaaaa000000000000000000000000000000000aaa' as `0x${string}`;
const B = '0xbbbb000000000000000000000000000000000bbb' as `0x${string}`;
const NEVER_SEEN = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_HOST = 'https://wallet.example.com';

describe('ensureConnected honours the account the caller named', () => {
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

	function install(options?: {accounts?: `0x${string}`[]; second?: boolean}) {
		wallet = installLockableWallet({
			uuid: 'uuid-main',
			name: 'Main Wallet',
			rdns: 'com.example.main',
			accounts: options?.accounts ?? [A],
		});
		if (options?.second) {
			other = installLockableWallet({
				uuid: 'uuid-other',
				name: 'Other Wallet',
				rdns: 'com.example.other',
				accounts: [B],
			});
		}
	}

	function connectionFor(targetStep: 'WalletChosen' | 'WalletConnected' = 'WalletConnected') {
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

	it('attempts instead of resolving when it is at rest holding a different account', async () => {
		// THE ONE THAT COST A CONSUMER A WRONG-KEY TRANSACTION. The connection is already at the
		// requested step, so the old comparison said yes and handed back account A having done
		// nothing: the address argument was silently conditional on state the caller cannot see.
		install({accounts: [A, B]});
		const {connection, snapshot} = connectionFor();

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		expect(snapshot().account.address).toBe(A);

		const result = await (async () => {
			const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B});
			await vi.advanceTimersByTimeAsync(200);
			return ensuring;
		})();

		expect(result.account.address).toBe(B);
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().mechanism.address).toBe(B);
	});

	it('resolves instantly, and prompts nothing, when it is already on the account that was named', async () => {
		// The other half: stricter must not mean noisier. A connection that IS on the account gets
		// the same instant resolve it always did, with no wallet round trip.
		install({accounts: [A]});
		const {connection} = connectionFor();

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const promptsBefore = wallet!.requestAccountsCalls();
		const readsBefore = wallet!.getAccountsCalls();

		const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: A});
		const result = await ensuring;

		expect(result.account.address).toBe(A);
		expect(wallet!.requestAccountsCalls()).toBe(promptsBefore);
		expect(wallet!.getAccountsCalls()).toBe(readsBefore);
	});

	it('matches a CHECKSUMMED address against the account the wallet is holding', async () => {
		// An address arrives checksummed from anything viem produced, and the wallet's accounts are
		// lowercased on the way in. While an unmatched address merely failed the attempt this was a
		// papercut; now that a caller's address is a requirement, it would tell the user to switch to
		// the account they are already on, which is an instruction they cannot carry out.
		//
		// THE ENTRY STATE MATTERS, and the first version of this test got it wrong (found in review):
		// starting from a connection already on that account resolves through `canActAs`, which
		// lowercases internally, so the boundary the fix is about was never reached and the test passed
		// with the fix reverted. It has to force an ATTEMPT, which is what compares the caller's
		// address against the wallet's own list.
		install({accounts: [A]});
		const {connection, snapshot} = connectionFor();
		const checksummed = ('0x' + A.slice(2).toUpperCase()) as `0x${string}`;

		await connection.selectWallet('Main Wallet');
		await vi.advanceTimersByTimeAsync(100);
		expect(snapshot().step).toBe('WalletChosen'); // no account yet, so an attempt must run

		const ensuring = connection.ensureConnected('WalletConnected', {
			type: 'wallet',
			name: 'Main Wallet',
			address: checksummed,
		});
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		expect(result.account.address).toBe(A);
		// Not "switch to the account you are already on".
		expect(snapshot().addressUnavailable).toBeUndefined();
	});

	it('treats a caller-supplied WALLET NAME as part of the target too', async () => {
		// Same argument as the address, one level up: naming a wallet and being handed a different
		// one is an answer to a question nobody asked.
		install({second: true});
		const {connection, snapshot} = connectionFor();

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		expect(snapshot().mechanism.name).toBe('Main Wallet');

		const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Other Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await ensuring;

		expect(snapshot().mechanism.name).toBe('Other Wallet');
		expect(snapshot().account.address).toBe(B);
	});

	it('asks the wallet to unlock when the account it is asked for is the one it is holding', async () => {
		// A locked wallet keeps `step: 'WalletConnected'` and its `account`, so nothing about the
		// connection's own fields says it cannot sign. `ensureConnected` is the one call that has to
		// know the difference, because it promises the connection can ACT as that address.
		install({accounts: [A]});
		const {connection, snapshot} = connectionFor();

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		wallet!.lock();
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet.status).toBe('locked');
		expect(snapshot().account.address).toBe(A); // still says A, and cannot sign as A

		const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		expect(result.account.address).toBe(A);
		expect(snapshot().wallet.status).toBe('connected');
		expect(wallet!.requestAccountsCalls()).toBe(1);
	});

	it('does not overrule the caller with the address it replayed from its own state', async () => {
		// `mechanismToReconnect` replays the whole mechanism, address included, which is right when
		// nobody named one. It used to replay it OVER the caller's, which lost the requirement at the
		// exact moment the caller most needed it: the reconnect came back on the stored account and
		// the address that was passed in was never looked at again.
		install({accounts: [A, B]});
		const {connection, snapshot} = connectionFor();

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		wallet!.lock();
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', address: B});
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		// B, not the replayed A: the caller's address wins, and the replayed WALLET NAME is still
		// reused (nothing named one, and it is the wallet this connection is on).
		expect(result.account.address).toBe(B);
		expect(snapshot().mechanism).toMatchObject({type: 'wallet', name: 'Main Wallet', address: B});
	});
});

/** Did this promise settle yet? Asked without awaiting it, which is the whole question here. */
function watch<T>(promise: Promise<T>) {
	const result: {settled: 'no' | 'resolved' | 'rejected'; value?: T; error?: any} = {settled: 'no'};
	promise.then(
		(value) => {
			result.settled = 'resolved';
			result.value = value;
		},
		(error) => {
			result.settled = 'rejected';
			result.error = error;
		},
	);
	return result;
}

describe('ensureConnected treats the steps as ordered', () => {
	let wallet: LockableWallet | undefined;
	let originalOpen: typeof window.open;
	let openedUrls: string[] = [];

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
		wallet?.uninstall();
		wallet = undefined;
		(window as any).open = originalOpen;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('resolves a SignedIn connection asked for WalletConnected, rather than hanging', async () => {
		// `SignedIn` implies `WalletConnected`. The old check got that right for `WalletChosen` and
		// then compared the other two exactly, which did not answer wrong so much as never answer:
		// nothing satisfied it, nothing was initiated, and the promise sat there forever.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		const ensuring = connection.ensureConnected('WalletConnected');
		await vi.advanceTimersByTimeAsync(50);
		const result = await ensuring;

		expect(result.step).toBe('SignedIn');
		expect((result as any).wallet).toBeDefined();
	});

	it('asks for the signature, rather than reconnecting, when only the signature is missing', async () => {
		// `requestSignatureRightAway` used to be ignored unless a connect happened, so from an
		// already-connected wallet the option did nothing and the call rested on the app's own button.
		// Untested until review pointed it out, despite being a headline claim.
		//
		// The assertion that matters is the SECOND one: reconnecting would also reach `SignedIn`, and
		// would prompt the wallet twice to do it.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const promptsBefore = wallet.requestAccountsCalls();

		const readsBefore = wallet.getAccountsCalls();

		const ensuring = connection.ensureConnected('SignedIn', undefined, {requestSignatureRightAway: true});
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		expect(result.step).toBe('SignedIn');
		// `eth_accounts`, not `eth_requestAccounts`, is what discriminates: an already-connected wallet
		// is never PROMPTED by a reconnect, so counting prompts cannot tell a reconnect from the narrow
		// remedy — the first version of this assertion was vacuous for exactly that reason (found in
		// review). A reconnect re-reads the accounts; asking for the signature does not.
		expect(wallet.getAccountsCalls()).toBe(readsBefore);
		expect(wallet.requestAccountsCalls()).toBe(promptsBefore);
	});

	it('answers instead of waiting for a signature the user could no longer be asked for', async () => {
		// FOUND BY REVIEW. "The app has not asked for the signature yet" was returned for any
		// `WalletConnected` state under a `SignedIn` target, without checking that the connection could
		// still sign. So a wallet that moved account after connecting left the call waiting on a remedy
		// that no longer existed: `requestSignature()` would have prompted for the wrong account, and
		// nothing else was coming. A wait whose named remedy cannot be taken is not a wait.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// Waiting legitimately at first: the app renders its own "sign in" button.
		const ensuring = watch(connection.ensureConnected('SignedIn'));
		await vi.advanceTimersByTimeAsync(200);
		expect(ensuring.settled).toBe('no');

		// The user switches account in the wallet: nobody can be asked to sign as the old one.
		wallet.switchAccount(B);
		await vi.advanceTimersByTimeAsync(200);

		expect(ensuring.settled).toBe('rejected');
		expect((ensuring.error as Error).message).toContain('could not reach SignedIn');
	});

	it('connects a wallet for a HOSTED sign-in asked for WalletConnected, which costs the session', async () => {
		// Pinned because it is a real cost, not because it is pleasant. A hosted (email/oauth) sign-in
		// carries no wallet, so it satisfies `SignedIn` and nothing below it, and the only way to reach
		// a wallet target from there is to connect a wallet, which replaces the state and the session
		// with it. The alternative was what this used to do: nothing at all, forever. An answer that
		// costs a session beats a promise that never settles, and an app that does not want the cost
		// should not be asking a hosted connection for a wallet.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
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
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {
					id,
					result: {
						address: B,
						signer: {
							origin: PAGE_ORIGIN,
							address: B,
							publicKey: `0x${'cd'.repeat(33)}`,
							privateKey: `0x${'ef'.repeat(32)}`,
						},
						metadata: {},
						mechanismUsed: {type: 'email'},
						savedDelegations: [],
					},
				},
				origin: WALLET_HOST,
			}),
		);
		await vi.advanceTimersByTimeAsync(50);
		await connecting;
		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().wallet).toBeUndefined();

		const ensuring = (connection.ensureConnected as any)('WalletConnected');
		await vi.advanceTimersByTimeAsync(300);
		const result = await ensuring;

		expect(result.step).toBe('WalletConnected');
		expect(result.account.address).toBe(A);
	});

	it('does not report failure about an attempt it has just started and is about to finish', async () => {
		// FOUND BY REVIEW, not by me, and it is the sharpest failure this rework could produce: an
		// answer that is WRONG rather than absent.
		//
		// "Nothing is in progress" was inferred from the published state. `connect` publishes
		// `WaitingForWalletConnection` before its first await, so that inference held for it — but
		// `selectWallet` awaits `getChainId` before publishing anything at all. In that window the store
		// still showed the entry state, so the call rejected with "the connection is at SignedIn and
		// nothing is in progress" while the `selectWallet` it had just started went on to reach
		// `WalletChosen`. The caller was told it had failed by a call that then succeeded.
		//
		// The fix is to stop inferring: an attempt this call started and has not seen come back IS
		// something in progress, whatever the store is showing.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const other = installLockableWallet({uuid: 'uuid-other', name: 'Other Wallet', rdns: 'com.example.other'});
		const connection = createConnection({chainInfo, targetStep: 'WalletChosen', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		try {
			// At rest on one wallet, asked for another: the target is unsatisfied, so an attempt starts,
			// and the entry state is not `Idle`, which is what used to leave the answer branch unguarded.
			await connection.selectWallet('Main Wallet');
			await vi.advanceTimersByTimeAsync(100);
			expect(snapshot().mechanism.name).toBe('Main Wallet');

			const ensuring = connection.ensureConnected('WalletChosen', {type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			const result = await ensuring;

			expect(result.step).toBe('WalletChosen');
			expect((result as any).mechanism.name).toBe('Other Wallet');
			// And the store agrees: the failure it used to report was about work that succeeded.
			expect(snapshot().mechanism.name).toBe('Other Wallet');
		} finally {
			other.uninstall();
		}
	});

	it('upgrades a merely-CHOSEN wallet when asked to connect, rather than hanging', async () => {
		// `WalletChosen` is a resting step, and it is not a picker: the user has chosen. Nothing was
		// in progress and nothing was initiated, so this was the same silent wait by another route.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});

		await connection.selectWallet('Main Wallet');
		await vi.advanceTimersByTimeAsync(100);

		const ensuring = connection.ensureConnected('WalletConnected');
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		expect(result.step).toBe('WalletConnected');
		expect(result.account.address).toBe(A);
	});
});

describe('an address the wallet cannot offer is a state the user can answer', () => {
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

	function connectedAsA() {
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		return {connection, snapshot};
	}

	it('rests a structured state naming both accounts, and leaves the wallet up', async () => {
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);

		// Not settled: there is a remedy, and only the user can apply it.
		expect(ensuring.settled).toBe('no');

		// Everything the app needs to write the instruction, without inventing any of it.
		expect(snapshot().addressUnavailable).toMatchObject({
			requested: NEVER_SEEN,
			walletName: 'Main Wallet',
			selected: A,
			available: [A],
		});
		expect(typeof snapshot().addressUnavailable.message).toBe('string');
		expect(snapshot().addressUnavailable.message).toContain(NEVER_SEEN);
		expect(snapshot().addressUnavailable.message).toContain(A);

		// NOT A TEARDOWN. Failing the attempt would have landed on a state with `wallet: undefined`,
		// leaving the user with no wallet at all over a wallet that works and is merely on another
		// account. Connected-as-somebody-else-and-saying-so is the better ending.
		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().wallet).toBeDefined();
		expect(snapshot().wallet.status).toBe('connected');
		expect(snapshot().account.address).toBe(A);
		// And it is not an error: an app rendering `error` must not paint this red.
		expect(snapshot().error).toBeUndefined();

		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(50);
		expect(ensuring.settled).toBe('rejected');
	});

	it('settles as a CANCELLATION when the user acknowledges it', async () => {
		// The shape matters as much as the settling: consumers already map "Connection cancelled" to
		// "the user chose not to", so this needs no new branch anywhere and produces no red banner
		// for a decision.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = connection.ensureConnected('WalletConnected', {
			type: 'wallet',
			name: 'Main Wallet',
			address: NEVER_SEEN,
		});
		const rejection = expect(ensuring).rejects.toMatchObject({
			name: 'ConnectionFailure',
			message: 'Connection cancelled',
		});
		await vi.advanceTimersByTimeAsync(200);

		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(50);
		await rejection;

		await expect(ensuring.catch((err) => err instanceof ConnectionFailure)).resolves.toBe(true);
		// The reason is gone, and the connection is still usable.
		expect(snapshot().addressUnavailable).toBeUndefined();
		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().wallet).toBeDefined();
	});

	it('carries on with the original request when the user switches to that account in the wallet', async () => {
		// Somebody who has just done what was asked should not then have to press anything in the app.
		//
		// THIS IS THE ONE-ACCOUNT-AT-A-TIME WALLET, which is why the fixture exposes exactly one account
		// and swaps it on switch. MetaMask answers `eth_accounts` with every account the user permitted;
		// Rabby answers with the one it is currently on. So for a large share of users the requested
		// account is NOT in `available` even though they have it, and the only remedy is the one the
		// message asks for: switch in the wallet. What makes that work is `accountsChanged`, which every
		// wallet emits, and which this drives.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(ensuring.settled).toBe('no');
		expect(snapshot().addressUnavailable.requested).toBe(B);
		// `available` is what the wallet is EXPOSING, not what the user owns: one entry here, and the
		// requested account is not in it, while the user is holding it all along. An app must therefore
		// not render this list as an exhaustive picker, and must not read "absent" as "you do not have
		// it". The message is the instruction; the list is only extra detail when there is any.
		expect(snapshot().addressUnavailable.available).toEqual([A]);
		expect(snapshot().addressUnavailable.selected).toBe(A);
		expect(snapshot().addressUnavailable.message).toContain('Switch to that account in the wallet');

		wallet!.switchAccount(B);
		await vi.advanceTimersByTimeAsync(200);

		expect(ensuring.settled).toBe('resolved');
		expect((ensuring.value as any).account.address).toBe(B);
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().addressUnavailable).toBeUndefined();
		// One prompt-free recovery: the user did it in their wallet, so nothing asked them again.
		expect(wallet!.requestAccountsCalls()).toBe(0);
	});

	it('cannot loop: an answer its own attempt disagreed with is not asked about again', async () => {
		// THE HAZARD THE RETRY INTRODUCES: ask, the wallet answers with a different account, ask again.
		//
		// Reaching it needs a wallet whose ANNOUNCEMENT and whose ANSWER disagree, because an honest
		// wallet that announces the account we need then hands it over, and the retry simply succeeds.
		// Here the announcement says "I am on B" (so the retry starts) and `eth_accounts` still says A
		// (so the attempt comes back denying it). Without a guard, that result is another state
		// offering nothing new to decide on, and the temptation is to ask again forever.
		//
		// An earlier version of this test asserted the loop guard against a wallet that never offered
		// the requested account at all, so the retry branch was never entered and the guard was never
		// consulted: it passed with the guard deleted. Found in review.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// Count attempts by the step only a connection attempt publishes.
		let attempts = 0;
		const unsubscribe = connection.subscribe((state) => {
			if (state.step === 'WaitingForWalletConnection') {
				attempts++;
			}
		});

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(attempts).toBe(1); // the original attempt
		expect(snapshot().addressUnavailable.requested).toBe(B);

		// The wallet claims to be on B, but will still answer A when asked.
		wallet!.announceAccounts([B]);
		await vi.advanceTimersByTimeAsync(5000);

		// Exactly ONE retry for that claim, and then it stops: the answer its own attempt came back
		// with is not worth asking about a second time.
		expect(attempts).toBe(2);
		expect(ensuring.settled).toBe('no');
		expect(snapshot().addressUnavailable.requested).toBe(B);
		unsubscribe();

		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(50);
		expect(ensuring.settled).toBe('rejected');
	});

	it('does re-attempt when the user switches back to the account it needs', async () => {
		// The other half of the guard, and the reason it remembers only the LAST answer rather than
		// every answer ever seen. A user who switches away and back has done what was asked, twice;
		// a guard that had banked the first attempt would leave them pressing nothing, forever.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(B);

		// Claims B (attempt runs, wallet still answers A), then really goes back to A, then genuinely
		// switches to B.
		wallet!.announceAccounts([B]);
		await vi.advanceTimersByTimeAsync(200);
		expect(ensuring.settled).toBe('no');

		wallet!.switchAccount(B);
		await vi.advanceTimersByTimeAsync(200);

		expect(ensuring.settled).toBe('resolved');
		expect((ensuring.value as any).account.address).toBe(B);
	});

	it('reports it after an UNLOCK that came back on another account, instead of tearing the wallet down', async () => {
		// The full consumer story: the wallet was locked, `ensureConnected` prompted it, and the user
		// answered on a different account than the one the stuck transaction needs.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		wallet!.lock();
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(wallet!.requestAccountsCalls()).toBe(1); // it did try to unlock
		expect(ensuring.settled).toBe('no');
		expect(snapshot().wallet).toBeDefined();
		expect(snapshot().addressUnavailable).toMatchObject({requested: B, selected: A, available: [A]});
	});

	it('keeps naming the account the wallet is actually on, as the user moves around', async () => {
		// The instruction is the whole affordance, so it has to stay TRUE. The state is rebuilt by
		// spreading the current one when the wallet announces a change, which preserved the reason
		// verbatim: correct about the fact (the wallet still cannot act as the requested account) and
		// wrong about the detail, so it went on naming an account the user had already left. Telling
		// somebody to switch away from an account they are not on is worse than saying nothing.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable).toMatchObject({selected: A, available: [A]});

		wallet!.switchAccount(B);
		await vi.advanceTimersByTimeAsync(200);

		// Still unavailable (B is not what was asked for), but now describing where the wallet IS.
		expect(snapshot().addressUnavailable).toMatchObject({requested: NEVER_SEEN, selected: B, available: [B]});
		// The message is rebuilt too, not just the fields the app might not read.
		expect(snapshot().addressUnavailable.message).toContain(B);
		expect(snapshot().addressUnavailable.message).not.toContain(A);
		expect(ensuring.settled).toBe('no');

		// And a wallet that goes on to LOCK offers nothing at all, which the state says rather than
		// keeping a stale account on it.
		wallet!.lock();
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.available).toEqual([]);
		expect(snapshot().addressUnavailable.selected).toBeUndefined();

		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(50);
		expect(ensuring.settled).toBe('rejected');
	});

	it('clears the reason once the wallet is on the account, and proceeds without a click', async () => {
		// The self-clear is documented ("it has stopped being true") and was pinned by nothing: deleting
		// it left the whole suite green, because the retry republishes the state a moment later and
		// hides it. Found in review. Asserted in the window BEFORE the retry's own publish.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(B);

		// Every state published from the moment the wallet moves onto B: none of them may still be
		// telling the user to switch to an account they are now on.
		const published: unknown[] = [];
		const unsubscribe = connection.subscribe((state) => published.push(state.addressUnavailable));
		const beforeSwitch = published.length; // subscribing publishes the current state first
		wallet!.switchAccount(B);
		await vi.advanceTimersByTimeAsync(200);
		unsubscribe();

		const reasonsAfterSwitch = published.slice(beforeSwitch);
		expect(reasonsAfterSwitch.length).toBeGreaterThan(1);
		expect(reasonsAfterSwitch.every((reason) => reason === undefined)).toBe(true);
		expect(ensuring.settled).toBe('resolved');
	});

	it('does not call it a cancellation when something OTHER than the user clears the reason', async () => {
		// A dismissal used to be inferred from the reason DISAPPEARING, and several things clear it. On
		// a `useCurrentAccount` store the library itself does: the wallet moves, the connection follows
		// it onto the new account, and the reason goes with the rebuild. The caller was then told
		// `Connection cancelled` — which consumers are told to map to "the user chose not to" — about a
		// user who had done nothing of the kind. Found in review.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({
			chainInfo,
			targetStep: 'WalletConnected',
			autoConnect: false,
			useCurrentAccount: 'always',
		});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		wallet.switchAccount(B);
		await vi.advanceTimersByTimeAsync(300);

		// The request still stands: the user has not answered it, so it is still on screen, now naming
		// the account the wallet has moved to.
		expect(ensuring.settled).toBe('no');
		expect(snapshot().addressUnavailable).toMatchObject({requested: NEVER_SEEN, selected: B});

		// And the actual dismissal still ends it as a cancellation.
		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(50);
		expect(ensuring.settled).toBe('rejected');
		expect((ensuring.error as Error).message).toBe('Connection cancelled');
	});

	it('does not start a second attempt on top of one the library itself just started', async () => {
		// FOUND BY REVIEW. Attempts decided inside a publish are deferred to a microtask, because a
		// wallet event publishes more than one state and starting an attempt from inside the first of
		// them re-enters the store mid-transition. The deferral then re-checked LESS than the decision
		// had: only the target. On a `useCurrentAccount` store the handler goes on to start its own
		// connect, so the microtask fired a SECOND concurrent one — two `eth_requestAccounts` at once,
		// and a wallet that answers the second with "already processing" would have rejected a call
		// whose real attempt was still running and about to succeed.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({
			chainInfo,
			targetStep: 'WalletConnected',
			autoConnect: false,
			useCurrentAccount: 'always',
		});

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);

		let attempts = 0;
		const unsubscribe = connection.subscribe((state) => {
			if (state.step === 'WaitingForWalletConnection') {
				attempts++;
			}
		});
		// The user switches to the account that was asked for. The store follows the wallet on its own
		// (`useCurrentAccount`), and the pending call wants the same thing: exactly one attempt.
		wallet.switchAccount(B);
		await vi.advanceTimersByTimeAsync(300);
		unsubscribe();

		expect(attempts).toBe(1);
		expect(ensuring.settled).toBe('resolved');
		expect((ensuring.value as any).account.address).toBe(B);
	});

	it('a dismissal answers the request it was about, not every request on the connection', async () => {
		// FOUND BY REVIEW. The dismissal was counted per CONNECTION while the wait it answers is per
		// ADDRESS, so one click cancelled every address-bound call, including one whose wallet prompt
		// was open at that moment. Consumers map `Connection cancelled` to a silent refusal, so the
		// wrongly-cancelled call disappears without a trace.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const forNeverSeen = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		// A second, unrelated request for a different account, made while the first is resting.
		//
		// A KNOWN LIMIT, asserted rather than wished away: one connection has one wallet, one account
		// and one resting reason, so two address-bound requests cannot both stand. The newer one
		// supersedes, and the older one is ANSWERED — the point of this test is what it is answered
		// with. Not `Connection cancelled`: the user made no such decision, and consumers map that
		// message to a silent refusal, so a fake one disappears without a trace.
		const forB = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(forNeverSeen.settled).toBe('rejected');
		expect((forNeverSeen.error as Error).message).not.toBe('Connection cancelled');
		expect((forNeverSeen.error as Error).message).toContain('could not reach');
		// TIGHTENED from "not a cancellation" to what it actually IS. "Not cancelled" was as much as
		// the shape could say, and it left this outcome indistinguishable from "this connection came
		// to rest and cannot get there" — which asks the app for a different response: the target is
		// perfectly reachable, this call just lost the connection's one account slot to a newer
		// request of the app's own making, so retrying it is meaningful where retrying `unreachable`
		// mostly is not.
		expect((forNeverSeen.error as ConnectionFailure).reason).toBe('superseded');

		// The one still standing is the one the user can see, and dismissing it answers THAT one.
		expect(snapshot().addressUnavailable.requested).toBe(B);
		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(100);

		expect(forB.settled).toBe('rejected');
		expect((forB.error as Error).message).toBe('Connection cancelled');
		// ...and the NEWER one, answered by an actual decision, carries the decision's own reason. The
		// two rejections in this test are the pair that used to be told apart only by their message.
		expect((forB.error as ConnectionFailure).reason).toBe('address-unavailable-acknowledged');
	});

	it('does not cancel a call whose wallet prompt is open because another request was dismissed', async () => {
		// The scenario that makes the per-ADDRESS accounting load-bearing rather than tidy: a dismissal
		// counted per CONNECTION answers a call that is at that moment waiting on a wallet popup the
		// user has not touched. It reports `Connection cancelled`, consumers map that to a silent
		// refusal, and the send the user is about to approve vanishes from the app's view.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// A request for an account this wallet does not have comes to rest.
		const forNeverSeen = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		// The wallet then locks, and a second request raises a password prompt the user is looking at.
		wallet!.stallRequestAccounts();
		wallet!.lock();
		await vi.advanceTimersByTimeAsync(100);
		const forB = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(wallet!.requestAccountsCalls()).toBe(1);
		expect(forB.settled).toBe('no'); // the prompt is open; waiting is exactly right

		// The user dismisses the instruction they can still see, which is about the FIRST request.
		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(200);

		expect(forNeverSeen.settled).toBe('rejected');
		expect((forNeverSeen.error as Error).message).toBe('Connection cancelled');
		// ...and the call whose prompt is open is untouched by that click.
		expect(forB.settled).toBe('no');
	});

	it('leaves a REPLAYED address that has vanished degrading exactly as it did', async () => {
		// The preference-versus-requirement line, from the other side. Nobody asked for this address:
		// the library replayed it off the connection's own state, so a wallet that no longer has it
		// is not a situation to report, it is an ordinary connect.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		wallet!.lock();
		await vi.advanceTimersByTimeAsync(50);
		wallet!.switchAccount(B); // unlocked on a different account
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = connection.ensureConnected(); // no mechanism: nothing was asked for
		await vi.advanceTimersByTimeAsync(200);
		const result = await ensuring;

		expect(result.account.address).toBe(B);
		expect(snapshot().addressUnavailable).toBeUndefined();
		expect(snapshot().error).toBeUndefined();
	});

	it('still fails the attempt for an address named through connect(), which is unchanged', async () => {
		// `connect` and `connectToAddress` keep their meaning: a demand that cannot be met fails.
		// Only `ensureConnected` asks for the situation to be REPORTED, because only it is holding a
		// promise it can settle with the answer.
		const {connection, snapshot} = connectedAsA();
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(snapshot().error).toBeDefined();
		expect(snapshot().step).not.toBe('WalletConnected');
		expect(snapshot().addressUnavailable).toBeUndefined();
	});
});

describe('canActAs answers "can this sign right now" without starting anything', () => {
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

	it('is false for a locked wallet holding that very address, which `account.address` cannot say', async () => {
		// The comparison a consumer wrote by hand and got wrong: `connection.account.address === A`
		// is true here, so it skipped its `ensureConnected` call, let the transaction out, and
		// reported the provider's `{code: 4001}` as "transaction rejected by user" about a prompt
		// nobody was shown.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(canActAs(snapshot(), A)).toBe(true);
		expect(connection.canActAs(A)).toBe(true);
		expect(connection.canActAs(B)).toBe(false);
		// Case is not identity: an address is an address however it is spelled.
		expect(connection.canActAs(A.toUpperCase().replace('0X', '0x') as `0x${string}`)).toBe(true);

		wallet.lock();
		await vi.advanceTimersByTimeAsync(50);

		expect(snapshot().account.address).toBe(A); // the address we agreed on
		expect(connection.canActAs(A)).toBe(false); // the address that can sign right now
		expect(wallet.requestAccountsCalls()).toBe(0); // and asking initiated nothing

		// The wallet moving to another account is the other unusable shape, and reads the same.
		wallet.switchAccount(B);
		await vi.advanceTimersByTimeAsync(50);
		expect(connection.canActAs(A)).toBe(false);
	});

	it('trusts wallet.status when the wallet has not been asked for accounts', async () => {
		// `WalletChosen` is the state with a wallet, a status, and an EMPTY accounts list, because
		// nothing has asked it for any. `status` is the authority there, and it says `disconnected`, so
		// nothing can sign.
		//
		// Said plainly rather than claimed: this does NOT pin `canActAs`'s "an empty list is not a
		// denial" clause, because the answer here is already decided one line earlier (a `WalletChosen`
		// state has no `account` at all). That clause is defensive and, as far as review could
		// determine, unreachable through this library's own states; it is kept for a custom connector
		// that publishes `connected` before it has read any accounts. What this test does pin is that
		// asking costs nothing and prompts nothing.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, targetStep: 'WalletChosen', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};

		await connection.selectWallet('Main Wallet');
		await vi.advanceTimersByTimeAsync(100);

		expect(snapshot().wallet.accounts).toEqual([]);
		expect(snapshot().wallet.status).toBe('disconnected');
		expect(connection.canActAs(A)).toBe(false);
		expect(wallet.getAccountsCalls()).toBe(0); // and it asked nothing to find out
	});

	it('recognises the wallet by its EIP-6963 uuid as well as by its name', async () => {
		// `connect` looks a wallet up by name OR uuid, so the two spellings of one wallet must not read
		// as two different wallets when the target is checked — otherwise naming the uuid would connect
		// the right wallet and then refuse to admit it had.
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const other = installLockableWallet({uuid: 'uuid-other', name: 'Other Wallet', rdns: 'com.example.other'});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		try {
			const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;
			const promptsBefore = wallet.requestAccountsCalls();

			const readsBefore = wallet.getAccountsCalls();

			const ensuring = connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'uuid-main'});
			await vi.advanceTimersByTimeAsync(200);
			const result = await ensuring;

			expect(result.account.address).toBe(A);
			// Recognised, so nothing was re-attempted. Asserted on `eth_accounts`: an unrecognised name
			// would reconnect (which re-reads the accounts) and, because `connect` looks wallets up by
			// uuid too, would still end on the right wallet without ever prompting. Counting prompts made
			// this test pass with the uuid matching removed (found in review).
			expect(wallet.getAccountsCalls()).toBe(readsBefore);
			expect(wallet.requestAccountsCalls()).toBe(promptsBefore);
		} finally {
			other.uninstall();
		}
	});

	it('is false before anything is connected', async () => {
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts: [A]});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		await vi.advanceTimersByTimeAsync(50);
		expect(connection.canActAs(A)).toBe(false);
	});
});
