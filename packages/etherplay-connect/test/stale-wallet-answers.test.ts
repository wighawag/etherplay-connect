// An answer that arrives after the connection has moved on must not be applied to the new state.
//
// The same family as `test/late-auto-connect.test.ts` and `test/overtaken-attempts.test.ts`, in the
// three remaining places that publish after awaiting something the user (or the wallet) takes time
// over: the unlock prompt, the lock poll, and the sign-in popup. Each captured what it was about
// BEFORE the await and applied the answer to whatever the connection had become by the time it came
// back, which may be a different wallet, a disconnected one, or a different kind of sign-in.

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
const WALLET_HOST = 'https://wallet.example.com';
const PAGE_ORIGIN = 'http://localhost:3000';

describe('a wallet answer that arrives after the connection moved on', () => {
	let wallets: LockableWallet[] = [];

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const wallet of wallets) {
			wallet.uninstall();
		}
		wallets = [];
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

	function install(name: string, accounts: `0x${string}`[]) {
		const wallet = installLockableWallet({uuid: `uuid-${name}`, name, rdns: `com.example.${name}`, accounts});
		wallets.push(wallet);
		return wallet;
	}

	async function connectedTo(name: string, address: `0x${string}`) {
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);
		await connection.connect({type: 'wallet', name, address});
		expect(snapshot().step).toBe('WalletConnected');
		return {connection, snapshot};
	}

	describe('unlock()', () => {
		it('a refused unlock prompt, answered after a disconnect, does not put the old wallet back', async () => {
			// The catch republished the wallet it captured before the prompt onto the CURRENT state. After
			// a disconnect that is `Idle` carrying a wallet, which `set` then does not tear down, since the
			// state shows one: a state that says "connected wallet" with nothing behind it.
			const first = install('first', [A]);
			const {connection, snapshot} = await connectedTo('first', A);
			first.lock();
			await vi.advanceTimersByTimeAsync(10);
			expect(snapshot().wallet.status).toBe('locked');

			const release = first.holdNext('eth_requestAccounts');
			first.rejectRequestAccounts({code: 4001, message: 'User rejected the request.'});
			const unlocking = connection.unlock();
			await vi.advanceTimersByTimeAsync(10);
			expect(snapshot().wallet.unlocking).toBe(true);

			connection.disconnect();
			release();
			await unlocking;
			await vi.advanceTimersByTimeAsync(10);

			expect(snapshot().step).toBe('Idle');
			expect(snapshot().wallet).toBeUndefined();
		});

		it('an unlock answered after switching to another wallet does not apply its accounts to that wallet', async () => {
			// The success path handed the OLD wallet's accounts to `onAccountChanged`, which applies them
			// to whatever wallet the state now shows: the new wallet is reported as not holding its own
			// account.
			const first = install('first', [A]);
			install('second', [B]);
			const {connection, snapshot} = await connectedTo('first', A);
			first.lock();
			await vi.advanceTimersByTimeAsync(10);

			const release = first.holdNext('eth_requestAccounts');
			const unlocking = connection.unlock();
			await vi.advanceTimersByTimeAsync(10);

			await connection.connect({type: 'wallet', name: 'second', address: B});
			expect(snapshot().account.address).toBe(B);

			release();
			await unlocking;
			await vi.advanceTimersByTimeAsync(10);

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(B);
			expect(snapshot().wallet.status).toBe('connected');
			expect(snapshot().wallet.accounts).toEqual([B]);
		});
		it('a refused unlock, after a move that kept the same wallet, does not leave it unlocking', async () => {
			// Dropping the answer is right when the wallet changed; when the move kept the SAME locked
			// wallet (a signature asked for meanwhile), the refusal still has to clear `unlocking`, or the
			// app shows a spinner on an "Unlock" button forever.
			const first = install('first', [A]);
			const {connection, snapshot} = await connectedTo('first', A);
			first.lockSilently();
			await vi.advanceTimersByTimeAsync(1000);
			expect(snapshot().wallet.status).toBe('locked');

			const release = first.holdNext('eth_requestAccounts');
			first.rejectRequestAccounts({code: 4001, message: 'User rejected the request.'});
			const unlocking = connection.unlock();
			await vi.advanceTimersByTimeAsync(10);
			await connection.requestSignature();
			expect(snapshot().step).toBe('SignedIn');

			release();
			await unlocking;
			await vi.advanceTimersByTimeAsync(10);

			expect(snapshot().wallet.status).toBe('locked');
			expect(snapshot().wallet.unlocking).toBe(false);
		});
	});

	describe('the lock poll', () => {
		it("the old wallet's locked answer, arriving after a switch, does not mark the new wallet locked", async () => {
			// The poll read `$connection.wallet.provider` before awaiting it and applied the answer to the
			// state after. The new wallet was then `locked` for good: its own polls only ever act on an
			// EMPTY answer, so nothing would ever mark it unlocked again.
			const first = install('first', [A]);
			install('second', [B]);
			const {connection, snapshot} = await connectedTo('first', A);

			first.lockSilently();
			const release = first.holdNext('eth_accounts');
			// The poll runs every second; this one asks the first wallet and is held.
			await vi.advanceTimersByTimeAsync(1000);

			await connection.connect({type: 'wallet', name: 'second', address: B});
			expect(snapshot().account.address).toBe(B);

			release();
			await vi.advanceTimersByTimeAsync(3000);

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(B);
			expect(snapshot().wallet.status).toBe('connected');
		});
	});

	describe('following the wallet (useCurrentAccount)', () => {
		it('a switch away and back while the follow is in flight ends on the account the wallet is on', async () => {
			// The follow (`connectToAddress(B)`) publishes a state with no wallet while it waits, so the
			// wallet's second announcement (back to A) is ignored. The follow then found only A and, having
			// DEMANDED B, failed and tore the wallet down: no account and no wallet, while the wallet sat on
			// the very account the user had been connected as. A follow is a preference, not a demand.
			const first = install('first', [A]);
			const connection = createConnection({
				chainInfo,
				targetStep: 'WalletConnected',
				autoConnect: false,
				useCurrentAccount: 'always',
			});
			const snapshot = snapshotOf(connection);
			await vi.advanceTimersByTimeAsync(200);
			await connection.connect({type: 'wallet', name: 'first', address: A});

			const release = first.holdNext('eth_accounts');
			first.switchAccount(B);
			await vi.advanceTimersByTimeAsync(10);
			first.switchAccount(A);
			await vi.advanceTimersByTimeAsync(10);
			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(A);
			expect(snapshot().wallet.status).toBe('connected');
		});

		it('an explicit connectToAddress still DEMANDS its address', async () => {
			// The fix must not loosen the public call: an app naming an account the wallet does not offer
			// still gets a failure, not a connection to something else.
			// Built with `useCurrentAccount`, the store where a loosened demand would quietly connect to
			// the wallet's first account instead.
			install('first', [A]);
			const connection = createConnection({
				chainInfo,
				targetStep: 'WalletConnected',
				autoConnect: false,
				useCurrentAccount: 'always',
			});
			const snapshot = snapshotOf(connection);
			await vi.advanceTimersByTimeAsync(200);
			await connection.connect({type: 'wallet', name: 'first', address: A});

			connection.connectToAddress(B);
			await vi.advanceTimersByTimeAsync(200);

			expect(snapshot().step).not.toBe('WalletConnected');
			expect(snapshot().wallet).toBeUndefined();
			expect(snapshot().error.message).toBe('failed to connect to wallet');
			expect(snapshot().error.cause.message).toContain('could not find address');
		});
	});

	describe('the sign-in popup', () => {
		let originalOpen: typeof window.open;
		let openedUrls: string[];

		beforeEach(() => {
			originalOpen = window.open;
			openedUrls = [];
			(window as any).open = vi.fn((url: string) => {
				openedUrls.push(url);
				return {closed: false, close: () => {}} as unknown as Window;
			});
		});

		afterEach(() => {
			(window as any).open = originalOpen;
		});

		it('a popup sign-in that completes after the app connected a wallet does not replace that wallet', async () => {
			// Connecting a wallet does not close the popup, so it can still finish. Its failure path
			// already checked that it still owned the flow; its success path did not, and signed the
			// hosted account in over the wallet, tearing the wallet down, and saved it.
			install('first', [A]);
			const connection = createConnection({walletHost: WALLET_HOST, chainInfo, autoConnect: false});
			const snapshot = snapshotOf(connection);
			await vi.advanceTimersByTimeAsync(200);

			const viaPopup = connection.connect({type: 'email', email: 'user@example.com'});
			await vi.advanceTimersByTimeAsync(50);
			expect(snapshot().step).toBe('PopupLaunched');

			await connection.connect({type: 'wallet', name: 'first', address: A});
			expect(snapshot().step).toBe('WalletConnected');

			const id = Number(new URL(openedUrls[openedUrls.length - 1]).searchParams.get('id'));
			const hosted = {
				address: B,
				signer: {
					origin: PAGE_ORIGIN,
					address: '0x5555000000000000000000000000000000000005',
					publicKey: `0x${'cd'.repeat(33)}`,
					privateKey: `0x${'ef'.repeat(32)}`,
				},
				metadata: {email: 'user@example.com'},
				mechanismUsed: {type: 'email'},
				savedDelegations: [],
			};
			window.dispatchEvent(new MessageEvent('message', {data: {id, result: hosted}, origin: WALLET_HOST}));
			await vi.advanceTimersByTimeAsync(50);
			await viaPopup;

			expect(snapshot().step).toBe('WalletConnected');
			expect(snapshot().account.address).toBe(A);
			expect(snapshot().wallet.status).toBe('connected');
			expect(localStorage.getItem('__origin_account')).toBeNull();
		});
	});
});
