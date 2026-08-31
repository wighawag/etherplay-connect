// The branches of `connect` that nothing exercised.
//
// `connect` is the function the observations note wants decomposed, so its coverage is the
// precondition for that work rather than an end in itself: a restructuring can only be judged by a
// green suite if the suite actually goes down these paths. Each test here asserts what a CONSUMER
// can observe (the published state, or what the wallet and the popup were asked), never a line.
//
// Deliberately not covered, per the stopping rule in `work/notes/observations`: the `if
// ($connection.wallet)` re-checks after an await, whose false side needs a disconnect racing an
// in-flight prompt. Those are defensive guards, and a test for them would assert the shape of the
// code rather than anything an app can see.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

// Captured before any `useFakeTimers`, so a test can wait for work the event loop does for real.
// `generateEcdhKeyPair` is genuine WebCrypto: it resolves from Node's thread pool rather than from
// a timer, so advancing fake time does not deliver it, and a test that carried on regardless would
// open its popup during the NEXT test.
const realSetTimeout = globalThis.setTimeout;
const settleRealWork = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const ACCOUNT = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const SECOND_ACCOUNT = '0x2222222222222222222222222222222222222222' as `0x${string}`;
const WALLET_HOST = 'https://wallet.example.com';
const PAGE_ORIGIN = 'http://localhost:3000';

