// An app can BRING a wallet, instead of only discovering the ones the page happens to have.
//
// `createConnection` used to have exactly one source of wallets: EIP-6963 discovery on `window`.
// An app running a chain IN THE TAB, with a key it generated itself, therefore had no way to say
// "this connection is about that wallet" other than subclassing the connector and overriding
// `fetchWallets` to announce a single handle, inheriting `createAlwaysOnProvider` and
// `accountGenerator` unchanged. That subclass was a class whose entire content was a list.
//
// It is not only ceremony, which is why the fix is a first-class setting rather than a helper. A
// wallet the app constructed and a wallet the user installed are two different populations: the
// first belongs to ONE connection and the second belongs to the page. Discovering the first from
// `window` would mix them in both directions, so supplying `wallets` replaces discovery outright.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection, type UnderlyingEthereumProvider} from '../src/index.js';
import {createBroughtWallet} from './fixtures/brought-wallet.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

function snapshotOf(connection: {
	subscribe: (run: (value: Connection<UnderlyingEthereumProvider>) => void) => () => void;
}) {
	return () => {
		let state!: Connection<UnderlyingEthereumProvider>;
		connection.subscribe((value) => {
			state = value;
		})();
		return state;
	};
}

describe('a connection the app supplies the wallets for', () => {
	let pageWallet: LockableWallet | undefined;
	let discoveryRequests = 0;
	const countDiscovery = () => {
		discoveryRequests++;
	};

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		discoveryRequests = 0;
		window.addEventListener('eip6963:requestProvider', countDiscovery);
		vi.useFakeTimers();
	});

	afterEach(() => {
		window.removeEventListener('eip6963:requestProvider', countDiscovery);
		pageWallet?.uninstall();
		pageWallet = undefined;
		vi.useRealTimers();
	});

	it('lists exactly the supplied wallet, with no connector subclass anywhere', () => {
		const world = createBroughtWallet();

		// The DEFAULT connector: no subclass, no custom `fetchWallets`, no `accountGenerator` to
		// re-declare. The only thing this caller says is which wallets this connection is about.
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [world.handle],
		});

		const state = snapshotOf(connection)();
		expect(state.wallets).toHaveLength(1);
		expect(state.wallets[0]).toBe(world.handle);
	});

	it('does not ask the page for wallets, and does not take the ones it has', () => {
		// The population argument, made concrete: an installed extension is announcing itself in this
		// page for anyone who asks. This connection is not about it, so it must neither ask nor listen.
		pageWallet = installLockableWallet({uuid: 'uuid-installed', name: 'Installed Wallet'});
		const world = createBroughtWallet();

		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [world.handle],
		});

		expect(discoveryRequests).toBe(0);
		const wallets = snapshotOf(connection)().wallets;
		expect(wallets).toHaveLength(1);
		expect(wallets[0].info.name).toBe('World Wallet');

		// Not even later: a page-wide request from unrelated code re-announces every installed wallet
		// to every listener, and this connection must not be one.
		window.dispatchEvent(new Event('eip6963:requestProvider'));
		expect(snapshotOf(connection)().wallets).toHaveLength(1);
	});

	it('connects to the single supplied wallet without ever showing a picker', async () => {
		const world = createBroughtWallet();
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [world.handle],
		});
		const snapshot = snapshotOf(connection);

		const steps: string[] = [];
		const unsubscribe = connection.subscribe((state) => steps.push(state.step));

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		unsubscribe();

		const state = snapshot();
		expect(state.step).toBe('WalletConnected');
		expect(state.wallet?.accounts).toEqual([world.account]);
		// Not merely "it ended somewhere good": the picker steps were never passed through either, so
		// an app rendering on `step` has nothing to render for them.
		expect(steps).not.toContain('WalletToChoose');
		expect(steps).not.toContain('MechanismToChoose');
	});

	it('names the supplied wallet on the connected state', async () => {
		const world = createBroughtWallet({name: 'Embedded World'});
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [world.handle],
		});

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// `wallet.info` is stamped from the announced handle, so "which wallet am I connected to" is
		// answerable without matching `mechanism.name` against the list by hand.
		expect(snapshotOf(connection)().wallet?.info?.name).toBe('Embedded World');
	});

	it('lets a supplied wallet and a discovered one run side by side, in two connections', async () => {
		pageWallet = installLockableWallet({uuid: 'uuid-installed', name: 'Installed Wallet'});
		const world = createBroughtWallet();

		const worldConnection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'world:',
			wallets: [world.handle],
		});
		const pageConnection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'page:',
		});

		// The ordinary connection still discovers: supplying wallets is per connection, and says
		// nothing about any other.
		expect(discoveryRequests).toBe(1);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshotOf(pageConnection)().wallets.map((w) => w.info.name)).toEqual(['Installed Wallet']);
		expect(snapshotOf(worldConnection)().wallets.map((w) => w.info.name)).toEqual(['World Wallet']);
	});

	it('deduplicates a wallet supplied twice, exactly as it deduplicates a repeated announcement', () => {
		const world = createBroughtWallet();
		// DISTINCT handle objects carrying the same identity, which is what a repeated announcement
		// produces and what the dedupe rule is actually about (`uuid`, falling back to `rdns`).
		// Supplying the same object twice would pass against a dedupe that only compared references.
		const sameWalletAgain = {info: {...world.handle.info}, walletProvider: world.handle.walletProvider};
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [world.handle, sameWalletAgain, world.handle],
		});

		const wallets = snapshotOf(connection)().wallets;
		expect(wallets).toHaveLength(1);
		expect(wallets[0]).toBe(world.handle);
	});

	it('treats an EMPTY supplied list as "no wallets", not as "discover some"', async () => {
		// `wallets: maybeList ?? []` and `wallets: list.filter(...)` are ordinary things to write, and
		// both can produce `[]`. Falling back to discovery there would enrol every extension in the page
		// into a connection the caller meant to keep to itself, which is the conflation this setting
		// exists to prevent, arriving silently. An empty picker is the loud answer, and the right one.
		pageWallet = installLockableWallet({uuid: 'uuid-installed', name: 'Installed Wallet'});

		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			wallets: [],
		});

		expect(discoveryRequests).toBe(0);
		await vi.advanceTimersByTimeAsync(200);
		expect(snapshotOf(connection)().wallets).toEqual([]);

		// `undefined` is how a caller asks for discovery, and it is what omitting the key means.
		const discovering = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'discovering:',
			wallets: undefined,
		});
		expect(discoveryRequests).toBe(1);
		expect(snapshotOf(discovering)().wallets).toHaveLength(1);
	});

	it('still discovers when no wallets are supplied', async () => {
		// The control, and the compatibility promise: every existing caller passes no `wallets` and
		// must be untouched.
		pageWallet = installLockableWallet({uuid: 'uuid-installed', name: 'Installed Wallet'});

		const connection = createConnection({targetStep: 'WalletConnected', chainInfo, autoConnect: false});

		expect(discoveryRequests).toBe(1);
		expect(snapshotOf(connection)().wallets.map((w) => w.info.name)).toEqual(['Installed Wallet']);
	});

	it('auto-connects to a supplied wallet on the next page load', async () => {
		// Supplied wallets have to be in the list before the auto-connect path looks for them by name,
		// or a returning user's session would be dropped on every reload.
		const world = createBroughtWallet();
		const first = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'world:',
			wallets: [world.handle],
		});
		const connecting = first.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const reloaded = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			storagePrefix: 'world:',
			wallets: [createBroughtWallet().handle],
		});
		await vi.advanceTimersByTimeAsync(300);

		const state = snapshotOf(reloaded)();
		expect(state.step).toBe('WalletConnected');
		expect(state.account?.address).toBe(world.account);
	});
});
