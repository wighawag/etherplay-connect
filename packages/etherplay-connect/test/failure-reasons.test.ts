// A FAILURE SAYS WHY, IN A VOCABULARY THE CALLER CAN SWITCH ON.
//
// `ensureConnected` always answers. Several of its answers used to be indistinguishable from
// outside: a consumer classified them by the ABSENCE of a `cause`, because that was the only signal
// there was, so "the connection came to rest and nothing is in progress" arrived looking exactly
// like "the user closed the dialog" — which every consumer maps to "say nothing". A reported hang
// became a silent no-op.
//
// So every failure now carries a `reason`, and this file pins one per path. The shapes are
// deliberately NOT changed to match: `message` is what it always was, including
// `'Connection cancelled'` for a dismissed `addressUnavailable`, because the safe default is what
// stops an app painting a red banner over a decision. The discriminant tells the two apart; the
// shape does not have to.
//
// The test that matters most is the last one. Aliasing is the bug being fixed, so the four outcomes
// that used to collapse into each other are asserted PAIRWISE DISTINCT rather than each in
// isolation: four assertions that each pass alone can still describe one value.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, ConnectionFailure, type Connection, type ConnectionFailureReason} from '../src/index.js';
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

const realSetTimeout = globalThis.setTimeout;
const settleRealWork = () => new Promise((resolve) => realSetTimeout(resolve, 0));

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

/** The reason off a settled `watch`, asserting first that it really did reject. */
function reasonOf(watched: {settled: string; error?: any}): ConnectionFailureReason {
	expect(watched.settled, `expected a rejection, got ${watched.settled}`).toBe('rejected');
	expect(watched.error, 'rejected with something that is not a ConnectionFailure').toBeInstanceOf(ConnectionFailure);
	return (watched.error as ConnectionFailure).reason;
}

