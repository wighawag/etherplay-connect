// Regression tests for per-connection storage namespacing.
//
// A page may legitimately run more than one connection: a player connection (hosted sign-in,
// `targetStep: 'SignedIn'`) and a separate payment connection (`targetStep: 'WalletConnected'`,
// `autoConnect: false`) so whoever pays need not be the account the player signed in as.
//
// Before `storagePrefix`, both connections wrote the same two module-level keys
// (`__origin_account`, `__last_wallet`) in both `localStorage` and `sessionStorage`, so they
// overwrote and deleted each other's state. These tests pin down that a prefix fully separates
// them, and that no prefix keeps the historical keys byte-identical.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import type {
	WalletConnector,
	WalletHandle,
	WalletProvider,
	AlwaysOnProviderWrapper,
	AccountGenerator,
} from '@etherplay/wallet-connector';
import {createConnection, type ChainInfo} from '../src/index.js';

type MockUnderlyingProvider = {request: ReturnType<typeof vi.fn>};

// The two accounts from the verified reproduction: A is the player, B is the payer.
const ACCOUNT_A = `0x05624ada${'0'.repeat(28)}37b8` as `0x${string}`;
const ACCOUNT_B = `0xd8da6bf2${'0'.repeat(28)}6045` as `0x${string}`;

// A valid-hex signature, so the real `fromSignatureToKey` / `fromEntropyKeyToMnemonic` in
// @etherplay/connect-core can derive a session account from it.
const SIGNATURE = `0x${'ab'.repeat(32)}` as `0x${string}`;

const PLAYER_KEY_ACCOUNT = '__origin_account';
const PLAYER_KEY_LAST_WALLET = '__last_wallet';
const PAYMENT_PREFIX = 'payment:';
const PAYMENT_KEY_ACCOUNT = `${PAYMENT_PREFIX}__origin_account`;
const PAYMENT_KEY_LAST_WALLET = `${PAYMENT_PREFIX}__last_wallet`;

function createMockWalletProvider(
	accounts: `0x${string}`[],
	chainId: `0x${string}` = '0x1',
): WalletProvider<MockUnderlyingProvider> {
	return {
		underlyingProvider: {request: vi.fn()},
		signMessage: vi.fn().mockResolvedValue(SIGNATURE),
		getChainId: vi.fn().mockResolvedValue(chainId),
		requestAccounts: vi.fn().mockResolvedValue(accounts),
		getAccounts: vi.fn().mockResolvedValue(accounts),
		listenForAccountsChanged: vi.fn(),
		stopListenForAccountsChanged: vi.fn(),
		listenForChainChanged: vi.fn(),
		stopListenForChainChanged: vi.fn(),
		switchChain: vi.fn().mockResolvedValue(null),
		addChain: vi.fn().mockResolvedValue(null),
	};
}

function createMockWalletHandle(name: string, accounts: `0x${string}`[]): WalletHandle<MockUnderlyingProvider> {
	return {
		info: {uuid: `uuid-${name}`, name, icon: '', rdns: `com.mock.${name.toLowerCase()}`},
		walletProvider: createMockWalletProvider(accounts),
	};
}

function createMockAccountGenerator(): AccountGenerator {
	return {
		type: 'ethereum',
		fromMnemonicToAccount: vi.fn(() => ({
			address: '0xoriginaddress' as `0x${string}`,
			publicKey: '0xpublickey' as `0x${string}`,
			privateKey: '0xprivatekey' as `0x${string}`,
		})),
		signTextMessage: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
	};
}

// Announces synchronously, which is all these tests need: they are about what gets persisted,
// not about announcement timing.
function createMockWalletConnector(
	walletHandles: WalletHandle<MockUnderlyingProvider>[],
): WalletConnector<MockUnderlyingProvider> {
	const alwaysOnProvider: AlwaysOnProviderWrapper<MockUnderlyingProvider> = {
		chainId: '1',
		provider: {request: vi.fn()},
		setWalletProvider: vi.fn(),
		setWalletStatus: vi.fn(),
		onRequest: vi.fn(() => () => {}),
		getPendingRequests: vi.fn(() => []),
	};
	return {
		fetchWallets: vi.fn((callback) => {
			for (const handle of walletHandles) {
				callback(handle);
			}
		}),
		createAlwaysOnProvider: vi.fn(() => alwaysOnProvider),
		accountGenerator: createMockAccountGenerator(),
	};
}

