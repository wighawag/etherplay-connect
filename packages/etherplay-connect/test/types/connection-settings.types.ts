// Type-surface lock for WHAT SELECTS A `createConnection` OVERLOAD.
//
// No runtime: `tsc -p tsconfig.types.json` IS the test (`pnpm test:types`), and a compile error is
// a failing one.
//
// The promise, in one line: `targetStep` and `walletOnly` choose the overload, and NOTHING ELSE
// DOES. In particular `walletConnector` and `wallets` are ordinary optional settings, so a caller
// may build its settings object however it likes.
//
// This is a promise because it used to be false, and the way it was false is invisible from the
// call site. There were two overloads per configuration, one requiring `walletConnector` and one
// requiring it to be ABSENT (`walletConnector?: undefined`), so the setting was a discriminant:
//
//   - an object spread in with the key sometimes present matched NEITHER overload;
//   - a value typed `WalletConnector<P> | undefined` matched neither either;
//   - `walletConnector: undefined` written out silently selected the OTHER overload.
//
// Every one of those is what conditional settings normally look like, and the last one is the
// dangerous shape: it compiles, and it picks the provider type the caller did not mean. Adding
// `wallets` as a second such discriminant would have brought the same trap along with it, which is
// why the split was removed rather than duplicated.

import type {WalletConnector, WalletHandle} from '@etherplay/wallet-connector';
import {
	createConnection,
	type ChainInfo,
	type ConnectionStore,
	type UnderlyingEthereumProvider,
} from '../../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

declare const maybeConnector: WalletConnector<UnderlyingEthereumProvider> | undefined;
declare const definitelyConnector: WalletConnector<UnderlyingEthereumProvider>;
declare const appSuppliesAConnector: boolean;

// ---------------------------------------------------------------------------
// 1. The three shapes that used to be traps.
// ---------------------------------------------------------------------------

// A settings object built conditionally: the key is present in one branch and absent in the other.
const conditionalSettings = {
	targetStep: 'WalletConnected' as const,
	chainInfo,
	autoConnect: false,
	...(appSuppliesAConnector ? {walletConnector: definitelyConnector} : {}),
};
const fromSpread = createConnection(conditionalSettings);
export type _SpreadStillTypesTheStore = Expect<
	Equals<typeof fromSpread, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

// A value that may or may not be a connector, passed as it is.
const fromMaybe = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
	autoConnect: false,
	walletConnector: maybeConnector,
});
export type _MaybeConnectorStillTypesTheStore = Expect<
	Equals<typeof fromMaybe, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

// `undefined` written out, which is what a caller normalising its options ends up with. It means
// "no connector", and must therefore give exactly what omitting the key gives.
//
// This is also why both settings are spelled `?: T | undefined` rather than `?: T` in the overloads.
// The two are the same here, but NOT in a consumer compiling with `exactOptionalPropertyTypes: true`,
// where `?: T` rejects an explicitly-passed `undefined` and this promise would hold only for apps
// that happen to share this repo's compiler settings. That flag cannot be turned on for this package
// yet (`src/index.ts` has unrelated violations), so the spelling is the guarantee and this comment is
// the reason it must not be "simplified" away.
const fromExplicitUndefined = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
	autoConnect: false,
	walletConnector: undefined,
});
const fromOmitted = createConnection({targetStep: 'WalletConnected', chainInfo, autoConnect: false});
export type _ExplicitUndefinedIsTheSameAsOmitting = Expect<Equals<typeof fromExplicitUndefined, typeof fromOmitted>>;
export type _AndItIsTheDefaultProvider = Expect<
	Equals<typeof fromExplicitUndefined, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

// ---------------------------------------------------------------------------
// 2. `wallets` is the same kind of setting, not a new discriminant.
// ---------------------------------------------------------------------------

declare const ethereumHandle: WalletHandle<UnderlyingEthereumProvider>;
declare const appSuppliesWallets: boolean;

const withWallets = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
	autoConnect: false,
	wallets: [ethereumHandle],
});
export type _SuppliedWalletsKeepTheDefaultProvider = Expect<
	Equals<typeof withWallets, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

