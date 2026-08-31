// "Have we got there yet", which is the question consumers branch their whole UI on.
//
// There are two of them, `connection.isTargetStepReached(state)` and the exported
// `isTargetStepReached(state, target, walletOnly?)`, and they have to answer identically: the first
// is the second with the connection's own configuration filled in. A consumer typically uses the
// method, and a shared component (a navbar that takes any connection) uses the function, so a
// disagreement shows up as one part of an app thinking it is connected while another does not.
//
// The rule underneath is "the target, or better": a lower target is satisfied by a higher state, so
// a read-only consumer can share a connection with one that signs.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, isTargetStepReached, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET = 'Target Wallet';

describe('target-step checks', () => {
	let wallet: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		wallet = installLockableWallet({uuid: 'uuid-t', name: WALLET, rdns: 'com.example.target'});
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

	/** Drive a connection to each of the three interesting states and return their snapshots. */
	async function statesOfEachKind() {
		const chosenConnection = createConnection({chainInfo, targetStep: 'WalletChosen', autoConnect: false});
		await chosenConnection.selectWallet(WALLET);
		await vi.advanceTimersByTimeAsync(100);
		const chosen = snapshotOf(chosenConnection)();
		expect(chosen.step).toBe('WalletChosen');

		const connectedConnection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const connecting = connectedConnection.connect({type: 'wallet', name: WALLET});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const connected = snapshotOf(connectedConnection)();
		expect(connected.step).toBe('WalletConnected');

		const signedInConnection = createConnection({chainInfo, walletOnly: true, autoConnect: false});
		const connecting2 = signedInConnection.connect({type: 'wallet', name: WALLET});
		await vi.advanceTimersByTimeAsync(200);
		await connecting2;
		const signing = signedInConnection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		const signedIn = snapshotOf(signedInConnection)();
		expect(signedIn.step).toBe('SignedIn');

		const idle = snapshotOf(createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false}))();

		return {chosen, connected, signedIn, idle};
	}

	it('accepts the target or better, and nothing lower', async () => {
		// The whole table in one place, because the interesting property is the SHAPE of it: true
		// spreads to the right, never to the left.
		const {chosen, connected, signedIn, idle} = await statesOfEachKind();

		expect(isTargetStepReached(idle, 'WalletChosen')).toBe(false);
		expect(isTargetStepReached(chosen, 'WalletChosen')).toBe(true);
		expect(isTargetStepReached(connected, 'WalletChosen')).toBe(true);
		expect(isTargetStepReached(signedIn, 'WalletChosen')).toBe(true);

		expect(isTargetStepReached(chosen, 'WalletConnected')).toBe(false);
		expect(isTargetStepReached(connected, 'WalletConnected')).toBe(true);
		expect(isTargetStepReached(signedIn, 'WalletConnected')).toBe(true);

		expect(isTargetStepReached(chosen, 'SignedIn')).toBe(false);
		expect(isTargetStepReached(connected, 'SignedIn')).toBe(false);
		expect(isTargetStepReached(signedIn, 'SignedIn')).toBe(true);
	});

	it('agrees with the store method, for every configured target', async () => {
		// The method is the function with the connection's own configuration filled in. If these two
		// ever disagreed, a shared component and its host app would render different realities.
		const {chosen, connected, signedIn, idle} = await statesOfEachKind();
		const forTarget = (targetStep: 'WalletChosen' | 'WalletConnected' | 'SignedIn') =>
			createConnection({chainInfo, targetStep, autoConnect: false});

		for (const [targetStep, connection] of [
			['WalletChosen', forTarget('WalletChosen')],
			['WalletConnected', forTarget('WalletConnected')],
			['SignedIn', forTarget('SignedIn')],
		] as const) {
			for (const state of [idle, chosen, connected, signedIn]) {
				expect(connection.isTargetStepReached(state), `${targetStep} vs ${state.step}`).toBe(
					isTargetStepReached(state, targetStep),
				);
			}
		}
	});

	it('requires the wallet when the connection is wallet-only, and not otherwise', async () => {
		// The one place the two answers legitimately differ: `walletOnly` narrows what `SignedIn`
		// counts as. A hosted account IS signed in, but not to a connection that exists to have a
		// wallet behind it, and a payment flow relying on that must not be told otherwise.
		const hostedSignedIn = {
			step: 'SignedIn',
			mechanism: {type: 'email'},
			account: {address: '0xaaaa000000000000000000000000000000000aaa'},
			wallet: undefined,
			wallets: [],
			pendingRequests: [],
		} as unknown as Connection<any>;

		const walletOnly = createConnection({chainInfo, walletOnly: true, autoConnect: false});
		const anyMechanism = createConnection({walletHost: 'https://wallet.example.com', chainInfo, autoConnect: false});

		expect(walletOnly.isTargetStepReached(hostedSignedIn)).toBe(false);
		expect(anyMechanism.isTargetStepReached(hostedSignedIn)).toBe(true);
		// And the same distinction through the free function's third argument.
		expect(isTargetStepReached(hostedSignedIn, 'SignedIn', true)).toBe(false);
		expect(isTargetStepReached(hostedSignedIn, 'SignedIn')).toBe(true);
	});

	it('exposes the wrapper request events on the store', async () => {
		// The other way to watch requests, for a consumer that would rather have a callback than
		// diff `pendingRequests` on every publish. It is the wrapper's own subscription, so it sees
		// the same events the store mirrors.
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const seen: string[] = [];
		const unsubscribe = connection.onRequest((event) => seen.push(`${event.type}:${event.request.kind}`));

		const connecting = connection.connect({type: 'wallet', name: WALLET});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const sending = connection.provider
			.request({
				method: 'eth_sendTransaction',
				params: [
					{from: '0x1111111111111111111111111111111111111111', to: '0x1111111111111111111111111111111111111111'},
				],
			} as any)
			.catch(() => {});
		await vi.advanceTimersByTimeAsync(50);
		expect(seen).toEqual(['requestStart:transaction']);

		wallet!.releaseTransaction();
		await sending;
		await vi.advanceTimersByTimeAsync(50);
		expect(seen).toEqual(['requestStart:transaction', 'requestEnd:transaction']);

		unsubscribe();
	});
});