const chainInfo: ChainInfo<MockUnderlyingProvider> = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
};

/** The player connection: hosted sign-in, wallet-only, signing right after connecting. */
function createPlayerConnection(options?: {storagePrefix?: string; autoConnect?: boolean}) {
	const walletConnector = createMockWalletConnector([createMockWalletHandle('PlayerWallet', [ACCOUNT_A])]);
	return createConnection({
		walletHost: 'https://wallet.example.com',
		walletOnly: true,
		// happy-dom does not expose the bare `origin` global that `originToSignWith()` falls back to.
		signingOrigin: 'https://app.example.com',
		chainInfo,
		walletConnector,
		autoConnect: options?.autoConnect ?? false,
		requestSignatureAutomaticallyIfPossible: true,
		storagePrefix: options?.storagePrefix,
	});
}

/** The payment connection: wallet only, never auto-connects, its own storage namespace. */
function createPaymentConnection(options?: {storagePrefix?: string; autoConnect?: boolean; walletName?: string}) {
	const walletConnector = createMockWalletConnector([
		createMockWalletHandle(options?.walletName ?? 'PaymentWallet', [ACCOUNT_B]),
	]);
	return createConnection({
		targetStep: 'WalletConnected',
		chainInfo,
		walletConnector,
		autoConnect: options?.autoConnect ?? false,
		storagePrefix: options?.storagePrefix ?? PAYMENT_PREFIX,
	});
}