const withConditionalWallets = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
	autoConnect: false,
	...(appSuppliesWallets ? {wallets: [ethereumHandle]} : {}),
});
export type _ConditionalWalletsStillTypeTheStore = Expect<
	Equals<typeof withConditionalWallets, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

// It is available on every configuration, because "this app brings its own wallet" is orthogonal to
// how far the connection goes.
createConnection({targetStep: 'WalletChosen', chainInfo, wallets: [ethereumHandle]});
createConnection({walletOnly: true, chainInfo, wallets: [ethereumHandle]});
createConnection({walletHost: 'https://wallet.example.com', chainInfo, wallets: [ethereumHandle]});

// ---------------------------------------------------------------------------
// 3. A custom provider type is still inferred, from whichever setting mentions it.
// ---------------------------------------------------------------------------

type CustomProvider = {custom: true};
declare const customConnector: WalletConnector<CustomProvider>;
declare const customChainInfo: ChainInfo<CustomProvider>;
declare const customHandle: WalletHandle<CustomProvider>;

const fromConnector = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: customChainInfo,
	walletConnector: customConnector,
});
export type _InferredFromTheConnector = Expect<
	Equals<typeof fromConnector, ConnectionStore<CustomProvider, 'WalletConnected', true>>
>;

// WHAT THIS ONE PINS IS A KNOWN-UNSOUND INFERENCE, recorded rather than endorsed.
//
// With no connector, the runtime uses the default Ethereum one, so `store.provider` is that
// connector's `CurriedRPC<Methods>` while the type here says `CustomProvider`. Under the removed
// overloads this call did not compile at all; the collapse that made `walletConnector` a normal
// optional setting is what lets it through, and ADR-0005 accepts that as the price (it can only
// reach a caller who was already pairing a foreign provider with the Ethereum connector).
//
// It is asserted so that the gap is VISIBLE and cannot widen unnoticed, not because the result is
// something to rely on. Pair a non-Ethereum `chainInfo.provider` with the connector that speaks for
// it. A future change that makes this an error again is an improvement: update this block, do not
// work around it.
const fromChainInfo = createConnection({targetStep: 'WalletConnected', chainInfo: customChainInfo});
export type _InferredFromTheChainProvider = Expect<
	Equals<typeof fromChainInfo, ConnectionStore<CustomProvider, 'WalletConnected', true>>
>;

const fromSuppliedWallets = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: customChainInfo,
	walletConnector: customConnector,
	wallets: [customHandle],
});
export type _InferredFromBoth = Expect<
	Equals<typeof fromSuppliedWallets, ConnectionStore<CustomProvider, 'WalletConnected', true>>
>;

// ---------------------------------------------------------------------------
// 4. What still DOES select an overload, and must keep doing so.
// ---------------------------------------------------------------------------
// Removing the connector split must not flatten the `walletHost` promise: a SignedIn connection
// that can reach the hosted popups still requires a host. `wallet-only-no-host.types.ts` is the
// file about that promise; these two are here so that a change to the overload SHAPE trips over it
// in the file about the shape.

// @ts-expect-error - walletHost is required when popup mechanisms are reachable
createConnection({targetStep: 'SignedIn', chainInfo, wallets: [ethereumHandle]});

// @ts-expect-error - a supplied wallet does not make a connection wallet-only
createConnection({targetStep: 'SignedIn', walletOnly: false, chainInfo, wallets: [ethereumHandle]});

// A handle whose provider type disagrees with the connector's is not a wallet that connector can
// drive, and the two inference sites are what catches it. Written through a variable so the call
// stays on ONE line: `@ts-expect-error` suppresses the line that follows it, and which line inside a
// wrapped call the error is reported at is not something to depend on.
const mismatchedWallets = {
	targetStep: 'WalletConnected' as const,
	chainInfo: customChainInfo,
	walletConnector: customConnector,
	wallets: [ethereumHandle],
};
// @ts-expect-error - Ethereum handles do not belong to a custom-provider connection
createConnection(mismatchedWallets);