describe('connect: the paths nothing went down', () => {
	let wallet: LockableWallet | undefined;
	let originalOpen: typeof window.open;
	let opened: {closed: boolean; close: () => void};
	let openedUrls: string[];

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

	function snapshotOf(connection: {subscribe: (run: (v: Connection<any>) => void) => () => void}) {
		return () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
	}

	/**
	 * Wait until the popup is actually open.
	 *
	 * Polls rather than waiting a fixed time because the bridge generates a real key pair first, and
	 * how long that takes depends on what else the machine is doing: a fixed wait passed this file
	 * on its own and failed it in the full suite, opening its popup during the following test.
	 */
	async function waitForPopup() {
		for (let attempt = 0; attempt < 50 && openedUrls.length === 0; attempt++) {
			await settleRealWork();
			await vi.advanceTimersByTimeAsync(10);
		}
		expect(openedUrls.length, 'the popup never opened').toBeGreaterThan(0);
		return new URL(openedUrls[openedUrls.length - 1]);
	}

	/** The id the launcher put in the popup URL, which a reply has to echo to be believed. */
	function popupId() {
		return Number(new URL(openedUrls[openedUrls.length - 1]).searchParams.get('id'));
	}

	/** Answer as the wallet host would, from its own origin. */
	function replyFromHost(data: unknown) {
		window.dispatchEvent(new MessageEvent('message', {data, origin: WALLET_HOST}));
	}

	describe('the wallet branch', () => {
		it('reports a name that matches no announced wallet, without attempting anything', async () => {
			// A wallet uninstalled between render and click, or a name from stale storage. Nothing is
			// attempted, so nothing can be half-done: the flow just reports and comes to rest.
			wallet = installLockableWallet({uuid: 'uuid-a', name: 'Present Wallet', rdns: 'com.example.a'});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
			const snapshot = snapshotOf(connection);
			await vi.advanceTimersByTimeAsync(200);

			const connecting = connection.connect({type: 'wallet', name: 'Absent Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			expect(snapshot().error?.message).toBe('failed to get wallet Absent Wallet');
			expect(snapshot().wallet).toBeUndefined();
			expect(wallet.requestAccountsCalls()).toBe(0);
		});

		it('asks which account, when the wallet offers several and the app named none', async () => {
			// `ChooseWalletAccount` is a step, so the flow is BLOCKED on the user here rather than
			// picking for them. `useCurrentAccount` and an explicit address are the two ways an app
			// says it does not need to ask.
			wallet = installLockableWallet({
				uuid: 'uuid-multi',
				name: 'Multi Wallet',
				rdns: 'com.example.multi',
				accounts: [ACCOUNT, SECOND_ACCOUNT],
			});
			const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Multi Wallet'});
			await vi.advanceTimersByTimeAsync(200);

			expect(snapshot().step).toBe('ChooseWalletAccount');
			expect(snapshot().wallet.accounts).toEqual([ACCOUNT, SECOND_ACCOUNT]);
			// The wallet is connected and usable; only the choice is outstanding.
			expect(snapshot().wallet.status).toBe('connected');

			connection.connectToAddress(SECOND_ACCOUNT);
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(SECOND_ACCOUNT);
		});

		it('takes the single account without asking when the app said useCurrentAccount', async () => {
			wallet = installLockableWallet({
				uuid: 'uuid-multi',
				name: 'Multi Wallet',
				rdns: 'com.example.multi',
				accounts: [ACCOUNT, SECOND_ACCOUNT],
			});
			const connection = createConnection({
				chainInfo,
				targetStep: 'WalletConnected',
				autoConnect: false,
				useCurrentAccount: 'always',
			});
			const snapshot = snapshotOf(connection);

			const connecting = connection.connect({type: 'wallet', name: 'Multi Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(ACCOUNT);
		});

		it('signs in straight after unlocking, when asked to sign right away', async () => {
			// The path through `eth_requestAccounts`: `eth_accounts` answers empty because the wallet
			// is locked, so the flow prompts, and `requestSignatureRightAway` carries it through the
			// signature without a second user action. This is the branch that reaches `SignedIn`
			// without ever resting on `WalletConnected`.
			wallet = installLockableWallet({uuid: 'uuid-lock', name: 'Locked Wallet', rdns: 'com.example.lock'});
			wallet.lock();
			const connection = createConnection({chainInfo, walletOnly: true, autoConnect: false});
			const snapshot = snapshotOf(connection);

			const steps: string[] = [];
			const unsubscribe = connection.subscribe((s) => {
				if (steps[steps.length - 1] !== s.step) steps.push(s.step);
			});

			const connecting = connection.connect({type: 'wallet', name: 'Locked Wallet'}, {requestSignatureRightAway: true});
			await vi.advanceTimersByTimeAsync(200);
			await connecting;
			unsubscribe();

			expect(snapshot().step).toBe('SignedIn');
			expect(wallet.requestAccountsCalls()).toBe(1);
			// It passed THROUGH the signature step rather than resting anywhere for a second click.
			expect(steps).toContain('WaitingForSignature');
		});
	});

	describe('the popup branch', () => {
		function popupConnection(settings?: {domainRedirectBridge?: boolean}) {
			const connection = createConnection({
				walletHost: WALLET_HOST,
				chainInfo,
				autoConnect: false,
				domainRedirectBridge: settings?.domainRedirectBridge,
			});
			return {connection, snapshot: snapshotOf(connection)};
		}

		it('reports that the popup was closed, without ending the attempt', async () => {
			// A closed popup is not a decision: the user may have closed it by accident, and the
			// result can still arrive by another route. So `popupClosed` is published for the app to
			// offer a retry, and the flow stays on `PopupLaunched`.
			const {connection, snapshot} = popupConnection();

			const connecting = connection.connect({type: 'email', email: 'user@example.com'});
			await vi.advanceTimersByTimeAsync(50);
			expect(snapshot().popupClosed).toBe(false);

			opened.closed = true;
			await vi.advanceTimersByTimeAsync(500);

			expect(snapshot().step).toBe('PopupLaunched');
			expect(snapshot().popupClosed).toBe(true);

			connection.cancel();
			await connecting;
		});

		it('keeps the reason when the host REFUSES, rather than treating it as a cancellation', async () => {
			// The distinction the popup catch exists for. A cancellation has nothing to report and
			// rests on `Idle` silently; a refusal carries a reason the app must surface, because the
			// remedy differs (a denied permission or a blocked origin is not "try again").
			const {connection, snapshot} = popupConnection();

			const connecting = connection.connect({type: 'email', email: 'user@example.com'});
			await vi.advanceTimersByTimeAsync(50);

			replyFromHost({id: popupId(), error: {type: 'cross-origin-blocked', message: 'this origin may not sign'}});
			await vi.advanceTimersByTimeAsync(50);
			await connecting;

			expect(snapshot().step).toBe('Idle');
			expect(snapshot().error?.message).toBe('this origin may not sign');
			expect(snapshot().error?.cause).toMatchObject({type: 'cross-origin-blocked'});
		});

		it('ignores a reply carrying the wrong id', async () => {
			// The id is what ties a reply to the popup this attempt opened. A reply for another id is
			// somebody else's, and acting on it would resolve an attempt with a stranger's answer.
			const {connection, snapshot} = popupConnection();

			const connecting = connection.connect({type: 'email', email: 'user@example.com'});
			await vi.advanceTimersByTimeAsync(50);

			replyFromHost({id: popupId() + 99, error: {message: 'not for you'}});
			await vi.advanceTimersByTimeAsync(50);

			expect(snapshot().step).toBe('PopupLaunched');
			expect(snapshot().error).toBeUndefined();

			connection.cancel();
			await connecting;
		});

		it('carries a public key for the domain-redirect bridge, on the flow that can lose its opener', async () => {
			// The bridge exists for full-page OAuth, where COOP can sever `window.opener` and the
			// result has to come back through a page on our own origin. It is only set up for that
			// flow, so the key is generated for an oauth REDIRECTION and for nothing else.
			const {connection} = popupConnection({domainRedirectBridge: true});

			const connecting = connection.connect({type: 'oauth', provider: {id: 'google'}, usePopup: false});
			const url = await waitForPopup();

			expect(url.searchParams.get('oauth-redirection')).toBe('true');
			expect(url.searchParams.get('domain-redirect-public-key')).toBeTruthy();

			connection.cancel();
			await connecting;
		});

		it('carries no bridge key for a popup-based oauth, which never loses its opener', async () => {
			const {connection} = popupConnection({domainRedirectBridge: true});

			const connecting = connection.connect({type: 'oauth', provider: {id: 'google'}, usePopup: true});
			const url = await waitForPopup();

			expect(url.searchParams.has('oauth-redirection')).toBe(false);
			expect(url.searchParams.get('domain-redirect-public-key')).toBeNull();

			connection.cancel();
			await connecting;
		});

		it('launches anyway when the bridge key cannot be generated', async () => {
			// The bridge is a fallback for a browser behaviour, not a requirement. If key generation
			// fails there is still a popup to try, and refusing to open it would turn a maybe-degraded
			// sign-in into no sign-in at all.
			const subtle = window.crypto.subtle;
			const spy = vi.spyOn(subtle, 'generateKey').mockRejectedValue(new Error('no crypto for you'));
			try {
				const {connection, snapshot} = popupConnection({domainRedirectBridge: true});

				const connecting = connection.connect({type: 'oauth', provider: {id: 'google'}, usePopup: false});
				const url = await waitForPopup();

				expect(snapshot().step).toBe('PopupLaunched');
				expect(url.searchParams.get('domain-redirect-public-key')).toBeNull();

				connection.cancel();
				await connecting;
			} finally {
				spy.mockRestore();
			}
		});
	});
});
