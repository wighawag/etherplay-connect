// The "chosen but unconnected" configuration: `targetStep: 'WalletChosen'`.
//
// It means: let the user PICK a wallet via EIP-6963 and set it as the read provider, WITHOUT
// going through the connect/accounts flow. The wallet's provider is set on the always-on
// wrapper so reads route through it (when `prioritizeWalletProvider` is true), but no accounts
// are requested and signing is refused (status: 'disconnected').
//
// The motivating consumer is a blockchain indexer that only calls eth_chainId, eth_blockNumber
// and eth_getLogs: it wants the user's own wallet as its node (a genuinely decentralised read
// path) but has no need for accounts or signing, so requiring eth_requestAccounts is friction
// that buys nothing.
//
// These tests use the REAL default Ethereum connector and a REAL EIP-6963 announcement, so the
// provider routing is exercised end-to-end.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, isTargetStepReached, type Connection, type UnderlyingEthereumProvider} from '../src/index.js';

const ACCOUNT = `0x1111111111111111111111111111111111111111` as `0x${string}`;

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

type InstalledWallet = {
	uninstall: () => void;
	requestAccountsCalls: () => number;
	getAccountsCalls: () => number;
	chainIdCalls: () => number;
	blockNumberCalls: () => number;
	rejectAuthorization: (error: unknown) => void;
	setChainIdFailure: (fail: boolean) => void;
};

function installWallet(options?: {
	uuid?: string;
	rdns?: string;
	name?: string;
	accounts?: `0x${string}`[];
	chainId?: string;
}) {
	const info = {
		uuid: options?.uuid ?? 'uuid-injected-wallet',
		name: options?.name ?? 'Injected Wallet',
		icon: '',
		rdns: options?.rdns ?? 'com.example.injected',
	};

	const accounts = options?.accounts ?? [ACCOUNT];
	const chainId = options?.chainId ?? '0x1';
	let authorizationError: unknown | undefined;
	let failChainId = false;

	let requestAccountsCount = 0;
	let getAccountsCount = 0;
	let chainIdCount = 0;
	let blockNumberCount = 0;

	const provider = {
		request: async ({method, params}: {method: string; params?: any[]}) => {
			switch (method) {
				case 'eth_chainId':
					chainIdCount++;
					if (failChainId) {
						throw new Error('chain id unavailable');
					}
					return chainId;
				case 'eth_accounts':
					getAccountsCount++;
					return authorizationError ? [] : accounts;
				case 'eth_requestAccounts':
					requestAccountsCount++;
					if (authorizationError) {
						throw authorizationError;
					}
					return accounts;
				case 'personal_sign':
					return `0x${'ab'.repeat(65)}` as `0x${string}`;
				case 'eth_blockNumber':
					blockNumberCount++;
					return '0x100';
				case 'eth_getLogs':
					return [];
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: () => {},
		removeListener: () => {},
	};

	const onRequest = () => {
		window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info, provider}}));
	};
	window.addEventListener('eip6963:requestProvider', onRequest);

	const installed: InstalledWallet = {
		uninstall: () => window.removeEventListener('eip6963:requestProvider', onRequest),
		requestAccountsCalls: () => requestAccountsCount,
		getAccountsCalls: () => getAccountsCount,
		chainIdCalls: () => chainIdCount,
		blockNumberCalls: () => blockNumberCount,
		rejectAuthorization: (error) => {
			authorizationError = error;
		},
		setChainIdFailure: (fail) => {
			failChainId = fail;
		},
	};
	return installed;
}

function createWalletChosenConnection(overrides?: {
	autoConnect?: boolean;
	prioritizeWalletProvider?: boolean;
	storagePrefix?: string;
}) {
	return createConnection({
		targetStep: 'WalletChosen',
		chainInfo,
		autoConnect: overrides?.autoConnect ?? false,
		prioritizeWalletProvider: overrides?.prioritizeWalletProvider ?? true,
		storagePrefix: overrides?.storagePrefix,
	});
}