describe('a connection failure says why', () => {
	let wallet: LockableWallet | undefined;
	let originalOpen: typeof window.open;
	let openedUrls: string[];
	let opened: {closed: boolean; close: () => void};

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		originalOpen = window.open;
		openedUrls = [];
		opened = {closed: false, close: () => {}};
		(window as any).open = vi.fn((url: string) => {
			openedUrls.push(url);
			return opened as unknown as Window;
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

	function install(accounts: `0x${string}`[] = [A]) {
		wallet = installLockableWallet({uuid: 'uuid-main', name: 'Main Wallet', rdns: 'com.example.main', accounts});
		return wallet;
	}

	function store(options?: {walletHost?: string; walletOnly?: boolean}) {
		const connection = createConnection({
			chainInfo,
			targetStep: options?.walletHost ? 'SignedIn' : 'WalletConnected',
			autoConnect: false,
			walletHost: options?.walletHost,
			walletOnly: options?.walletOnly,
		} as any);
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		return {connection: connection as any, snapshot};
	}

	/** Connected on A, which is the state every address-bound case starts from. */
	async function connectedAsA(accounts: `0x${string}`[] = [A]) {
		install(accounts);
		const made = store();
		await vi.advanceTimersByTimeAsync(200);
		const connecting = made.connection.connect({type: 'wallet', name: 'Main Wallet', address: A});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		expect(made.snapshot().step).toBe('WalletConnected');
		return made;
	}

	/** Wait for the popup, which opens after a REAL key generation rather than after a timer. */
	async function waitForPopup() {
		for (let attempt = 0; attempt < 50 && openedUrls.length === 0; attempt++) {
			await settleRealWork();
			await vi.advanceTimersByTimeAsync(10);
		}
		expect(openedUrls.length, 'the popup never opened').toBeGreaterThan(0);
		return Number(new URL(openedUrls[openedUrls.length - 1]).searchParams.get('id'));
	}

	function replyFromHost(data: unknown) {
		window.dispatchEvent(new MessageEvent('message', {data, origin: WALLET_HOST}));
	}

	it('calls a cancelled connect flow `cancelled`', async () => {
		// The one every consumer already handles, and the one every other answer used to be
		// mistaken for. It must keep both its message and, now, a reason of its own.
		const w = install();
		const {connection} = store();
		await vi.advanceTimersByTimeAsync(200);
		w.lockSilently(); // so `eth_accounts` is empty and the flow must prompt
		w.stallRequestAccounts(); // the wallet dialog is open and the user has not answered

		const ensuring = watch(connection.ensureConnected('WalletConnected'));
		await vi.advanceTimersByTimeAsync(200);
		expect(ensuring.settled).toBe('no');

		connection.cancel();
		await vi.advanceTimersByTimeAsync(200);

		expect((ensuring.error as Error).message).toBe('Connection cancelled');
		expect(reasonOf(ensuring)).toBe('cancelled');
	});

	it('calls a dismissed addressUnavailable `address-unavailable-acknowledged`, keeping its shape', async () => {
		// THE PAIR THE REQUESTER WAS ASKED ABOUT, and the answer is: distinguish them by the
		// discriminant, not by the shape. The message stays `'Connection cancelled'` so that every
		// existing "a refusal maps to cancelled" path is untouched and nobody paints an error over a
		// decision the user made deliberately.
		const {connection, snapshot} = await connectedAsA();

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		connection.acknowledgeAddressUnavailable();
		await vi.advanceTimersByTimeAsync(100);

		expect((ensuring.error as Error).message).toBe('Connection cancelled');
		expect(reasonOf(ensuring)).toBe('address-unavailable-acknowledged');
	});

	it('calls a request that lost the account slot to a newer one `superseded`', async () => {
		// A connection has one wallet, one account and one `addressUnavailable` slot, so a second
		// call naming a different address supersedes the first. Nothing on the connection records
		// that: the newer request took the slot with it, so the older one sees only "at rest, nothing
		// in progress" — the same view it would have if the target were genuinely unreachable. Only
		// the library knows the difference, which is why it is labelled here rather than inferred.
		const {connection, snapshot} = await connectedAsA();

		const forNeverSeen = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		const forB = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(reasonOf(forNeverSeen)).toBe('superseded');
		// The MESSAGE is untouched: still the honest `could not reach ...`, and specifically not a
		// cancellation, because the user decided nothing.
		expect((forNeverSeen.error as Error).message).toContain('could not reach');
		expect((forNeverSeen.error as Error).message).not.toBe('Connection cancelled');
		expect(forB.settled).toBe('no');
	});

	it('does not call a request superseded when the newer one names the SAME address', async () => {
		// The other side of the rule, and what keeps `superseded` meaning something. Two calls for the
		// same account do not compete for the connection's one account slot, so neither supersedes the
		// other: while both stand, both are still resting on the state the user can see, and when
		// something else ends them BOTH get the honest `unreachable`. A registry that counted any later
		// request would blame the innocent one here, which is the failure mode of labelling this from a
		// count rather than from the address.
		const {connection, snapshot} = await connectedAsA();

		const first = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		const second = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);

		expect(first.settled).toBe('no');
		expect(second.settled).toBe('no');
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		// The app connects on its own, which clears the state both were resting on.
		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(300);
		await connecting;

		expect(reasonOf(first)).toBe('unreachable');
		expect(reasonOf(second)).toBe('unreachable');
	});

	it('calls a connection that came to rest with nothing in progress `unreachable`', async () => {
		// The settle guarantee's own answer: the target is not satisfied, nothing is in progress, and
		// nothing can be initiated from here. It is an OUTCOME TO REPORT, and it used to arrive
		// wearing the cancellation's clothes, which every consumer maps to "say nothing" — so the
		// hang the settle guarantee removed came back as a silent no-op.
		//
		// Reached the way an app reaches it: the app calls `connect()` itself while an address-bound
		// call is resting, which clears `addressUnavailable` without anybody deciding anything and
		// without a newer address-bound request existing. Nothing here is superseded; the request
		// simply cannot get there from where the connection now is.
		const {connection, snapshot} = await connectedAsA();

		const ensuring = watch(
			connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
		);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);

		const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(300);
		await connecting;

		expect(reasonOf(ensuring)).toBe('unreachable');
		expect((ensuring.error as Error).message).toContain('nothing is in progress');
	});

	it('calls a declined wallet prompt `wallet-rejected`, and still carries code 4001', async () => {
		// The most common failure in this library, and the one consumers sniff `err.code === 4001`
		// for. `code` is unchanged; `reason` says the same thing without reaching into `cause`.
		const w = install();
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);
		w.lockSilently();
		w.rejectRequestAccounts({code: 4001, message: 'User rejected the request.'});

		const ensuring = watch(connection.ensureConnected('WalletConnected'));
		await vi.advanceTimersByTimeAsync(300);

		expect(reasonOf(ensuring)).toBe('wallet-rejected');
		expect((ensuring.error as ConnectionFailure).code).toBe(4001);
		expect((ensuring.error as Error).message).toBe('Connection request was declined.');
		// The resting error an app RENDERS carries the same label as the error the caller CAUGHT.
		expect(snapshot().error.reason).toBe('wallet-rejected');
	});

	it('calls a wallet that cannot authorise `wallet-unavailable`', async () => {
		// 4100. A different remedy from 4001: retrying the same prompt will not help, the user has to
		// do something in their wallet. Aliasing it onto the rejection is a retry loop nobody wins.
		const w = install();
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);
		w.lockSilently();
		w.rejectRequestAccounts({code: 4100, message: 'Unauthorized'});

		const ensuring = watch(connection.ensureConnected('WalletConnected'));
		await vi.advanceTimersByTimeAsync(300);

		expect(reasonOf(ensuring)).toBe('wallet-unavailable');
		expect(snapshot().error.reason).toBe('wallet-unavailable');
	});

	it('calls an empty accounts answer `no-accounts`, not a cancellation', async () => {
		// Cited in the brief: a consumer's own module aliased `could not get any accounts` onto its
		// cancellation branch, and its comment admitted it. The wallet ANSWERED, with nothing. It is
		// not a refusal, and it is not the user deciding anything.
		install([]);
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);

		const ensuring = watch(connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet'}));
		await vi.advanceTimersByTimeAsync(300);

		expect((ensuring.error as Error).message).toBe('could not get any accounts');
		expect(reasonOf(ensuring)).toBe('no-accounts');
		expect(snapshot().error.reason).toBe('no-accounts');
	});

	it('labels the WalletChosen half of a failure the same as the failure itself', async () => {
		// FOUND BY REVIEW. A failed upgrade from `WalletChosen` does not tear the choice down: it
		// restores `WalletChosen` and puts the error THERE instead, which is a second landing site for
		// the same event, reached 14 times across this suite and asserted by nothing. Mislabelling it
		// `cancelled` (the most damaging possible mistake, since consumers render nothing for a
		// cancellation) passed all 311 tests. The two halves must agree, so both are pinned.
		const w = install();
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);

		await connection.selectWallet('Main Wallet');
		await vi.advanceTimersByTimeAsync(100);
		expect(snapshot().step).toBe('WalletChosen');

		w.lockSilently();
		w.rejectRequestAccounts({code: 4001, message: 'User rejected the request.'});
		const ensuring = watch(connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet'}));
		await vi.advanceTimersByTimeAsync(300);

		// The choice survives, which is the behaviour this branch exists for...
		expect(snapshot().step).toBe('WalletChosen');
		// ...and the error resting on it says the same thing as the error the caller caught.
		expect(snapshot().error.reason).toBe('wallet-rejected');
		expect(reasonOf(ensuring)).toBe('wallet-rejected');
	});

	it('labels an empty accounts answer on the WalletChosen half too', async () => {
		// The other reason that reaches the restore path, and the one that must not read as a refusal.
		install([]);
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);

		await connection.selectWallet('Main Wallet');
		await vi.advanceTimersByTimeAsync(100);
		expect(snapshot().step).toBe('WalletChosen');

		const ensuring = watch(connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet'}));
		await vi.advanceTimersByTimeAsync(300);

		expect(snapshot().step).toBe('WalletChosen');
		expect(snapshot().error.message).toBe('could not get any accounts');
		expect(snapshot().error.reason).toBe('no-accounts');
		expect(reasonOf(ensuring)).toBe('no-accounts');
	});

	it('labels a declined SIGNATURE prompt `wallet-rejected` too, not just a declined connect', async () => {
		// FOUND BY REVIEW: this producer had no assertion. An app that offers "try again" on a
		// rejection must not have to know WHICH prompt the user rejected, so the signature failure maps
		// through the same function as the accounts failure.
		const w = install();
		const {connection, snapshot} = store({walletOnly: true});
		await vi.advanceTimersByTimeAsync(200);
		await connection.connect({type: 'wallet', name: 'Main Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshot().step).toBe('WalletConnected');

		w.whileSigning = () => {
			throw Object.assign(new Error('User rejected the request.'), {code: 4001});
		};
		await connection.requestSignature();
		await vi.advanceTimersByTimeAsync(100);

		expect(snapshot().error.message).toBe('failed to sign message');
		expect(snapshot().error.reason).toBe('wallet-rejected');
	});

	it('calls a blocked cross-origin request `cross-origin-blocked`', async () => {
		// The one host refusal this library can verify, because `@etherplay/connect-core` in this
		// same repo is what mints it. The remedy is a registered delegate, not another popup.
		const {connection, snapshot} = store({walletHost: WALLET_HOST});
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = watch(connection.ensureConnected('SignedIn', {type: 'email', email: 'user@example.com'}));
		const id = await waitForPopup();
		replyFromHost({id, error: {type: 'cross-origin-blocked', message: 'this origin may not sign'}});
		await vi.advanceTimersByTimeAsync(200);

		expect(reasonOf(ensuring)).toBe('cross-origin-blocked');
		expect((ensuring.error as Error).message).toBe('this origin may not sign');
		expect((ensuring.error as ConnectionFailure).cause).toMatchObject({type: 'cross-origin-blocked'});
		expect(snapshot().error.reason).toBe('cross-origin-blocked');
	});

	it('passes an unknown host refusal through as `host-refused`, keeping the host’s own type', async () => {
		// THE DELIBERATE NON-DECISION. The wallet host is deployed separately and chooses its own
		// vocabulary, so a refusal type this library has never heard of is passed through rather than
		// mapped to a member it cannot verify. `reason` says "the host refused"; `cause.type` says
		// what the host called it, and that is what a consumer reads to tell two refusals apart.
		const {connection, snapshot} = store({walletHost: WALLET_HOST});
		await vi.advanceTimersByTimeAsync(50);

		const ensuring = watch(connection.ensureConnected('SignedIn', {type: 'email', email: 'user@example.com'}));
		const id = await waitForPopup();
		replyFromHost({
			id,
			error: {type: 'required-permission-declined', message: 'the user declined a required permission'},
		});
		await vi.advanceTimersByTimeAsync(200);

		expect(reasonOf(ensuring)).toBe('host-refused');
		expect((ensuring.error as ConnectionFailure).cause).toMatchObject({type: 'required-permission-declined'});
		expect((ensuring.error as Error).message).toBe('the user declined a required permission');
		expect(snapshot().error.reason).toBe('host-refused');
	});

	it('calls anything else `failed`, with the underlying error on cause', async () => {
		// The catch-all, and the reason most future causes will need no new member: an attempt that
		// rejects before it has published anything at all (a hosted mechanism on a connection with no
		// `walletHost`) still gets a label rather than falling through unlabelled.
		install();
		const {connection} = store({walletOnly: true});
		await vi.advanceTimersByTimeAsync(200);

		const ensuring = watch(connection.ensureConnected('SignedIn', {type: 'email', email: 'user@example.com'} as any));
		await vi.advanceTimersByTimeAsync(200);

		expect(reasonOf(ensuring)).toBe('failed');
		expect((ensuring.error as Error).message).toContain('walletHost');
		expect((ensuring.error as ConnectionFailure).cause).toBeInstanceOf(Error);
	});

	it('gives the resting error and the thrown failure the same reason', async () => {
		// They describe ONE event, so they carry one label: the thrown failure COPIES the resting
		// error's reason rather than re-deriving it from the message or from `cause`. Re-deriving is
		// how the banner an app renders and the error it caught come to disagree about what happened.
		const w = install();
		const {connection, snapshot} = store();
		await vi.advanceTimersByTimeAsync(200);
		w.lockSilently();
		w.rejectRequestAccounts({code: 4001, message: 'User rejected the request.'});

		const ensuring = watch(connection.ensureConnected('WalletConnected'));
		await vi.advanceTimersByTimeAsync(300);

		const resting = snapshot().error;
		const thrown = ensuring.error as ConnectionFailure;
		expect(resting.reason).toBe(thrown.reason);
		expect(resting.message).toBe(thrown.message);
		expect(resting.cause).toBe(thrown.cause);
	});

	it('gives four look-alike outcomes four DISTINCT reasons', async () => {
		// THE ANTI-ALIASING TEST, and the reason this file exists. These four used to be told apart,
		// at best, by whether a `cause` happened to be present:
		//
		//   - the user cancelled a connect flow;
		//   - the user acknowledged an `addressUnavailable`;
		//   - a request was superseded by a newer address-bound one;
		//   - the connection came to rest with nothing in progress.
		//
		// Two of them share a message by design (`'Connection cancelled'`) and two share the other
		// one. Asserted PAIRWISE rather than one at a time on purpose: four assertions that each pass
		// in isolation can still be describing the same value, which is exactly the failure being
		// fixed here, and a set of size 4 is the only assertion that cannot be satisfied by aliasing.
		const collected: Record<string, ConnectionFailureReason> = {};

		// 1. A cancelled connect flow.
		{
			const w = install();
			const {connection} = store();
			await vi.advanceTimersByTimeAsync(200);
			w.lockSilently();
			w.stallRequestAccounts();
			const ensuring = watch(connection.ensureConnected('WalletConnected'));
			await vi.advanceTimersByTimeAsync(200);
			connection.cancel();
			await vi.advanceTimersByTimeAsync(200);
			collected.cancelled = reasonOf(ensuring);
			w.uninstall();
			wallet = undefined;
		}

		// 2. An acknowledged `addressUnavailable`, and 3. a superseded request, from one connection:
		// they are the pair the connection's single account slot makes possible.
		{
			const {connection, snapshot} = await connectedAsA();
			const forNeverSeen = watch(
				connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
			);
			await vi.advanceTimersByTimeAsync(200);
			const forB = watch(
				connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: B}),
			);
			await vi.advanceTimersByTimeAsync(200);
			collected.superseded = reasonOf(forNeverSeen);

			expect(snapshot().addressUnavailable.requested).toBe(B);
			connection.acknowledgeAddressUnavailable();
			await vi.advanceTimersByTimeAsync(200);
			collected.acknowledged = reasonOf(forB);
			wallet?.uninstall();
			wallet = undefined;
		}

		// 4. Come to rest, nothing in progress.
		{
			const {connection, snapshot} = await connectedAsA();
			const ensuring = watch(
				connection.ensureConnected('WalletConnected', {type: 'wallet', name: 'Main Wallet', address: NEVER_SEEN}),
			);
			await vi.advanceTimersByTimeAsync(200);
			expect(snapshot().addressUnavailable.requested).toBe(NEVER_SEEN);
			const connecting = connection.connect({type: 'wallet', name: 'Main Wallet'});
			await vi.advanceTimersByTimeAsync(300);
			await connecting;
			collected.unreachable = reasonOf(ensuring);
		}

		const values = Object.values(collected);
		expect(values.length).toBe(4);
		expect(new Set(values).size, `these four outcomes are not distinct: ${JSON.stringify(collected)}`).toBe(4);
		// Named as well as distinct: four distinct WRONG labels would satisfy the set size alone.
		expect(collected).toEqual({
			cancelled: 'cancelled',
			acknowledged: 'address-unavailable-acknowledged',
			superseded: 'superseded',
			unreachable: 'unreachable',
		});
	});
});
