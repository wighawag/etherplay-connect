// THE SETTLE GUARANTEE, ENUMERATED.
//
// `ensureConnected` must always answer. The rule is not "eventually" and it is deliberately not a
// timeout: a human is in the loop, so any timer is either long enough to be useless or short enough
// to cut a user off mid-decision, and it would report "timed out" about a wallet dialog that is open
// and perfectly healthy. The rule is narrower, and checkable:
//
//   WAITING IS ONLY LEGITIMATE WHILE SOMETHING IS ACTUALLY IN PROGRESS.
//
// So this file crosses every entry state a consumer can reach (each step, wallet present or not,
// each `wallet.status`, valid and invalid chain, error on entry or not) with every target step and
// with each kind of mechanism (none, an address the wallet holds, an address it does not), and
// asserts of every single combination that it either:
//
//   a. settles on its own, or
//   b. comes to rest with a reason the app can RENDER, and settles when the user answers it.
//
// (b) is checked twice over: the resting state must name the reason using only published fields
// (`renderableReason` below reads nothing else, because nothing else is available to an app), and
// the user's answer must actually end it. A wait nobody can see, and nothing but a page reload can
// end, is the failure this file exists to make impossible.
//
// It is written as an enumeration rather than as prose on purpose. A settle guarantee argued in a
// comment decays as soon as a fourth step or a fifth resting reason is added; one that is
// enumerated fails.
//
// HONEST LIMITS. The entry list is CURATED, not a cross product: it is every resting shape a
// consumer reaches, driven through the public API rather than constructed, but it does not multiply
// out every combination of step, status, chain and error. Four more (`MechanismToChoose` with an
// error, `SignedIn` on a wallet that moved account, `WalletChosen` with a locked wallet,
// `WalletConnected` both locked and on the wrong chain) were added temporarily during review and all
// passed, so their absence hides nothing today. `renderableReason` below is also deliberately kept
// no looser than the implementation's own `awaitingUserReason`: anywhere it is more permissive, a
// genuine hang would be blessed as a legitimate wait.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, isTargetStepReached, type Connection, type TargetStep} from '../src/index.js';
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

type AnyStore = {
	subscribe: (run: (value: Connection<any>) => void) => () => void;
	ensureConnected: any;
	cancel: () => void;
	connect: any;
	selectWallet: any;
	requestSignature: () => Promise<void>;
	acknowledgeAddressUnavailable: () => void;
};

type Entry = {
	/** What the connection looks like when `ensureConnected` is called. */
	name: string;
	build: () => Promise<{connection: AnyStore; snapshot: () => any}>;
};

/**
 * Why an app could tell the user this connection is waiting, reading ONLY published fields.
 *
 * Deliberately written against the state a consumer sees rather than against the implementation:
 * the guarantee is not "the library knows why it is waiting", it is "the user can see why, and can
 * end it". Anything not on this list is an unanswered question, not a wait.
 */
function renderableReason(state: any, target: string, askedAddress?: `0x${string}`): string | undefined {
	if (state.step === 'WaitingForWalletConnection' || state.step === 'PopupLaunched') {
		return 'the wallet (or the host popup) is being asked';
	}
	if (state.step === 'WaitingForSignature') {
		return 'the wallet is holding a signature request';
	}
	if (state.step === 'ChooseWalletAccount') {
		return 'the user is picking which account to use';
	}
	if (state.step === 'MechanismToChoose' || state.step === 'WalletToChoose') {
		return 'the user is picking a wallet or a sign-in method';
	}
	// QUALIFIED, and the qualifications are the point. A first version of this helper accepted any
	// `addressUnavailable` and any wrong chain, which is looser than the implementation's own list
	// and loose in the direction that HIDES hangs: a reason left on the connection by somebody else's
	// request, or a chain mismatch on a target that never checks the chain, would have licensed a
	// wait this call can do nothing about. Flagged in review.
	if (askedAddress && state.addressUnavailable?.requested?.toLowerCase() === askedAddress.toLowerCase()) {
		return `the wallet is not on ${state.addressUnavailable.requested}`;
	}
	if (
		target === 'WalletConnected' &&
		state.wallet?.invalidChainId &&
		isTargetStepReached(state, target as TargetStep)
	) {
		// Qualified like the implementation: a chain mismatch only licenses a wait when the chain is the
		// ONLY thing left. Otherwise a wallet on the wrong chain would excuse any other unmet target.
		return 'the wallet is on another chain';
	}
	if (
		target === 'SignedIn' &&
		state.step === 'WalletConnected' &&
		state.wallet?.status === 'connected' &&
		(!askedAddress || state.account?.address?.toLowerCase() === askedAddress.toLowerCase())
	) {
		// The app renders its own "sign in" button here; requesting the signature over the top of it
		// would prompt for something the app deliberately deferred. `requestSignatureRightAway` (or
		// `requestSignatureAutomaticallyIfPossible` on the store) is the opt-in that removes the click.
		// Only while the wallet can still BE asked: on a locked or moved-on wallet that button is not a
		// remedy, so waiting for it is not legitimate.
		return 'the app has not asked for the signature yet';
	}
	return undefined;
}

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

