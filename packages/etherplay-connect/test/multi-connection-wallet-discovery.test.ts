// Regression tests for wallet discovery with more than one connection in a page.
//
// EIP-6963 discovery is page-wide. Each `createConnection` (unless given a `walletConnector`)
// builds its own connector, which attaches an `eip6963:announceProvider` listener and dispatches
// `eip6963:requestProvider`. Two connections constructed close together overlap: the second one's
// request makes every installed wallet announce itself again while the first is still listening,
// and the first used to append the repeat.
//
// The verified symptom, with exactly ONE wallet installed: `connection.wallets.length === 2`, both
// entries the same wallet with the same `info.uuid`, so the flow took the `wallets.length > 1`
// branch and stopped at `WalletToChoose` ("2 wallets available") listing that wallet twice.
//
// These tests use the real default Ethereum connector on purpose: sharing a single connector
// between connections would hide the bug rather than fix it.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {EthereumWalletConnector} from '@etherplay/wallet-connector-ethereum';
import type {WalletConnector, WalletHandle, AlwaysOnProviderWrapper} from '@etherplay/wallet-connector';
import {createConnection, type Connection, type UnderlyingEthereumProvider} from '../src/index.js';

const ACCOUNT = `0x1111111111111111111111111111111111111111` as `0x${string}`;

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

type InstalledWallet = {
	announce: () => void;
	uninstall: () => void;
	requestCount: () => number;
};

/**
 * Install an EIP-6963 wallet in the page: it announces itself on every `eip6963:requestProvider`,
 * exactly as a real wallet extension does.
 */
function installWallet(options?: {uuid?: string; rdns?: string; name?: string}): InstalledWallet {
	const info = {
		uuid: options?.uuid ?? 'uuid-only-wallet',
		name: options?.name ?? 'Only Wallet',
		icon: '',
		rdns: options?.rdns ?? 'com.example.only',
	};

	const provider = {
		request: async ({method}: {method: string; params?: unknown[]}) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return [ACCOUNT];
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: () => {},
		removeListener: () => {},
	};

	let requests = 0;
	const announce = () => {
		window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info, provider}}));
	};
	const onRequest = () => {
		requests++;
		announce();
	};
	window.addEventListener('eip6963:requestProvider', onRequest);

	return {
		announce,
		uninstall: () => window.removeEventListener('eip6963:requestProvider', onRequest),
		requestCount: () => requests,
	};
}