function readJSON(storage: Storage, key: string): any {
	const raw = storage.getItem(key);
	return raw === null ? undefined : JSON.parse(raw);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('storagePrefix: default (no prefix)', () => {
	it('uses exactly the historical keys, in both localStorage and sessionStorage', async () => {
		const player = createPlayerConnection();

		const connectPromise = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await connectPromise;

		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({
			type: 'wallet',
			name: 'PlayerWallet',
			address: ACCOUNT_A,
		});
		expect(readJSON(sessionStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(localStorage, PLAYER_KEY_ACCOUNT)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(sessionStorage, PLAYER_KEY_ACCOUNT)).toMatchObject({address: ACCOUNT_A});

		// No other key is persisted.
		expect(Object.keys(localStorage).sort()).toEqual([PLAYER_KEY_ACCOUNT, PLAYER_KEY_LAST_WALLET].sort());
		expect(Object.keys(sessionStorage).sort()).toEqual([PLAYER_KEY_ACCOUNT, PLAYER_KEY_LAST_WALLET].sort());
	});
});

describe('storagePrefix: two connections in one page', () => {
	it('a payment connection connecting as B leaves the player last-wallet naming A', async () => {
		// 1. Sign in on the player connection with wallet account A.
		const player = createPlayerConnection();
		const playerConnect = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await playerConnect;
		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});

		// 2. Pay through the payment connection, whose wallet has account B selected.
		const payment = createPaymentConnection();
		const paid = payment.ensureConnected({doNotStoreLocally: true});
		await vi.advanceTimersByTimeAsync(100);
		await paid;

		// 3. The player namespace is untouched: it still names A, not B.
		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(sessionStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(localStorage, PLAYER_KEY_ACCOUNT)).toMatchObject({address: ACCOUNT_A});

		// ...and the payer's wallet is remembered in the PAYMENT namespace, which is wanted.
		expect(readJSON(localStorage, PAYMENT_KEY_LAST_WALLET)).toMatchObject({
			type: 'wallet',
			name: 'PaymentWallet',
			address: ACCOUNT_B,
		});
	});

	it('reproduces the reported sequence: clearing the player key, the payment connection must not refill it', async () => {
		// The verified reproduction removed `__last_wallet` between the two steps, which is what
		// proved the payment connection was the writer. Namespaced, the key must stay absent.
		const player = createPlayerConnection();
		const playerConnect = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await playerConnect;
		expect(localStorage.getItem(PLAYER_KEY_LAST_WALLET)).not.toBeNull();

		localStorage.removeItem(PLAYER_KEY_LAST_WALLET);
		sessionStorage.removeItem(PLAYER_KEY_LAST_WALLET);

		const payment = createPaymentConnection();
		const paid = payment.ensureConnected({doNotStoreLocally: true});
		await vi.advanceTimersByTimeAsync(100);
		await paid;

		expect(localStorage.getItem(PLAYER_KEY_LAST_WALLET)).toBeNull();
		expect(sessionStorage.getItem(PLAYER_KEY_LAST_WALLET)).toBeNull();
		expect(readJSON(localStorage, PAYMENT_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_B});
	});

	it('disconnect() on the payment connection only clears the payment namespace', async () => {
		const player = createPlayerConnection();
		const playerConnect = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await playerConnect;

		const payment = createPaymentConnection();
		const paid = payment.ensureConnected();
		await vi.advanceTimersByTimeAsync(100);
		await paid;
		expect(localStorage.getItem(PAYMENT_KEY_LAST_WALLET)).not.toBeNull();

		payment.disconnect();

		expect(localStorage.getItem(PAYMENT_KEY_LAST_WALLET)).toBeNull();
		expect(localStorage.getItem(PAYMENT_KEY_ACCOUNT)).toBeNull();
		expect(sessionStorage.getItem(PAYMENT_KEY_LAST_WALLET)).toBeNull();
		// The player's stored identity survives.
		expect(readJSON(localStorage, PLAYER_KEY_ACCOUNT)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(sessionStorage, PLAYER_KEY_ACCOUNT)).toMatchObject({address: ACCOUNT_A});
	});

	it('cancel() on the payment connection only clears the payment last-wallet hint', async () => {
		const player = createPlayerConnection();
		const playerConnect = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await playerConnect;

		const payment = createPaymentConnection();
		const paid = payment.ensureConnected();
		await vi.advanceTimersByTimeAsync(100);
		await paid;

		payment.cancel();

		expect(localStorage.getItem(PAYMENT_KEY_LAST_WALLET)).toBeNull();
		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
		expect(readJSON(sessionStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
	});

	it('auto-connect only reads its own namespace', async () => {
		// Only the unprefixed namespace holds a last-wallet hint.
		const hint = JSON.stringify({type: 'wallet', name: 'PaymentWallet', address: ACCOUNT_A});
		localStorage.setItem(PLAYER_KEY_LAST_WALLET, hint);

		// A prefixed connection whose own namespace is empty must not pick that hint up,
		// even though the wallet it names is present and announcing.
		const payment = createPaymentConnection({autoConnect: true});
		await vi.advanceTimersByTimeAsync(1500);

		let step: string | undefined;
		payment.subscribe((state) => {
			step = state.step;
		})();
		expect(step).toBe('Idle');
	});

	it('auto-connect uses the hint stored in its own namespace', async () => {
		localStorage.setItem(
			PAYMENT_KEY_LAST_WALLET,
			JSON.stringify({type: 'wallet', name: 'PaymentWallet', address: ACCOUNT_B}),
		);

		const payment = createPaymentConnection({autoConnect: true});
		await vi.advanceTimersByTimeAsync(1500);

		let step: string | undefined;
		payment.subscribe((state) => {
			step = state.step;
		})();
		expect(step).toBe('WalletConnected');
	});
});

describe('doNotStoreLocally keeps gating exactly the origin account', () => {
	it('does not save the origin account, but still remembers the last wallet', async () => {
		const player = createPlayerConnection();

		const connectPromise = player.connect({type: 'wallet'}, {doNotStoreLocally: true});
		await vi.advanceTimersByTimeAsync(100);
		await connectPromise;

		expect(localStorage.getItem(PLAYER_KEY_ACCOUNT)).toBeNull();
		expect(sessionStorage.getItem(PLAYER_KEY_ACCOUNT)).toBeNull();
		// saveLastWallet is deliberately unconditional: remembering the wallet is wanted for every
		// connection, and with namespacing it can no longer collide with another connection's.
		expect(readJSON(localStorage, PLAYER_KEY_LAST_WALLET)).toMatchObject({address: ACCOUNT_A});
	});
});
