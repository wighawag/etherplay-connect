// An explicit attempt must yield, too, when something newer has moved the flow while it waited.
//
// The same defect as the late auto-connect (`test/late-auto-connect.test.ts`), in the three other
// places that publish after awaiting the wallet: `connect`, `selectWallet` and `requestSignature`.
// Each used to publish what it had been waiting for over whatever had happened since, so the SLOWER
// of two overlapping attempts won rather than the newer one. The signature case is the worst of
// them: the answer A gave was turned into a key and filed, and saved, as B's.

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
const WALLET_NAME = 'Two Account Wallet';

describe('an attempt overtaken while it waited on the wallet', () => {
	let wallet: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = 'http://localhost:3000';
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

	function installWallet() {
		wallet = installLockableWallet({uuid: 'uuid-two', name: WALLET_NAME, rdns: 'com.example.two', accounts: [A, B]});
		return wallet;
	}

	it('a slow connect to A does not land over a later connect to B', async () => {
		const release = installWallet().holdNext('eth_accounts');
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		const slow = connection.connect({type: 'wallet', name: WALLET_NAME, address: A});
		await vi.advanceTimersByTimeAsync(10);
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		expect(snapshot().account.address).toBe(B);

		release();
		await slow;
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().wallet.status).toBe('connected');
	});

	it('of two connects to the same wallet answered in order, the later one wins', async () => {
		// FOUND IN REVIEW. Both attempts publish the same `WaitingForWalletConnection` (the mechanism
		// carries no address yet), so inferring "the flow moved" from the published state alone missed
		// the second one starting, and the OLDER attempt, finishing first, overtook the newer. Starting
		// an attempt has to count as a move in its own right.
		installWallet();
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		const first = connection.connect({type: 'wallet', name: WALLET_NAME, address: A});
		const second = connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
		await Promise.all([first, second]);
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().wallet.status).toBe('connected');
		expect(wallet!.listenerCount('chainChanged')).toBe(1);
		expect(wallet!.listenerCount('accountsChanged')).toBe(1);
	});

	it('a selectWallet made while an auto-connect waits wins, and keeps the wallet watched', async () => {
		// FOUND IN REVIEW. `selectWallet` stops the live wallet's watchers before it awaits, so if it
		// were the one to yield, the wallet it had stopped watching would stay unwatched. As the newer
		// attempt it must win instead, and register its own.
		localStorage.setItem('__last_wallet', JSON.stringify({type: 'wallet', name: WALLET_NAME, address: A}));
		const release = installWallet().holdNext('eth_accounts');
		const connection = createConnection({
			chainInfo,
			targetStep: 'WalletConnected',
			prioritizeWalletProvider: true,
		});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		// The auto-connect has its chain id and waits on `eth_accounts`; `selectWallet` now waits on its
		// own `eth_chainId`. The auto-connect is answered FIRST, which is the order that matters.
		const releaseChoice = wallet!.holdNext('eth_chainId');
		const choosing = connection.selectWallet(WALLET_NAME);
		await vi.advanceTimersByTimeAsync(10);
		release();
		await vi.advanceTimersByTimeAsync(10);
		releaseChoice();
		await choosing;
		await vi.advanceTimersByTimeAsync(2000);

		expect(snapshot().step).toBe('WalletChosen');
		expect(wallet!.listenerCount('chainChanged')).toBe(1);
		wallet!.setChainId('0x2');
		expect(snapshot().wallet.chainId).toBe('2');
	});

	it('an attempt that fails AFTER publishing its own result still reports the failure', async () => {
		// The overtake check cannot tell "something newer moved the flow" from "this attempt moved it
		// itself", so without care a throw after the attempt's own publish was swallowed as overtaken.
		// A wallet answering the auto-sign with something that is not a signature then left the flow on
		// `WaitingForSignature` for good, which `ensureConnected` reads as in progress and waits on.
		installWallet().setSignature('0xnot-a-signature');
		const connection = createConnection({chainInfo, walletOnly: true, targetStep: 'SignedIn', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		await connection.connect({type: 'wallet', name: WALLET_NAME, address: A}, {requestSignatureRightAway: true});
		await vi.advanceTimersByTimeAsync(100);

		expect(snapshot().step).not.toBe('WaitingForSignature');
		expect(snapshot().error).toBeDefined();
	});

	it('a selectWallet that yields leaves the wallet it stopped watching watched again', async () => {
		// `selectWallet` stops the live wallet's watchers before it awaits. When a move that KEEPS that
		// wallet overtakes it (a signature, here), nothing else re-registers them, so yielding has to.
		installWallet();
		const connection = createConnection({chainInfo, walletOnly: true, targetStep: 'SignedIn', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: A});

		const release = wallet!.holdNext('eth_chainId');
		const choosing = connection.selectWallet(WALLET_NAME);
		await vi.advanceTimersByTimeAsync(10);
		await connection.requestSignature();
		expect(snapshot().step).toBe('SignedIn');

		release();
		await choosing;
		await vi.advanceTimersByTimeAsync(10);

		expect(snapshot().step).toBe('SignedIn');
		expect(wallet!.listenerCount('accountsChanged')).toBe(1);
		expect(wallet!.listenerCount('chainChanged')).toBe(1);
		wallet!.setChainId('0x2');
		expect(snapshot().wallet.chainId).toBe('2');
	});

	it('a slow connect that then times out does not tear down a later connect', async () => {
		installWallet().holdNext('eth_accounts');
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		const slow = connection.connect({type: 'wallet', name: WALLET_NAME, address: A});
		await vi.advanceTimersByTimeAsync(10);
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});

		// Past the 5s `withTimeout` on the held read.
		await vi.advanceTimersByTimeAsync(6000);
		await slow;

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().wallet).toBeDefined();
	});

	it('a slow selectWallet does not drop a later connect back to an unconnected choice', async () => {
		const release = installWallet().holdNext('eth_chainId');
		const connection = createConnection({
			chainInfo,
			targetStep: 'WalletConnected',
			autoConnect: false,
			prioritizeWalletProvider: true,
		});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);

		const choosing = connection.selectWallet(WALLET_NAME);
		await vi.advanceTimersByTimeAsync(10);
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: A});
		expect(snapshot().step).toBe('WalletConnected');

		release();
		await choosing;
		await vi.advanceTimersByTimeAsync(100);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(A);
		expect(snapshot().wallet.status).toBe('connected');
	});

	it("A's signature, landing after the app moved to B, does not sign B in", async () => {
		installWallet();
		const connection = createConnection({chainInfo, walletOnly: true, targetStep: 'SignedIn', autoConnect: false});
		const snapshot = snapshotOf(connection);
		await vi.advanceTimersByTimeAsync(200);
		await connection.connect({type: 'wallet', name: WALLET_NAME, address: A});

		let releaseSignature!: () => void;
		wallet!.whileSigning = () =>
			new Promise<void>((resolve) => {
				releaseSignature = resolve;
			});
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(10);
		expect(snapshot().step).toBe('WaitingForSignature');

		wallet!.whileSigning = undefined;
		await connection.connect(
			{type: 'wallet', name: WALLET_NAME, address: B},
			{requireUserConfirmationBeforeSignatureRequest: true},
		);
		expect(snapshot().step).toBe('WalletConnected');

		releaseSignature();
		await signing;
		await vi.advanceTimersByTimeAsync(100);

		expect(snapshot().step).toBe('WalletConnected');
		expect(snapshot().account.address).toBe(B);
		expect(snapshot().account.signer).toBeUndefined();
		expect(localStorage.getItem('__origin_account')).toBeNull();
	});
});
