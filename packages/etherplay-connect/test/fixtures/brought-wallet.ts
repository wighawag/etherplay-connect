// A wallet the APP constructs and hands to the connection, rather than one the page happens to
// have: a chain running in the tab with a key it generated, a burner signer, a custodian answering
// over RPC.
//
// Two properties are what the tests here are about, and they are independent:
//
// 1. It is never announced to the page. It has no EIP-6963 listener and dispatches nothing, so the
//    only way this wallet can reach a connection is a caller passing it in `wallets`. A fixture
//    that also announced itself would pass the "the app can bring a wallet" tests without proving
//    the caller's list is what delivered it.
// 2. It can declare `info.autoApproves`, and by DEFAULT it does not. The default matters: the same
//    fixture is used as the control for every suppression test, so "loud" and "silent" differ in
//    exactly one field and nothing else.
//
// `eth_accounts` answers with the account straight away, which is the honest model of a wallet
// holding its own key: there is no locked state to unlock and no permission to grant, so the
// connect flow never reaches `eth_requestAccounts`. `requestAccountsCalls` is exposed so a test can
// assert that.

import {EthereumWalletProvider, type UnderlyingEthereumProvider} from '@etherplay/wallet-connector-ethereum';
import type {WalletHandle} from '@etherplay/wallet-connector';

type Handler = (payload: any) => void;

export type BroughtWallet = {
	handle: WalletHandle<UnderlyingEthereumProvider>;
	account: `0x${string}`;
	/** Calls the wallet answered, by method, so a test can say what was and was not asked. */
	calls: (method: string) => number;
	requestAccountsCalls: () => number;
	/**
	 * Run while the wallet is inside a `personal_sign`, which is the only moment worth looking at:
	 * before it the request has not started, after it the request is over, and an assertion at
	 * either end passes whether or not the announcement it is about was ever made.
	 *
	 * Returning a promise HOLDS the wallet inside the request, which is how a test keeps something
	 * outstanding while the connection does something else on top of it.
	 */
	set whileSigning(hook: (() => void | Promise<void>) | undefined);
	/** The account the wallet moves to, announced as a real wallet announces it. */
	switchAccount: (account: `0x${string}`) => void;
};

export function createBroughtWallet(options?: {
	name?: string;
	uuid?: string;
	rdns?: string;
	autoApproves?: boolean;
	account?: `0x${string}`;
	chainId?: string;
}): BroughtWallet {
	const account = options?.account ?? ('0x2222222222222222222222222222222222222222' as `0x${string}`);
	const chainId = options?.chainId ?? '0x1';
	const info = {
		uuid: options?.uuid ?? 'uuid-brought-wallet',
		name: options?.name ?? 'World Wallet',
		icon: '',
		rdns: options?.rdns ?? 'com.example.world',
		// Spread rather than assigned, so the DEFAULT handle has no such key at all. A wallet that
		// says nothing about prompting is the case every existing caller is, and a fixture that
		// wrote `autoApproves: undefined` would not be one.
		...(options?.autoApproves === undefined ? {} : {autoApproves: options.autoApproves}),
	};

	let accounts: `0x${string}`[] = [account];
	let whileSigning: (() => void | Promise<void>) | undefined;
	const callCounts = new Map<string, number>();
	const listeners = new Map<string, Set<Handler>>();

	const provider = {
		request: async ({method}: {method: string; params?: any[]}) => {
			callCounts.set(method, (callCounts.get(method) ?? 0) + 1);
			switch (method) {
				case 'eth_chainId':
					return chainId;
				case 'eth_accounts':
				case 'eth_requestAccounts':
					return accounts;
				case 'personal_sign': {
					const held = whileSigning?.();
					if (held) {
						await held;
					}
					return `0x${'cd'.repeat(65)}`;
				}
				case 'eth_sendTransaction': {
					const held = whileSigning?.();
					if (held) {
						await held;
					}
					return '0xhash';
				}
				case 'eth_blockNumber':
					return '0x100';
				case 'eth_call':
					return '0x';
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: (event: string, handler: Handler) => {
			const set = listeners.get(event) ?? new Set<Handler>();
			set.add(handler);
			listeners.set(event, set);
		},
		removeListener: (event: string, handler: Handler) => {
			listeners.get(event)?.delete(handler);
		},
	};

	return {
		handle: {info, walletProvider: new EthereumWalletProvider(provider as never)},
		account,
		calls: (method: string) => callCounts.get(method) ?? 0,
		requestAccountsCalls: () => callCounts.get('eth_requestAccounts') ?? 0,
		switchAccount: (next: `0x${string}`) => {
			accounts = [next];
			for (const handler of listeners.get('accountsChanged') ?? []) {
				handler(accounts);
			}
		},
		set whileSigning(hook: (() => void | Promise<void>) | undefined) {
			whileSigning = hook;
		},
	};
}