/** A payment-style connection built on the real default Ethereum connector. */
function createPaymentStyleConnection(storagePrefix: string) {
	return createConnection({
		targetStep: 'WalletConnected',
		chainInfo,
		autoConnect: false,
		storagePrefix,
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

let wallet: InstalledWallet | undefined;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.useFakeTimers();
});

afterEach(() => {
	wallet?.uninstall();
	wallet = undefined;
	vi.useRealTimers();
});

describe('wallet discovery with several connections in one page', () => {
	it('each connection sees the single installed wallet exactly once', () => {
		wallet = installWallet();

		const player = createPaymentStyleConnection('player:');
		const payment = createPaymentStyleConnection('payment:');

		// The wallet answered both connections' provider requests, i.e. the overlap really happened.
		expect(wallet.requestCount()).toBe(2);

		expect(currentState(player).wallets).toHaveLength(1);
		expect(currentState(payment).wallets).toHaveLength(1);
		expect(currentState(player).wallets[0].info.uuid).toBe('uuid-only-wallet');
	});

	it('takes the direct-connect path, not WalletToChoose, with one wallet and two connections', async () => {
		wallet = installWallet();

		const player = createPaymentStyleConnection('player:');
		const payment = createPaymentStyleConnection('payment:');

		// `wallets.length > 1` is what used to force the picker. With one wallet the name is
		// resolved implicitly and the flow connects straight through.
		const connecting = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const state = currentState(player);
		expect(state.step).not.toBe('WalletToChoose');
		expect(state.step).toBe('WalletConnected');

		// The second connection is equally able to connect on its own.
		const payingUp = payment.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await payingUp;
		expect(currentState(payment).step).toBe('WalletConnected');
	});

	it('repeated announcements for the same uuid never grow the wallets list', () => {
		wallet = installWallet();

		const connection = createPaymentStyleConnection('solo:');
		expect(currentState(connection).wallets).toHaveLength(1);

		for (let i = 0; i < 5; i++) {
			wallet.announce();
		}
		expect(currentState(connection).wallets).toHaveLength(1);

		// Also when the re-announcement comes from a page-wide request by unrelated code.
		window.dispatchEvent(new Event('eip6963:requestProvider'));
		expect(currentState(connection).wallets).toHaveLength(1);
	});

	it('still lists genuinely distinct wallets separately', () => {
		wallet = installWallet();
		const second = installWallet({uuid: 'uuid-second', rdns: 'com.example.second', name: 'Second Wallet'});
		try {
			const connection = createPaymentStyleConnection('solo:');
			const wallets = currentState(connection).wallets;
			expect(wallets).toHaveLength(2);
			expect(wallets.map((w) => w.info.rdns).sort()).toEqual(['com.example.only', 'com.example.second']);
		} finally {
			second.uninstall();
		}
	});
});

// The list is deduplicated at BOTH layers on purpose, so each one is pinned on its own: the
// end-to-end tests above pass as soon as either layer holds.

describe('the Ethereum connector records each wallet once', () => {
	it('drops the re-announcement caused by another connector requesting providers', () => {
		wallet = installWallet();

		const first = new EthereumWalletConnector();
		const seen: string[] = [];
		first.fetchWallets((handle) => seen.push(handle.info.uuid));

		// A second connector's page-wide request re-announces the same wallet to the first,
		// which is still listening.
		new EthereumWalletConnector().fetchWallets(() => {});

		expect(seen).toEqual(['uuid-only-wallet']);
	});
});

describe('the connection deduplicates whatever the connector announces', () => {
	// Guards the connection-side list builder independently of the Ethereum connector, so a custom
	// or future connector that re-announces cannot resurrect the duplicate-wallet picker.
	function connectorAnnouncing(handles: WalletHandle<unknown>[]): WalletConnector<unknown> {
		const alwaysOnProvider: AlwaysOnProviderWrapper<unknown> = {
			chainId: '1',
			provider: {},
			setWalletProvider: vi.fn(),
			setWalletStatus: vi.fn(),
			onRequest: vi.fn(() => () => {}),
			getPendingRequests: vi.fn(() => []),
		};
		return {
			fetchWallets: (announced) => handles.forEach(announced),
			createAlwaysOnProvider: () => alwaysOnProvider,
			accountGenerator: {
				type: 'ethereum',
				fromMnemonicToAccount: vi.fn(),
				signTextMessage: vi.fn(),
			} as never,
		};
	}

	function handle(info: {uuid: string; rdns: string; name: string}): WalletHandle<unknown> {
		return {info: {...info, icon: ''}, walletProvider: {} as never};
	}

	it('keeps one entry per uuid', () => {
		const info = {uuid: 'uuid-repeat', rdns: 'com.example.repeat', name: 'Repeat Wallet'};
		// Distinct handle objects, as a real re-announcement produces: same wallet, new wrapper.
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			walletConnector: connectorAnnouncing([handle(info), handle(info), handle(info)]),
		});

		expect(currentState(connection as never).wallets).toHaveLength(1);
	});

	it('keeps one entry per rdns when the uuid is regenerated', () => {
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			walletConnector: connectorAnnouncing([
				handle({uuid: 'uuid-1', rdns: 'com.example.rotating', name: 'Rotating Wallet'}),
				handle({uuid: 'uuid-2', rdns: 'com.example.rotating', name: 'Rotating Wallet'}),
			]),
		});

		expect(currentState(connection as never).wallets).toHaveLength(1);
	});
});
