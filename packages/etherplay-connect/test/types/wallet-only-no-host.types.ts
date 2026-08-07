// Type-surface lock for the wallet-only, no-`walletHost` configuration.
//
// This file contains no runtime tests. It is checked by `pnpm test:types`
// (`tsc -p tsconfig.types.json`), and it FAILS TO COMPILE if the promise the overloads make is
// broken. The runtime behaviour is pinned by `test/wallet-only-no-host.test.ts`; this pins the part
// downstream apps actually lean on at build time.
//
// The promise, in one line: `walletHost` is optional exactly when no popup can be reached.
//
// It is a promise and not an accident of how the overloads happen to be written. When the
// `targetStep`/`walletOnly` overloads were introduced, `walletHost: string` was deliberately
// CHANGED to `walletHost?: string` on the wallet-only overloads while being LEFT REQUIRED on the
// `walletOnly?: false` ones. A blanket loosening would have made it optional everywhere; the split
// is the whole point, and the negative assertions below are what keep the split real.

import type {WalletConnector} from '@etherplay/wallet-connector';
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

// Compile-time assertion helper: `Expect<Equals<A, B>>` only compiles when A and B are identical.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ---------------------------------------------------------------------------
// 1. The configuration compiles with no `walletHost`.
// ---------------------------------------------------------------------------

const backendFree = createConnection({
	targetStep: 'SignedIn',
	walletOnly: true,
	chainInfo,
});

// ...and it selects the wallet-only SignedIn overload, so `ensureConnected()` is typed as
// resolving to a SignedIn state that definitely has a `wallet` and a session `signer`.
export type _StoreIsWalletOnlySignedIn = Expect<
	Equals<typeof backendFree, ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', true>>
>;

export async function _resolvesToASignedInWalletState() {
	const state = await backendFree.ensureConnected();
	// No optional chaining needed on either: that is what `walletOnly: true` buys.
	const sessionAddress: `0x${string}` = state.account.signer.address;
	const sessionPrivateKey: `0x${string}` = state.account.signer.privateKey;
	const ownerChainId: string = state.wallet.chainId;
	return {sessionAddress, sessionPrivateKey, ownerChainId};
}

// `targetStep` defaults to 'SignedIn', so omitting it entirely is the same configuration.
const backendFreeImplicitTarget = createConnection({walletOnly: true, chainInfo});
export type _DefaultTargetIsSignedIn = Expect<
	Equals<typeof backendFreeImplicitTarget, ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', true>>
>;

// ---------------------------------------------------------------------------
// 2. The negative case: without `walletOnly`, a SignedIn connection still REQUIRES a host.
// ---------------------------------------------------------------------------
// If someone "simplifies" the overloads by making `walletHost` optional everywhere, this stops
// being an error and the `@ts-expect-error` below becomes an unused-directive compile failure.
// That is the intended alarm: the optionality must stay tied to wallet-only.

// @ts-expect-error - walletHost is required when popup mechanisms are reachable
createConnection({targetStep: 'SignedIn', chainInfo});

// @ts-expect-error - walletHost is required when walletOnly is explicitly false
createConnection({targetStep: 'SignedIn', walletOnly: false, chainInfo});

// ---------------------------------------------------------------------------
// 3. `walletHost` remains ALLOWED alongside `walletOnly: true`.
// ---------------------------------------------------------------------------
// Wallet-only is about which mechanisms are offered, not about forbidding a host. An app may keep
// its host configured (for a sibling connection, or while migrating) and still run wallet-only.

const walletOnlyWithHost = createConnection({
	targetStep: 'SignedIn',
	walletOnly: true,
	walletHost: 'https://wallet.example.com',
	chainInfo,
});
export type _HostStillAllowed = Expect<
	Equals<typeof walletOnlyWithHost, ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', true>>
>;

// ---------------------------------------------------------------------------
// 4. Wallet-only narrows `connect` to wallet mechanisms only.
// ---------------------------------------------------------------------------
// The popup mechanisms are not merely unreachable at runtime, they are not offered by the type.

export function _onlyWalletMechanismsAreOffered() {
	backendFree.connect();
	backendFree.connect({type: 'wallet'});
	backendFree.connect({type: 'wallet', name: 'MetaMask'});

	// @ts-expect-error - email is a popup mechanism, not available in wallet-only mode
	backendFree.connect({type: 'email', mode: 'otp', email: 'user@example.com'});

	// @ts-expect-error - oauth is a popup mechanism, not available in wallet-only mode
	backendFree.connect({type: 'oauth', provider: {id: 'google'}, usePopup: true});

	// @ts-expect-error - mnemonic is a popup mechanism, not available in wallet-only mode
	backendFree.connect({type: 'mnemonic', mnemonic: 'twelve words', index: 0});
}

// ---------------------------------------------------------------------------
// 5. `targetStep`, not the presence of a host, is what says "this app has a local signer".
// ---------------------------------------------------------------------------
// A `WalletConnected` connection also takes no host, and its resolved state has NO `signer`.
// So `walletHost` cannot distinguish the two, and `targetStep` can. See the README section
// "Wallet-only sign-in with no backend".

const walletConnectedOnly = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
});

export async function _walletConnectedHasNoSigner() {
	const state = await walletConnectedOnly.ensureConnected();
	const ownerAddress: `0x${string}` = state.account.address;
	// @ts-expect-error - a WalletConnected state has no session signer; only SignedIn does
	state.account.signer;
	return ownerAddress;
}

// Both connections are host-free, and only the `targetStep` tells them apart.
export type _TargetStepIsTheDiscriminator = Expect<Equals<typeof backendFree.targetStep, 'SignedIn'>>;

// ---------------------------------------------------------------------------
// 6. A WalletConnected store reports `walletOnly: true`, matching the runtime.
// ---------------------------------------------------------------------------
// The runtime computes `walletOnly = settings.walletOnly || targetStep === 'WalletConnected'`, so a
// WalletConnected connection IS wallet-only. The custom-connector overload used to leave the
// parameter at its `false` default while the default-connector overload said `true`: the two
// disagreed with each other, and the first disagreed with the runtime.

export type _WalletConnectedDefaultConnectorIsWalletOnly = Expect<
	Equals<typeof walletConnectedOnly, ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>>
>;

export type _WalletConnectedStoreReportsWalletOnlyTrue = Expect<Equals<typeof walletConnectedOnly.walletOnly, true>>;

type CustomProvider = {custom: true};
declare const customConnector: WalletConnector<CustomProvider>;
declare const customChainInfo: ChainInfo<CustomProvider>;

const walletConnectedCustomConnector = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: customChainInfo,
	walletConnector: customConnector,
});

export type _WalletConnectedCustomConnectorIsWalletOnly = Expect<
	Equals<typeof walletConnectedCustomConnector, ConnectionStore<CustomProvider, 'WalletConnected', true>>
>;

// The two WalletConnected overloads agree with each other on everything but the provider type.
export type _BothWalletConnectedOverloadsAgree = Expect<
	Equals<typeof walletConnectedCustomConnector.walletOnly, typeof walletConnectedOnly.walletOnly>
>;