function currentState(store: {
	subscribe: (run: (v: Connection<UnderlyingEthereumProvider>) => void) => () => void;
}): Connection<UnderlyingEthereumProvider> {
	let value!: Connection<UnderlyingEthereumProvider>;
	store.subscribe((v) => {
		value = v;
	})();
	return value;
}

function recordSteps(store: {subscribe: (run: (v: Connection<UnderlyingEthereumProvider>) => void) => () => void}) {
	const steps: string[] = [];
	const unsubscribe = store.subscribe((v) => {
		if (steps[steps.length - 1] !== v.step) {
			steps.push(v.step);
		}
	});
	return {steps, unsubscribe};
}

describe('WalletChosen target', () => {
	let wallet: InstalledWallet;

	beforeEach(() => {
		vi.useFakeTimers();
		localStorage.clear();
		sessionStorage.clear();
		wallet = installWallet();
	});

	afterEach(() => {
		wallet.uninstall();
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('selectWallet', () => {
		it('should transition to WalletChosen when a wallet is selected', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			if (state.step === 'WalletChosen') {
				expect(state.wallet.status).toBe('disconnected');
				expect(state.wallet.accounts).toEqual([]);
				expect(state.mechanism.name).toBe('Injected Wallet');
			}
		});

		it('should NOT call eth_requestAccounts or eth_accounts', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			expect(wallet.requestAccountsCalls()).toBe(0);
			expect(wallet.getAccountsCalls()).toBe(0);
		});

		it('should call eth_chainId to get the chain ID', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			expect(wallet.chainIdCalls()).toBeGreaterThan(0);
		});

		it('should auto-select when only one wallet is detected and no name is given', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet();
			vi.advanceTimersByTime(100);

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
		});

		it('should transition to WalletToChoose when multiple wallets are detected and no name is given', async () => {
			const wallet2 = installWallet({
				uuid: 'uuid-wallet-2',
				rdns: 'com.example.other',
				name: 'Other Wallet',
			});
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet();
			vi.advanceTimersByTime(100);

			const state = currentState(store);
			expect(state.step).toBe('WalletToChoose');

			wallet2.uninstall();
		});

		it('should persist the wallet choice to lastWallet storage', async () => {
			const store = createWalletChosenConnection({storagePrefix: 'test-'});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			const stored = localStorage.getItem('test-__last_wallet');
			expect(stored).toBeTruthy();
			const parsed = JSON.parse(stored!);
			expect(parsed.type).toBe('wallet');
			expect(parsed.name).toBe('Injected Wallet');
			expect(parsed.address).toBeUndefined();
		});
		it('should keep the current choice when selectWallet is called with an unknown name', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);
			expect(currentState(store).step).toBe('WalletChosen');

			// A lookup miss attempts nothing: it must NOT tear down the existing choice.
			await store.selectWallet('No Such Wallet');
			vi.advanceTimersByTime(100);

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			expect(state.error?.message).toBe('failed to get wallet No Such Wallet');
			if (state.step === 'WalletChosen') {
				expect(state.mechanism.name).toBe('Injected Wallet');
				expect(state.wallet.status).toBe('disconnected');
			}
		});

		it('should not persist the choice when doNotStoreLocally is set', async () => {
			const store = createWalletChosenConnection({storagePrefix: 'test-nostore-'});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet', {doNotStoreLocally: true});
			vi.advanceTimersByTime(100);

			expect(currentState(store).step).toBe('WalletChosen');
			expect(localStorage.getItem('test-nostore-__last_wallet')).toBeNull();
			expect(sessionStorage.getItem('test-nostore-__last_wallet')).toBeNull();
		});
	});

	describe('isTargetStepReached', () => {
		it('should return true when step is WalletChosen and target is WalletChosen', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			const state = currentState(store);
			expect(isTargetStepReached(state, 'WalletChosen')).toBe(true);
			expect(store.isTargetStepReached(state)).toBe(true);
		});

		it('should return false when step is Idle and target is WalletChosen', () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			const state = currentState(store);
			expect(isTargetStepReached(state, 'WalletChosen')).toBe(false);
		});

		it('should return true when step is WalletConnected and target is WalletChosen (higher step satisfies lower target)', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			// Select then connect to reach WalletConnected
			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);
			await store.connect({type: 'wallet', name: 'Injected Wallet'});
			vi.advanceTimersByTime(200);

			const state = currentState(store);
			expect(state.step).toBe('WalletConnected');
			expect(isTargetStepReached(state, 'WalletChosen')).toBe(true);
		});
	});

	describe('auto-connect', () => {
		it('should restore the wallet choice on page load without requesting accounts', async () => {
			// Simulate a previous selection by writing to storage
			localStorage.setItem('test-__last_wallet', JSON.stringify({type: 'wallet', name: 'Injected Wallet'}));

			const store = createWalletChosenConnection({
				autoConnect: true,
				storagePrefix: 'test-',
			});
			await vi.advanceTimersByTimeAsync(1200);

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			if (state.step === 'WalletChosen') {
				expect(state.wallet.status).toBe('disconnected');
				expect(state.mechanism.name).toBe('Injected Wallet');
			}
			// Auto-connect for WalletChosen must NOT call eth_requestAccounts
			expect(wallet.requestAccountsCalls()).toBe(0);
		});

		it('should go to Idle when no lastWallet is in storage', async () => {
			const store = createWalletChosenConnection({autoConnect: true});
			await vi.advanceTimersByTimeAsync(1200);

			const state = currentState(store);
			expect(state.step).toBe('Idle');
		});
		it('should go to Idle (and drop the wallet) when the restored choice fails to answer', async () => {
			localStorage.setItem('test-fail-__last_wallet', JSON.stringify({type: 'wallet', name: 'Injected Wallet'}));
			// The wallet's eth_chainId fails (e.g. it became unreachable): Idle carries no
			// wallet, so the failed restore must not keep routing reads through it.
			wallet.setChainIdFailure(true);

			const store = createWalletChosenConnection({autoConnect: true, storagePrefix: 'test-fail-'});
			await vi.advanceTimersByTimeAsync(1200);

			const state = currentState(store);
			expect(state.step).toBe('Idle');
			expect(state.wallet).toBeUndefined();
		});
	});

	describe('disconnect', () => {
		it('should clear the wallet choice and transition to Idle', async () => {
			const store = createWalletChosenConnection({storagePrefix: 'test-'});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			expect(currentState(store).step).toBe('WalletChosen');

			store.disconnect();

			const state = currentState(store);
			expect(state.step).toBe('Idle');
			expect(state.wallet).toBeUndefined();
			// Storage should be cleared
			expect(localStorage.getItem('test-__last_wallet')).toBeNull();
		});
	});

	describe('upgrade from WalletChosen to WalletConnected', () => {
		it('should upgrade to WalletConnected when connect is called after selectWallet', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			expect(currentState(store).step).toBe('WalletChosen');

			const connectPromise = store.connect({type: 'wallet', name: 'Injected Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise;

			const state = currentState(store);
			expect(state.step).toBe('WalletConnected');
			if (state.step === 'WalletConnected') {
				expect(state.wallet.status).toBe('connected');
				expect(state.wallet.accounts).toContain(ACCOUNT.toLowerCase());
			}
		});

		it('should upgrade the currently chosen wallet when no name is given, even with multiple wallets installed', async () => {
			const otherWallet = installWallet({
				uuid: 'uuid-wallet-2',
				rdns: 'com.example.other',
				name: 'Other Wallet',
			});
			try {
				const store = createWalletChosenConnection();
				vi.advanceTimersByTime(200);

				await store.selectWallet('Injected Wallet');
				vi.advanceTimersByTime(100);
				expect(currentState(store).step).toBe('WalletChosen');

				const connectPromise = store.connect({type: 'wallet'});
				await vi.advanceTimersByTimeAsync(200);
				await connectPromise;

				const state = currentState(store);
				expect(state.step).toBe('WalletConnected');
				if (state.step === 'WalletConnected') {
					expect(state.mechanism.name).toBe('Injected Wallet');
				}
				// This mock wallet is already authorized, so the upgrade is completed by
				// eth_accounts without the eth_requestAccounts prompt.
				expect(wallet.getAccountsCalls()).toBe(1);
				expect(otherWallet.getAccountsCalls()).toBe(0);
				expect(otherWallet.requestAccountsCalls()).toBe(0);
			} finally {
				otherWallet.uninstall();
			}
		});

		it('should restore WalletChosen (not Idle) when connect fails after selectWallet', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			expect(currentState(store).step).toBe('WalletChosen');

			// Make the wallet reject the accounts request
			wallet.rejectAuthorization(Object.assign(new Error('User rejected the request.'), {code: 4001}));

			const connectPromise = store.connect({type: 'wallet', name: 'Injected Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise.catch(() => {});

			const state = currentState(store);
			// The choice must NOT be thrown away: we should be back in WalletChosen, not Idle
			expect(state.step).toBe('WalletChosen');
			if (state.step === 'WalletChosen') {
				expect(state.wallet.status).toBe('disconnected');
				expect(state.wallet.provider).toBeDefined();
			}
		}, 2000);
	});

	describe('ensureConnected', () => {
		it('should resolve when already in WalletChosen', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			const result = await store.ensureConnected();
			expect(result.step).toBe('WalletChosen');
		});

		it('should initiate selectWallet when in Idle', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			const ensurePromise = store.ensureConnected();
			await vi.advanceTimersByTimeAsync(200);
			const result = await ensurePromise;

			expect(result.step).toBe('WalletChosen');
		});

		it('should not call eth_requestAccounts', async () => {
			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			const ensurePromise = store.ensureConnected();
			await vi.advanceTimersByTimeAsync(200);
			await ensurePromise;

			expect(wallet.requestAccountsCalls()).toBe(0);
		});
	});

	describe('provider routing', () => {
		it('should route reads through the wallet provider when prioritizeWalletProvider is true', async () => {
			const store = createWalletChosenConnection({prioritizeWalletProvider: true});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			// The always-on provider should route through the wallet
			// eth_blockNumber is a non-signing read, so it should go through the wallet
			const result = await store.provider.request({method: 'eth_blockNumber'});
			expect(result).toBe('0x100');
		});

		it('should refuse signing when not connected', async () => {
			const store = createWalletChosenConnection({prioritizeWalletProvider: true});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			// Signing methods should be rejected with code 4001
			await expect(
				store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]}),
			).rejects.toMatchObject({code: 4001});
		});
	});

	describe('upgrade failure handling', () => {
		it('should keep routing reads through the wallet when the upgrade fails during getChainId', async () => {
			const store = createWalletChosenConnection({prioritizeWalletProvider: true});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);
			expect(currentState(store).step).toBe('WalletChosen');

			// The wallet's eth_chainId starts failing (e.g. the wallet became unreachable).
			// connect() clears the wrapper provider before asking for the chain id, so a
			// failure here used to restore a WalletChosen state that no longer routed reads.
			wallet.setChainIdFailure(true);
			const connectPromise = store.connect({type: 'wallet', name: 'Injected Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise.catch(() => {});

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			expect(state.error?.message).toBe('failed to connect to wallet');
			if (state.step === 'WalletChosen') {
				expect(state.mechanism.name).toBe('Injected Wallet');
				expect(state.wallet.status).toBe('disconnected');
			}

			// Reads must still route through the restored wallet, not fall back silently.
			wallet.setChainIdFailure(false);
			const blockNumber = await store.provider.request({method: 'eth_blockNumber'});
			expect(blockNumber).toBe('0x100');
			expect(wallet.blockNumberCalls()).toBe(1);
		});

		it('should restore the previously chosen wallet when upgrading to a DIFFERENT wallet fails early', async () => {
			const failingWallet = installWallet({
				uuid: 'uuid-wallet-2',
				rdns: 'com.example.other',
				name: 'Other Wallet',
			});
			failingWallet.setChainIdFailure(true);

			const store = createWalletChosenConnection({prioritizeWalletProvider: true});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			// Attempt to upgrade through a different wallet whose eth_chainId fails: the
			// restored state must describe the wallet that is actually live (the chosen
			// one), not the attempted one.
			const connectPromise = store.connect({type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise.catch(() => {});

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			if (state.step === 'WalletChosen') {
				expect(state.mechanism.name).toBe('Injected Wallet');
			}

			const blockNumber = await store.provider.request({method: 'eth_blockNumber'});
			expect(blockNumber).toBe('0x100');
			expect(wallet.blockNumberCalls()).toBe(1);

			failingWallet.uninstall();
		});

		it('should restore the CHOSEN wallet when upgrading to a DIFFERENT wallet fails after its chain id answered', async () => {
			// Other Wallet answers eth_chainId fine but rejects the accounts prompt: the attempt
			// gets far enough to register Other Wallet on the wrapper before failing. The
			// restored WalletChosen must bring back the CHOSEN wallet — a refused accounts
			// prompt on wallet B must not silently move the read path chosen on wallet A.
			const rejectingWallet = installWallet({
				uuid: 'uuid-wallet-2',
				rdns: 'com.example.other',
				name: 'Other Wallet',
			});
			rejectingWallet.rejectAuthorization(Object.assign(new Error('User rejected the request.'), {code: 4001}));

			const store = createWalletChosenConnection({prioritizeWalletProvider: true});
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			const connectPromise = store.connect({type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise.catch(() => {});

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			expect(state.error?.message).toBe('Connection request was declined.');
			if (state.step === 'WalletChosen') {
				expect(state.mechanism.name).toBe('Injected Wallet');
			}

			// Reads route through the CHOSEN wallet, not the one that refused the upgrade.
			const blockNumber = await store.provider.request({method: 'eth_blockNumber'});
			expect(blockNumber).toBe('0x100');
			expect(wallet.blockNumberCalls()).toBe(1);

			rejectingWallet.uninstall();
		});

		it('should restore WalletChosen (not tear down) when the wallet answers an upgrade with no accounts', async () => {
			const emptyWallet = installWallet({
				uuid: 'uuid-wallet-empty',
				rdns: 'com.example.empty',
				name: 'Empty Wallet',
				accounts: [],
			});

			const store = createWalletChosenConnection();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Empty Wallet');
			vi.advanceTimersByTime(100);
			expect(currentState(store).step).toBe('WalletChosen');

			const connectPromise = store.connect({type: 'wallet', name: 'Empty Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise;

			const state = currentState(store);
			expect(state.step).toBe('WalletChosen');
			expect(state.error?.message).toBe('could not get any accounts');
			if (state.step === 'WalletChosen') {
				expect(state.mechanism.name).toBe('Empty Wallet');
			}

			emptyWallet.uninstall();
		});
	});

	describe('teardown when the wallet leaves the state', () => {
		function createEndpoint() {
			let blockNumberCount = 0;
			const provider = {
				request: async ({method}: {method: string; params?: any[]}) => {
					if (method === 'eth_blockNumber') {
						blockNumberCount++;
						return '0x99';
					}
					throw new Error(`unexpected endpoint method ${method}`);
				},
			} as unknown as UnderlyingEthereumProvider;
			return {provider, blockNumberCalls: () => blockNumberCount};
		}

		function createConnectionWithEndpoint() {
			const endpoint = createEndpoint();
			const store = createConnection({
				targetStep: 'WalletChosen',
				chainInfo: {...chainInfo, provider: endpoint.provider},
				autoConnect: false,
				prioritizeWalletProvider: true,
			});
			return {store, endpoint};
		}

		it('cancel() from WalletChosen stops routing reads through the wallet', async () => {
			const {store, endpoint} = createConnectionWithEndpoint();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			await store.provider.request({method: 'eth_blockNumber'});
			expect(wallet.blockNumberCalls()).toBe(1);
			expect(endpoint.blockNumberCalls()).toBe(0);

			store.cancel();
			expect(currentState(store).step).toBe('Idle');

			// The wallet left the state, so reads must not keep routing through it.
			const blockNumber = await store.provider.request({method: 'eth_blockNumber'});
			expect(blockNumber).toBe('0x99');
			expect(wallet.blockNumberCalls()).toBe(1);
			expect(endpoint.blockNumberCalls()).toBe(1);
		});

		it("back('Idle') from WalletChosen stops routing reads through the wallet", async () => {
			const {store, endpoint} = createConnectionWithEndpoint();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);

			store.back('Idle');
			expect(currentState(store).step).toBe('Idle');

			const blockNumber = await store.provider.request({method: 'eth_blockNumber'});
			expect(blockNumber).toBe('0x99');
			expect(wallet.blockNumberCalls()).toBe(0);
			expect(endpoint.blockNumberCalls()).toBe(1);
		});

		// The same rule, on the two paths inside `connect` that drop the wallet from the state
		// without going through a failure or a `back()`. Both were missed: they set `wallet: undefined`
		// and left the wrapper holding the wallet with its status still `connected`, so the wrapper
		// would keep SIGNING through a wallet the state no longer showed. The rule is the one written
		// on `teardownWallet` and in the README: every transition to a state whose `wallet` is
		// `undefined` tears the live wallet down.
		function createConnectionWithHost() {
			const endpoint = createEndpoint();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: {...chainInfo, provider: endpoint.provider},
				autoConnect: false,
				prioritizeWalletProvider: true,
			});
			return {store, endpoint};
		}

		async function connectedWithHost() {
			const {store} = createConnectionWithHost();
			vi.advanceTimersByTime(200);
			const connectPromise = store.connect({type: 'wallet', name: 'Injected Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise;
			expect(currentState(store).step).toBe('WalletConnected');
			// Signing works while connected, so the assertions below are about the transition and not
			// about a wallet that never worked.
			await store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]});
			return store;
		}

		it('connect() with no mechanism, landing on the mechanism picker, refuses signing afterwards', async () => {
			const store = await connectedWithHost();

			// Not wallet-only and no mechanism given, so this re-enters the mechanism picker. (A LOCKED
			// wallet is the other case and is deliberately different: there `connect()` reconnects
			// instead, see `test/locked-wallet-reconnect.test.ts`.)
			await store.connect();
			expect(currentState(store).step).toBe('MechanismToChoose');

			await expect(store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]})).rejects.toThrow(
				'wallet provider is not connected',
			);
		});

		it('launching a sign-in popup refuses signing through the wallet it replaced', async () => {
			// A user connected with a wallet who then picks email sign-in. The popup step carries no
			// wallet, so the wallet must stop being able to sign the moment the popup opens, not
			// whenever the popup happens to finish.
			const store = await connectedWithHost();

			const originalOpen = window.open;
			(window as any).open = vi.fn(() => ({closed: false, close: () => {}}) as unknown as Window);
			try {
				// Deliberately not awaited. `PopupPromise.cancel()` is an empty TODO in `src/popup.ts`, so
				// nothing settles this promise once the popup is open: `connection.cancel()` returns the
				// STORE to Idle and leaves the promise pending for good. That is its own problem, recorded
				// in `work/notes/observations`; this test is about the wallet, and awaiting here would only
				// hang it on an unrelated bug.
				const connecting = store.connect({type: 'email', email: 'user@example.com'});
				connecting.catch(() => {});
				await vi.advanceTimersByTimeAsync(50);
				expect(currentState(store).step).toBe('PopupLaunched');

				await expect(
					store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]}),
				).rejects.toThrow('wallet provider is not connected');

				store.cancel();
				await vi.advanceTimersByTimeAsync(50);
				expect(currentState(store).step).toBe('Idle');
			} finally {
				(window as any).open = originalOpen;
			}
		});

		it('cancel() from WalletConnected refuses signing afterwards', async () => {
			const {store} = createConnectionWithEndpoint();
			vi.advanceTimersByTime(200);

			await store.selectWallet('Injected Wallet');
			vi.advanceTimersByTime(100);
			const connectPromise = store.connect({type: 'wallet', name: 'Injected Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			await connectPromise;
			expect(currentState(store).step).toBe('WalletConnected');

			// Signing works while connected.
			await store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]});

			store.cancel();
			expect(currentState(store).step).toBe('Idle');

			// The Idle state carries no wallet: signing must no longer go through it.
			await expect(store.provider.request({method: 'personal_sign', params: ['0xdeadbeef', ACCOUNT]})).rejects.toThrow(
				'wallet provider is not connected',
			);
		});
	});
});