describe('every reachable entry state settles, or rests on something the user can answer', () => {
	let installed: LockableWallet[] = [];
	let originalOpen: typeof window.open;
	let openedUrls: string[] = [];

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		// The hosted entry below needs a popup to answer as the wallet host would. Everything else
		// ignores this.
		originalOpen = window.open;
		openedUrls = [];
		(window as any).open = vi.fn((url: string) => {
			openedUrls.push(url);
			return {closed: false, close: () => {}} as unknown as Window;
		});
	});

	afterEach(() => {
		for (const wallet of installed) {
			wallet.uninstall();
		}
		installed = [];
		(window as any).open = originalOpen;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function install(options?: {accounts?: `0x${string}`[]; chainId?: string; name?: string; uuid?: string}) {
		const wallet = installLockableWallet({
			uuid: options?.uuid ?? 'uuid-main',
			name: options?.name ?? 'Main Wallet',
			rdns: `com.example.${options?.uuid ?? 'main'}`,
			accounts: options?.accounts ?? [A],
			chainId: options?.chainId,
		});
		installed.push(wallet);
		return wallet;
	}

	function store(settings: any): {connection: AnyStore; snapshot: () => any} {
		const connection = createConnection({chainInfo, autoConnect: false, ...settings}) as unknown as AnyStore;
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		return {connection, snapshot};
	}

	// EVERY ENTRY STATE, built by driving the public API rather than by constructing states, so that
	// an unreachable one cannot creep onto the list and a reachable one cannot quietly leave it.
	const entries: Entry[] = [
		{
			name: 'Idle, nothing connected',
			build: async () => {
				install();
				const made = store({targetStep: 'WalletConnected'});
				await vi.advanceTimersByTimeAsync(100);
				return made;
			},
		},
		{
			name: 'Idle, carrying the error of a failed attempt',
			build: async () => {
				const wallet = install();
				const made = store({targetStep: 'WalletConnected'});
				wallet.lockSilently();
				wallet.rejectRequestAccounts(Object.assign(new Error('User rejected the request'), {code: 4001}));
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().step).toBe('Idle');
				expect(made.snapshot().error).toBeDefined();
				// The wallet works again: a retry from here must be able to succeed, or the case would
				// only ever prove that a broken wallet rejects.
				wallet.rejectRequestAccounts(undefined);
				return made;
			},
		},
		{
			name: 'WalletToChoose, the picker is on screen',
			build: async () => {
				install();
				install({name: 'Other Wallet', uuid: 'uuid-other', accounts: [B]});
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect();
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('WalletToChoose');
				return made;
			},
		},
		{
			name: 'WalletToChoose, carrying the error of a failed attempt',
			build: async () => {
				const wallet = install();
				install({name: 'Other Wallet', uuid: 'uuid-other', accounts: [B]});
				const made = store({targetStep: 'WalletConnected'});
				wallet.lockSilently();
				wallet.rejectRequestAccounts(Object.assign(new Error('User rejected the request'), {code: 4001}));
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().step).toBe('WalletToChoose');
				expect(made.snapshot().error).toBeDefined();
				wallet.rejectRequestAccounts(undefined);
				return made;
			},
		},
		{
			name: 'MechanismToChoose, the sign-in picker is on screen',
			build: async () => {
				install();
				const made = store({walletHost: 'https://wallet.example'});
				await made.connection.connect();
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('MechanismToChoose');
				return made;
			},
		},
		{
			name: 'WalletChosen, a wallet picked for reads only',
			build: async () => {
				install();
				const made = store({targetStep: 'WalletChosen'});
				await made.connection.selectWallet('Main Wallet');
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('WalletChosen');
				return made;
			},
		},
		{
			name: 'WalletChosen, carrying the error of a failed upgrade',
			build: async () => {
				const wallet = install();
				const made = store({targetStep: 'WalletChosen'});
				await made.connection.selectWallet('Main Wallet');
				await vi.advanceTimersByTimeAsync(100);
				wallet.lockSilently();
				wallet.rejectRequestAccounts(Object.assign(new Error('User rejected the request'), {code: 4001}));
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().step).toBe('WalletChosen');
				expect(made.snapshot().error).toBeDefined();
				wallet.rejectRequestAccounts(undefined);
				return made;
			},
		},
		{
			name: 'WalletConnected, wallet connected',
			build: async () => {
				install();
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().step).toBe('WalletConnected');
				return made;
			},
		},
		{
			name: 'WalletConnected, wallet LOCKED',
			build: async () => {
				const wallet = install();
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				wallet.lock();
				await vi.advanceTimersByTimeAsync(50);
				expect(made.snapshot().wallet.status).toBe('locked');
				return made;
			},
		},
		{
			name: 'WalletConnected, wallet on ANOTHER account (status disconnected)',
			build: async () => {
				const wallet = install();
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				wallet.switchAccount(B);
				await vi.advanceTimersByTimeAsync(50);
				expect(made.snapshot().wallet.status).toBe('disconnected');
				expect(made.snapshot().wallet.accountChanged).toBe(B);
				return made;
			},
		},
		{
			name: 'WalletConnected, wallet on another CHAIN',
			build: async () => {
				install({chainId: '0x89'});
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().wallet.invalidChainId).toBe(true);
				return made;
			},
		},
		{
			name: 'WalletConnected, carrying the error of a refused signature',
			build: async () => {
				const wallet = install();
				const made = store({walletOnly: true});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				wallet.whileSigning = () => {
					throw new Error('User rejected the signature');
				};
				await made.connection.requestSignature();
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('WalletConnected');
				expect(made.snapshot().error).toBeDefined();
				wallet.whileSigning = undefined;
				return made;
			},
		},
		{
			name: 'WalletConnected, already resting on addressUnavailable from an earlier call',
			build: async () => {
				// THE STATE THIS WHOLE CHANGE INTRODUCES, as an ENTRY state rather than as an outcome. It was
				// missing (found in review), which matters because it is the one resting reason a second,
				// unrelated call can find already on the connection and must not wait forever on.
				install();
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				// An earlier call, for an account this wallet does not have, left the reason behind. Its own
				// promise stays pending, which is correct and is not what this case is about.
				made.connection.ensureConnected('WalletConnected', {type: 'wallet', address: NEVER_SEEN}).catch(() => {});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().addressUnavailable).toBeDefined();
				return made;
			},
		},
		{
			name: 'WaitingForWalletConnection, the wallet is being asked for accounts',
			build: async () => {
				// A real step, and it was absent. Held open by a wallet that never answers
				// `eth_requestAccounts`, which is what a user staring at an unanswered wallet popup is.
				const wallet = install();
				const made = store({targetStep: 'WalletConnected'});
				wallet.lockSilently(); // so `eth_accounts` is empty and the flow must prompt
				wallet.stallRequestAccounts(); // the popup is open and the user has not decided
				made.connection.connect({type: 'wallet', name: 'Main Wallet'}).catch(() => {});
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('WaitingForWalletConnection');
				return made;
			},
		},
		{
			name: 'PopupLaunched, the hosted sign-in window is open',
			build: async () => {
				install();
				const made = store({walletHost: WALLET_HOST});
				made.connection.connect({type: 'email', email: 'user@example.com'}).catch(() => {});
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('PopupLaunched');
				return made;
			},
		},
		{
			name: 'ChooseWalletAccount, the account picker is on screen',
			build: async () => {
				install({accounts: [A, B]});
				const made = store({targetStep: 'WalletConnected'});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				expect(made.snapshot().step).toBe('ChooseWalletAccount');
				return made;
			},
		},
		{
			name: 'WaitingForSignature, the wallet is holding the prompt',
			build: async () => {
				const wallet = install();
				const made = store({walletOnly: true});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				// Held open for the whole case: this is the step that exists precisely because a human
				// is looking at a dialog, and it must never be timed out from under them.
				wallet.whileSigning = () => new Promise<void>(() => {});
				made.connection.requestSignature().catch(() => {});
				await vi.advanceTimersByTimeAsync(50);
				expect(made.snapshot().step).toBe('WaitingForSignature');
				return made;
			},
		},
		{
			name: 'SignedIn through a wallet',
			build: async () => {
				install();
				const made = store({walletOnly: true});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				await made.connection.requestSignature();
				await vi.advanceTimersByTimeAsync(100);
				expect(made.snapshot().step).toBe('SignedIn');
				return made;
			},
		},
		{
			name: 'SignedIn through a hosted popup, with no wallet at all',
			build: async () => {
				// The one signed-in shape that carries NO wallet, so it satisfies a `SignedIn` target and
				// nothing below it. Reaching a wallet target from here means connecting a wallet, which
				// costs the hosted session: an answer, where this used to be a silent wait.
				install();
				const made = store({walletHost: WALLET_HOST});
				const connecting = made.connection.connect({type: 'email', email: 'user@example.com'});
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
								metadata: {email: 'user@example.com'},
								mechanismUsed: {type: 'email'},
								savedDelegations: [],
							},
						},
						origin: WALLET_HOST,
					}),
				);
				await vi.advanceTimersByTimeAsync(50);
				await connecting;
				expect(made.snapshot().step).toBe('SignedIn');
				expect(made.snapshot().wallet).toBeUndefined();
				return made;
			},
		},
		{
			name: 'SignedIn through a wallet that has since LOCKED',
			build: async () => {
				const wallet = install();
				const made = store({walletOnly: true});
				await made.connection.connect({type: 'wallet', name: 'Main Wallet'});
				await vi.advanceTimersByTimeAsync(200);
				await made.connection.requestSignature();
				await vi.advanceTimersByTimeAsync(100);
				wallet.lock();
				await vi.advanceTimersByTimeAsync(50);
				expect(made.snapshot().wallet.status).toBe('locked');
				return made;
			},
		},
	];

	const targets = ['WalletChosen', 'WalletConnected', 'SignedIn'] as const;
	const mechanisms: {name: string; value: any}[] = [
		{name: 'no mechanism', value: undefined},
		{name: 'an address the wallet holds', value: {type: 'wallet', address: A}},
		{name: 'an address the wallet does not have', value: {type: 'wallet', address: NEVER_SEEN}},
	];

	it('answers, or rests on something the user can see and end', async () => {
		const outcomes: {case: string; outcome: string; reason?: string}[] = [];

		for (const entry of entries) {
			for (const target of targets) {
				for (const mechanism of mechanisms) {
					const label = `${entry.name} | target ${target} | ${mechanism.name}`;
					// A case gets its own wallets. EIP-6963 discovery is page-wide and de-duplicates by
					// announcement identity, so a wallet left installed by the previous case would be the one
					// this one connects to — unlocked, unrejecting, and nothing like the state being built.
					for (const wallet of installed) {
						wallet.uninstall();
					}
					installed = [];
					localStorage.clear();
					sessionStorage.clear();
					const {connection, snapshot} = await entry.build();

					// Every target is called on every store on purpose, `as any` because the overloads
					// narrow by the store's configured target and this is exercising the runtime.
					const ensuring = watch(
						mechanism.value ? connection.ensureConnected(target, mechanism.value) : connection.ensureConnected(target),
					);
					await vi.advanceTimersByTimeAsync(500);

					if (ensuring.settled !== 'no') {
						// A SETTLED CALL CAN STILL BE A WRONG ANSWER, and one was: `ensureConnected` rejected
						// with "nothing is in progress" about an attempt it had just started and which then
						// reached the target. The enumeration recorded that as `rejected` and was satisfied,
						// which is how it survived a real bug (found in review, not here). "It answered" is
						// only worth something if the answer is not contradicted by what the library then did.
						if (ensuring.settled === 'rejected') {
							const message = (ensuring.error as Error)?.message ?? '';
							const after = snapshot();
							if (message.includes('nothing is in progress')) {
								expect(
									renderableReason(after, target, mechanism.value?.address),
									`${label}: reported "nothing is in progress" and then came to rest on ${after.step}, which IS something the user is being asked about`,
								).toBeUndefined();
								expect(
									isTargetStepReached(after, target as TargetStep),
									`${label}: reported failure and then reached ${after.step} anyway`,
								).toBe(false);
							}
						}
						outcomes.push({case: label, outcome: ensuring.settled});
						continue;
					}

					// STILL PENDING. That is only allowed while the user has something to answer, and
					// the app must be able to say what it is from the published state alone.
					const resting = snapshot();
					const reason = renderableReason(resting, target, mechanism.value?.address);
					expect(
						reason,
						`${label}: waited with nothing on screen. step=${resting.step} walletStatus=${resting.wallet?.status} invalidChain=${resting.wallet?.invalidChainId} addressUnavailable=${JSON.stringify(resting.addressUnavailable)}`,
					).toBeTruthy();

					// ...and the user's answer must end it. `cancel()` is the one remedy every app
					// offers, whatever the reason, so it is the one asserted for all of them; the
					// specific remedies (switch account, acknowledge, switch chain, request the
					// signature) are pinned case by case in the sibling files.
					connection.cancel();
					await vi.advanceTimersByTimeAsync(500);
					expect(ensuring.settled, `${label}: cancel() did not settle it (${reason})`).not.toBe('no');
					outcomes.push({case: label, outcome: `waited then ${ensuring.settled}`, reason});
				}
			}
		}

		// The enumeration must not be vacuous. If everything merely "waited then rejected", the
		// assertions above would hold while proving nothing about reaching a target at all. The bar is
		// a THIRD of the matrix rather than a token few: the count is 66 of 180 today, and a change
		// that turned a large block of successes into refusals is exactly the regression this guards.
		const resolvedOnItsOwn = outcomes.filter((o) => o.outcome === 'resolved');
		expect(outcomes.length).toBe(entries.length * targets.length * mechanisms.length);
		// An ABSOLUTE floor, not a ratio: a ratio moves with the entry list, so adding entry states that
		// mostly wait would fail it with nothing regressed, and adding ones that mostly resolve would
		// quietly raise the bar. 66 of 180 resolve today.
		expect(resolvedOnItsOwn.length).toBeGreaterThanOrEqual(66);
		// And no case may be left pending: this is the invariant the whole file is about.
		expect(outcomes.filter((o) => o.outcome === 'waited then no')).toEqual([]);
	}, 60000);

	it('answers even when the attempt fails without publishing anything', async () => {
		// The one way to wait forever that no entry state can express, because it never reaches a
		// state: `connect` rejects BEFORE its first publish (a hosted mechanism on a connection with no
		// `walletHost`), so nothing moved, nothing is in progress, and nothing will publish again.
		//
		// The types forbid this call, which is exactly why it is worth a runtime test: a guarantee held
		// shut by the type system alone is not held shut for JavaScript callers, and this one is cheap
		// to keep true for everybody.
		install();
		const {connection} = store({walletOnly: true});
		await vi.advanceTimersByTimeAsync(100);

		const ensuring = watch(connection.ensureConnected('SignedIn', {type: 'email', email: 'user@example.com'} as any));
		await vi.advanceTimersByTimeAsync(200);

		expect(ensuring.settled).toBe('rejected');
		expect((ensuring.error as Error).message).toContain('walletHost');
	});
});
