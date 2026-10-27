// Type-surface lock: the providers a connection hands out fit eip-1193 0.7 provider slots.
//
// No runtime: `tsc -p tsconfig.types.json` IS the test (`pnpm test:types`).
//
// Apps pass `connection.provider` straight to libraries whose provider slots are typed with
// eip-1193 0.7 (`@etherkit/tx-observer`'s `createTransactionObserver({provider})`, etherfold,
// rocketh), most of them `EIP1193CoreProvider`. `UnderlyingEthereumProvider` is remote-procedure-
// call's `CurriedRPC<Methods>`, which fits them from remote-procedure-call 0.2 (0.1 did not
// distribute union method entries the way eip-1193 0.7 does). If that regresses, the assignments
// below stop compiling.

import type {EIP1193CoreProvider, EIP1193WalletProvider, EIP1193WindowWalletProvider} from 'eip-1193';
import {EthereumWalletConnector} from '@etherplay/wallet-connector-ethereum';
import type {ConnectionStore, UnderlyingEthereumProvider} from '../../src/index.js';

declare const store: ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', false>;

export const asCore: EIP1193CoreProvider = store.provider;
export const asWallet: EIP1193WalletProvider = store.provider;

// And the provider of a chosen wallet, as well as the connection-wide one.
declare const wallet: UnderlyingEthereumProvider;
export const walletAsCore: EIP1193CoreProvider = wallet;
export const walletAsWallet: EIP1193WalletProvider = wallet;

// The always-on provider's endpoint takes any EIP-1193 provider, or any object with an async request.
declare const injected: EIP1193WindowWalletProvider;
declare const loose: {request(args: {method: string; params?: any}): Promise<any>};
export const fromInjected = () =>
	new EthereumWalletConnector().createAlwaysOnProvider({endpoint: injected, chainId: '1'});
export const fromLoose = () => new EthereumWalletConnector().createAlwaysOnProvider({endpoint: loose, chainId: '1'});

// There is no catch-all request overload: a method outside the table is an error.
export const unknownMethod = () =>
	// @ts-expect-error not a method of the table
	store.provider.request({method: 'not_a_method'});
