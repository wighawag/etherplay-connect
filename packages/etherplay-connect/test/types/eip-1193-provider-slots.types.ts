// Type-surface lock: the providers a connection hands out fit eip-1193 0.7 provider slots.
//
// No runtime: `tsc -p tsconfig.types.json` IS the test (`pnpm test:types`).
//
// Apps pass `connection.provider` straight to libraries whose provider slots are typed with
// eip-1193 0.7 (`@etherkit/tx-observer`'s `createTransactionObserver({provider})`, etherfold,
// rocketh), most of them `EIP1193CoreProvider`. remote-procedure-call's `CurriedRPC<Methods>` alone
// is NOT assignable to those (it does not distribute union method entries the way eip-1193 0.7
// does), which is why `UnderlyingEthereumProvider` is also an `EIP1193WalletProvider`. If that half
// is dropped, the assignments below stop compiling.

import type {EIP1193CoreProvider, EIP1193WalletProvider} from 'eip-1193';
import type {ConnectionStore, UnderlyingEthereumProvider} from '../../src/index.js';

declare const store: ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', false>;

export const asCore: EIP1193CoreProvider = store.provider;
export const asWallet: EIP1193WalletProvider = store.provider;

// And the provider of a chosen wallet, as well as the connection-wide one.
declare const wallet: UnderlyingEthereumProvider;
export const walletAsCore: EIP1193CoreProvider = wallet;
