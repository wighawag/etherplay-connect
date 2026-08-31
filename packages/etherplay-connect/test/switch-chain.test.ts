// `switchWalletChain`, which had NO test at all: 46 uncovered spots, the largest hole in
// `index.ts` and a public method that asks the user's wallet for something.
//
// That combination is why it is first. Per
// `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`, `switchChain` and
// `addChain` are allowed to bypass the always-on wrapper for exactly one reason: they publish a
// dedicated state the consumer renders, `wallet.switchingChain`. "If any of those states is
// removed, that call moves onto the wrapper." Nothing checked that the state was published at all,
// so the exemption rested on an untested promise. The assertions here are therefore about what the
// store says DURING the call, not only about what it returns.
//
// The method's contract is unusual and worth stating once: `wallet_switchEthereumChain` and
// `wallet_addEthereumChain` report success as `null`. A non-null RESULT is an error, so every path
// has to check the result as well as catch, and both shapes are covered below.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

/** A chain the wallet does not know yet, with enough detail to be ADDED. */
const OTHER_CHAIN = {
	id: 42161,
	name: 'Arbitrum One',
	rpcUrls: {default: {http: ['https://arb1.example.com']}},
	blockExplorers: {default: {url: 'https://arbiscan.example.com'}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

/** The same chain with no rpcUrls: nothing to add it WITH. */
const UNADDABLE_CHAIN = {id: 42161, name: 'Arbitrum One'} as const;

const PAGE_ORIGIN = 'http://localhost:3000';
const REJECTED = () => Object.assign(new Error('User rejected the request'), {code: 4001});
const UNKNOWN_CHAIN = () => Object.assign(new Error('Unrecognized chain ID'), {code: 4902});

describe('switchWalletChain', () => {
	let wallet: LockableWallet | undefined;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		wallet?.uninstall();
		wallet = undefined;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	async function connected() {
		wallet = installLockableWallet({uuid: 'uuid-chain', name: 'Chain Wallet', rdns: 'com.example.chain'});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		const connecting = connection.connect({type: 'wallet', name: 'Chain Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		expect(snapshot().step).toBe('WalletConnected');
		return {connection, snapshot, wallet: wallet!};
	}

	it('publishes switchingChain while the wallet is being asked, and clears it after', async () => {
		// THE ASSERTION THE ADR'S EXEMPTION RESTS ON. This request reaches the user and is not
		// announced on `pendingRequests`; `switchingChain` is the only signal a consumer has that
		// the wallet is being asked, so it has to be observable for the whole duration.
		const {connection, snapshot, wallet} = await connected();

		let during: string | false | undefined;
		wallet.setChainHandlers({
			switchChain: () => {
				during = snapshot().wallet?.switchingChain;
				return null;
			},
		});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(during).toBe('switchingChain');
		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(wallet.switchChainCalls()).toEqual([{chainId: '0xa4b1'}]);
		expect(snapshot().error).toBeUndefined();
	});

	it('defaults to the chain the connection was created for', async () => {
		const {connection, wallet} = await connected();

		const switching = connection.switchWalletChain();
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(wallet.switchChainCalls()).toEqual([{chainId: '0x1'}]);
	});

	it('adds the chain when the wallet does not know it, and says so while it does', async () => {
		// The 4902 path: a wallet that has never seen this chain cannot switch to it, so the flow
		// falls through to `wallet_addEthereumChain` with the details from `chainInfo`. That is a
		// SECOND prompt, and it gets its own `switchingChain` value so a consumer can word it
		// differently ("add this network" is not "switch network").
		const {connection, snapshot, wallet} = await connected();

		let duringAdd: string | false | undefined;
		wallet.setChainHandlers({
			switchChain: () => {
				throw UNKNOWN_CHAIN();
			},
			addChain: () => {
				duringAdd = snapshot().wallet?.switchingChain;
				return null;
			},
		});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(duringAdd).toBe('addingChain');
		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error).toBeUndefined();
		// The details the wallet needs to describe the chain to the user, from `chainInfo`.
		expect(wallet.addChainCalls()).toEqual([
			{
				chainId: '0xa4b1',
				chainName: 'Arbitrum One',
				rpcUrls: ['https://arb1.example.com'],
				blockExplorerUrls: ['https://arbiscan.example.com'],
				iconUrls: undefined,
				nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
			},
		]);
	});

	it('treats a refused switch as a cancellation: no error, nothing left in progress', async () => {
		// 4001 is the user saying no, which is not a failure to report. What matters is that
		// `switchingChain` is cleared, or the consumer's spinner never stops.
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({
			switchChain: () => {
				throw REJECTED();
			},
		});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error).toBeUndefined();
		expect(wallet.addChainCalls()).toEqual([]);
	});

	it('treats a refused ADD as a cancellation too', async () => {
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({
			switchChain: () => {
				throw UNKNOWN_CHAIN();
			},
			addChain: () => {
				throw REJECTED();
			},
		});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error).toBeUndefined();
	});

	it('reports a failed add on the state and rejects', async () => {
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({
			switchChain: () => {
				throw UNKNOWN_CHAIN();
			},
			addChain: () => {
				throw new Error('wallet exploded');
			},
		});

		const rejected = expect(connection.switchWalletChain(OTHER_CHAIN)).rejects.toThrow('wallet exploded');
		await vi.advanceTimersByTimeAsync(200);
		await rejected;

		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error?.message).toContain('Failed to add new chain');
		expect(snapshot().error?.message).toContain('Arbitrum One');
	});

	it('treats a non-null result from the ADD as a failure too', async () => {
		// Same unusual contract, second method. This is the end of the line: there is no third thing
		// to try, so it reports and rejects.
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({
			switchChain: () => {
				throw UNKNOWN_CHAIN();
			},
			addChain: () => ({code: -32000, message: 'nope'}),
		});

		const rejected = expect(connection.switchWalletChain(OTHER_CHAIN)).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(200);
		await rejected;

		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error?.message).toContain('Failed to add new chain');
	});

	it('says the chain is unavailable when there is no rpcUrl to add it with', async () => {
		// Without rpcUrls there is nothing to hand `wallet_addEthereumChain`, so the flow stops and
		// names the chain rather than reporting a bare failure. This is also the path a consumer
		// hits by passing a chain it only half describes.
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({
			switchChain: () => {
				throw UNKNOWN_CHAIN();
			},
		});

		const rejected = expect(connection.switchWalletChain(UNADDABLE_CHAIN)).rejects.toThrow('is not available');
		await vi.advanceTimersByTimeAsync(200);
		await rejected;

		expect(snapshot().wallet.switchingChain).toBe(false);
		expect(snapshot().error?.message).toContain('Arbitrum One');
		// What the wallet actually said is kept as the cause. This branch is reached both from a
		// refusal and from a wallet reporting its error as a result, and "not available on your
		// wallet" is our summary of it rather than anything the wallet said.
		expect(snapshot().error?.cause).toMatchObject({code: 4902});
		expect(wallet.addChainCalls()).toEqual([]);
	});

	it('treats a non-null RESULT as a failure, and recovers by adding the chain', async () => {
		// The unusual half of the EIP-1193 contract: these methods report success as `null`, so a
		// wallet answering with anything else is reporting an error without throwing. Taking it as a
		// value would leave the app believing a switch happened that did not.
		//
		// The recovery is the same as for a thrown error, because `throw result` lands in this
		// function's own catch: it tries `wallet_addEthereumChain`, and here that works, so the user
		// does end up on the requested chain.
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({switchChain: () => ({code: -32000, message: 'nope'})});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(wallet.switchChainCalls()).toHaveLength(1);
		expect(wallet.addChainCalls()).toHaveLength(1);
		expect(snapshot().wallet.chainId).toBe('42161');
		expect(snapshot().wallet.switchingChain).toBe(false);
	});

	// WAS a known bug, recorded as `it.fails` and now fixed, so this is an ordinary test.
	//
	// The switch above succeeds through the add fallback, and the state used to keep
	// `error: 'Failed to switch to Arbitrum One'` anyway: the error was set before `throw result`,
	// and the recovery path spreads `...$connection` on its way out, carrying it along. A consumer
	// renders `error` as a banner, so the user landed on the right chain and was told it failed.
	//
	// Now only the branch that GIVES UP sets an error, and nothing sets one on the way past.
	it('sets no error when the recovery succeeded', async () => {
		const {connection, snapshot, wallet} = await connected();
		wallet.setChainHandlers({switchChain: () => ({code: -32000, message: 'nope'})});

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().wallet.chainId).toBe('42161');
		expect(snapshot().error).toBeUndefined();
	});

	it('refuses when there is no wallet to ask', async () => {
		wallet = installLockableWallet({uuid: 'uuid-chain', name: 'Chain Wallet', rdns: 'com.example.chain'});
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected', autoConnect: false});
		await vi.advanceTimersByTimeAsync(200);

		await expect(connection.switchWalletChain(OTHER_CHAIN)).rejects.toThrow();
	});

	it('follows the wallet onto the new chain, and back off it', async () => {
		// The switch itself does not update `chainId`: the wallet's `chainChanged` announcement
		// does, which is also what happens when the user switches chain in the wallet directly.
		// `invalidChainId` is what a consumer renders "wrong network" from.
		const {connection, snapshot, wallet} = await connected();
		expect(snapshot().wallet.invalidChainId).toBe(false);

		const switching = connection.switchWalletChain(OTHER_CHAIN);
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().wallet.chainId).toBe('42161');
		expect(snapshot().wallet.invalidChainId).toBe(true);

		wallet.setChainId('0x1');
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().wallet.chainId).toBe('1');
		expect(snapshot().wallet.invalidChainId).toBe(false);
	});
});
