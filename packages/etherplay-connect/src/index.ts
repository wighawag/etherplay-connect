import type {
	WalletConnector,
	WalletHandle,
	WalletProvider,
	PendingRequest,
	RequestEvent,
	RequestEventHandler,
	RequestPurpose,
} from '@etherplay/wallet-connector';
import {EthereumWalletConnector, type UnderlyingEthereumProvider} from '@etherplay/wallet-connector-ethereum';
import {writable} from 'sveltore';
import {createPopupLauncher, type PopupPromise} from './popup.js';
import {withTimeout} from './utils.js';
import {
	fromEntropyKeyToMnemonic,
	type OriginAccount,
	originPublicKeyPublicationMessage,
	originKeyMessage,
	delegationMessage,
	delegationDigest,
	DELEGATION_ABI,
	findSavedDelegation,
	parsePermissionRequests,
	type PermissionRequest,
	type PermissionOutcome,
	type SavedDelegation,
	fromSignatureToKey,
	AuthMechanism,
	generateEcdhKeyPair,
	exportPublicKeyB64,
} from '@etherplay/connect-core';

export {
	fromEntropyKeyToMnemonic,
	originPublicKeyPublicationMessage,
	originKeyMessage,
	// The delegation feature, re-exported so an app has one import: the message an owner signs, its
	// digest, the ABI of the contract that verifies it, and the lookup that picks the credential for
	// a (chainId, contract) pair out of `savedDelegations`.
	delegationMessage,
	delegationDigest,
	DELEGATION_ABI,
	findSavedDelegation,
};

export type {OriginAccount, AuthMechanism, PermissionRequest, PermissionOutcome, SavedDelegation};

// What `wallet.pendingRequests` and `onRequest` are made of. Re-exported so a consumer rendering
// "your wallet is asking for something" can name WHICH thing without a second dependency.
export type {PendingRequest, RequestEvent, RequestEventHandler, RequestPurpose};

export type {UnderlyingEthereumProvider};

export type BasicChainInfo = {
	id: number;
	readonly rpcUrls?: {
		readonly default: {
			http: readonly string[];
		};
	};
	readonly blockExplorers?: {
		readonly default: {
			url: string;
		};
	};
	name?: string;
	readonly nativeCurrency?: {
		decimals: number;
		name: string;
		symbol: string;
	};
	iconUrls?: readonly string[];

	chainType?: string;
};

type ChainInfoWithRPCUrl = BasicChainInfo & {
	readonly rpcUrls: {
		readonly default: {
			http: readonly string[];
		};
	};
};

type ChainInfoWithProvider<WalletProviderType> = BasicChainInfo & {
	provider: WalletProviderType;
};

export type ChainInfo<WalletProviderType> = ChainInfoWithRPCUrl | ChainInfoWithProvider<WalletProviderType>;

/**
 * Authority to act for the account onchain at ONE contract on ONE chain.
 *
 * The pair is the whole extent of it: the contract's address is inside the bytes the owner signs,
 * so the credential you get back is worth nothing at any other contract. Ask for the pair your app
 * actually writes to, which is the one place it already names.
 */
export type DelegationPermissionDeclaration = {
	type: 'delegation';
	/**
	 * Denying a required permission FAILS sign-in; denying an optional one lets the user in without
	 * that credential. Optional is usually right: it keeps the app browsable read-only and turns a
	 * refusal into a remedy the app can offer later, rather than a wall at the door for something
	 * the user cannot evaluate yet. Defaults to optional.
	 */
	required?: boolean;
	chainId: number;
	contract: `0x${string}`;
};

/**
 * An escape hatch for a permission type this version of the SDK does not know about.
 *
 * A host too old to understand it will DENY it and say so, rather than dropping it, so an app can
 * ask for something new and find out it did not get it.
 */
export type OtherPermissionDeclaration = {
	type: string;
	required?: boolean;
	[key: string]: unknown;
};

/**
 * What the app declares it wants at connect time.
 *
 * Consent at connect time is the weakest moment there is, and it is accepted here for one reason:
 * a clicked-through consent to a BOUNDED grant is a large improvement over no consent at all to an
 * unbounded one. The bound does the work, and it lands in the contract, where it cannot be clicked
 * through.
 */
export type PermissionDeclaration = DelegationPermissionDeclaration | OtherPermissionDeclaration;

export type PopupSettings = {
	walletHost: string;
	mechanism: AuthMechanism;
	// Same-Origin Callback Bridge (domain-redirect fallback)
	decryptKeyPair?: CryptoKeyPair;
	domainRedirectPublicKeyB64?: string;
	// extraParams?: Record<string, string>;
};

export type WalletMechanism<WalletName extends string | undefined, Address extends `0x${string}` | undefined> = {
	type: 'wallet';
} & (WalletName extends undefined ? {name?: undefined} : {name: WalletName}) &
	(Address extends undefined ? {address?: undefined} : {address: Address});

export type Mechanism = AuthMechanism | WalletMechanism<string | undefined, `0x${string}` | undefined>;

export type FullfilledMechanism = AuthMechanism | WalletMechanism<string, `0x${string}`>;

export type TargetStep = 'WalletChosen' | 'WalletConnected' | 'SignedIn';

type WalletStateCommon<WalletProviderType> = {
	provider: WalletProvider<WalletProviderType>;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`;
	chainId: string;
	invalidChainId: boolean;
	switchingChain: 'addingChain' | 'switchingChain' | false;
	/**
	 * @deprecated read `connection.pendingRequests` instead. This mirror is kept in step with it
	 * (both are stamped from the wrapper at the same moment, so they cannot disagree) and it will be
	 * removed in a later major version.
	 *
	 * It describes what the WRAPPER is holding, not what this wallet state is, and the wrapper
	 * outlives any particular wallet state. That is why every rebuild had to be taught to copy it,
	 * and why the paths that build no wallet at all — a failed reconnect resting on
	 * `wallet: undefined` — could still lose it while the user's wallet was genuinely holding a
	 * prompt. A field whose value must be copied at every construction of its container is a field
	 * in the wrong container.
	 */
	pendingRequests: PendingRequest[];
};

type WalletStatus =
	| {status: 'connected'}
	| {status: 'locked'; unlocking: boolean}
	| {status: 'disconnected'; connecting: boolean};

export type WalletState<WalletProviderType> = WalletStateCommon<WalletProviderType> & WalletStatus;

// The same wallet state MINUS the deprecated list, which `set` stamps. Nothing inside this file
// supplies `pendingRequests` when it builds a wallet: that is the whole point of having one
// construction site, and this type is what stops a hand-written eleventh rebuild from supplying a
// wrong one instead.
type WalletStateInput<WalletProviderType> = Omit<WalletStateCommon<WalletProviderType>, 'pendingRequests'> &
	WalletStatus;

// The step types below take the wallet state as a parameter so that the same union can describe
// both what the store PUBLISHES (`WalletState`, list included) and what `set` ACCEPTS
// (`WalletStateInput`, list stamped for you). The default keeps every existing use unchanged.
type WaitingForSignature<WalletProviderType, WS = WalletState<WalletProviderType>> = {
	step: 'WaitingForSignature';
	mechanism: WalletMechanism<string, `0x${string}`>;
	wallet: WS;
	account: {address: `0x${string}`};
};

type WalletChosen<WalletProviderType, WS = WalletState<WalletProviderType>> = {
	step: 'WalletChosen';
	mechanism: WalletMechanism<string, undefined>;
	wallet: WS;
};

type WalletConnected<WalletProviderType, WS = WalletState<WalletProviderType>> = {
	step: 'WalletConnected';
	mechanism: WalletMechanism<string, `0x${string}`>;
	wallet: WS;
	account: {address: `0x${string}`};
};

type SignedIn<WalletProviderType, WS = WalletState<WalletProviderType>> =
	| {
			step: 'SignedIn';
			mechanism: AuthMechanism;
			account: OriginAccount;
			wallet: undefined;
	  }
	| {
			step: 'SignedIn';
			mechanism: WalletMechanism<string, `0x${string}`>;
			account: OriginAccount;
			wallet: WS;
	  };

// What the connection is, independently of which step it is at.
//
// Named rather than written inline below so that `set` can be given the same thing MINUS
// `pendingRequests`, which it stamps itself from the wrapper: see `ConnectionInput`.
type ConnectionCommon<WalletProviderType> = {
	// The connection can have an error in every state.
	// a banner or other mechanism to show error should be used.
	// error should be dismissable
	error?: {message: string; cause?: any};
	// wallets represent the web3 wallet installed on the user browser
	wallets: WalletHandle<WalletProviderType>[];
	/**
	 * Requests the user's wallet is holding right now, whatever the connection is doing.
	 *
	 * It lives HERE, beside `wallet` rather than inside it, because it describes what the always-on
	 * wrapper is holding and the wrapper outlives any particular wallet state. A request is
	 * outstanding for as long as the user has not answered it, and the connection is free to rebuild
	 * its wallet state, or to have no wallet state at all, in the meantime: a locked wallet raises
	 * the connection flow while it is still holding the transaction that raised it, and a reconnect
	 * that then FAILS comes to rest with no wallet at all. The prompt is still on the user's screen
	 * throughout, so the app must still be able to say so.
	 *
	 * This is the list to read. `wallet.pendingRequests` is the same list and is deprecated.
	 *
	 * See `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: a request the user
	 * must answer and the app cannot see is a request nothing can explain, cancel or recover from.
	 */
	pendingRequests: PendingRequest[];
};

type ConnectionSteps<WalletProviderType, WS = WalletState<WalletProviderType>> =  // loading can be true initially as the system will try to auto-login and fetch installed web3 wallet // Start in Idle
	| {
			step: 'Idle';
			loading: boolean;
			wallet: undefined;
	  }
	// It can then end up in MechanismToChoose if no specific connection mechanism was chosen upon clicking "connect"
	| {
			step: 'MechanismToChoose';
			wallet: undefined;
	  }
	// if a social/email login mechanism was chosen, a popup will be launched
	// popupClosed can be true and this means the popup has been closed and the user has to cancel the process to continue further
	| {
			step: 'PopupLaunched';
			wallet: undefined;
			popupClosed: boolean;
			mechanism: AuthMechanism;
	  }
	// If the user has chosen to use web3-wallet there might be multi-choice for it
	| {
			step: 'WalletToChoose';
			wallet: undefined;
			mechanism: WalletMechanism<undefined, undefined>;
	  }
	// Once a user has chosen a wallet, the system will try to connect to it
	| {
			step: 'WaitingForWalletConnection';
			wallet: undefined;
			mechanism: WalletMechanism<string, undefined>;
	  }
	// Once a user has chosen a wallet via EIP-6963 but has NOT gone through the
	// connect/accounts flow. The wallet provider is set on the always-on wrapper so
	// reads route through it (when `prioritizeWalletProvider` is true), but no
	// accounts have been requested and signing is refused (status: 'disconnected').
	// This is the resting step for `targetStep: 'WalletChosen'`.
	| WalletChosen<WalletProviderType, WS>
	// Once the wallet is connected, if multiple account are connected to the site
	// the user can choose which one to connect to
	| {
			step: 'ChooseWalletAccount';
			mechanism: WalletMechanism<string, undefined>;
			wallet: WS;
	  }
	// Once the wallet is connected, the system will need a signature
	// this state represent the fact and require another user interaction to request the signature
	| WalletConnected<WalletProviderType, WS>
	// This state is triggered once the signature is requested, the user will have to confirm with its wallet
	| WaitingForSignature<WalletProviderType, WS>
	// Finally the user is fully signed in
	// wallet?.accountChanged if set, represent the fact that the user has changed its web3-wallet accounnt.
	// wallet?.invalidChainId if set, represent the fact that the wallet is connected to a different chain.
	// wallet?.switchingChain if set, represent the fact that the user is currently switching chain.
	// a notification could be shown to the user so that he can switch the app to use that other account.
	| SignedIn<WalletProviderType, WS>;

export type Connection<WalletProviderType> = ConnectionCommon<WalletProviderType> & ConnectionSteps<WalletProviderType>;

// What the store's internal `set` accepts: a connection WITHOUT `pendingRequests`, at either level,
// because `set` is the one place that fills them in from the wrapper on every publish. Every state
// the store publishes therefore reports the requests the user's wallet is actually holding,
// including the states that carry no wallet at all.
//
// Expressed as a TYPE rather than as a convention on purpose. The rule used to be "remember to copy
// the list at every construction", which held at nine sites and was never going to hold at the
// tenth. Here a construction site cannot supply the field at all, so there is nothing to remember
// and nothing to get wrong.
type ConnectionInput<WalletProviderType> = Omit<ConnectionCommon<WalletProviderType>, 'pendingRequests'> &
	ConnectionSteps<WalletProviderType, WalletStateInput<WalletProviderType>>;

// Type for SignedIn state that was reached via wallet authentication (not popup-based auth)
// This variant always has wallet and WalletMechanism
export type SignedInWithWallet<WalletProviderType> = Extract<
	Connection<WalletProviderType>,
	{step: 'SignedIn'; wallet: WalletState<WalletProviderType>}
>;

// Full WalletConnected type from Connection
export type WalletConnectedState<WalletProviderType> = Extract<
	Connection<WalletProviderType>,
	{step: 'WalletConnected'}
>;

// Full WalletChosen type from Connection
export type WalletChosenState<WalletProviderType> = Extract<Connection<WalletProviderType>, {step: 'WalletChosen'}>;

// Type representing wallet-connected states (both WalletConnected and SignedIn-via-wallet)
// This is what you get when targetStep is 'WalletConnected' and target is reached
// Both variants have WalletMechanism and wallet
export type ConnectedWithWallet<WalletProviderType> =
	| WalletConnectedState<WalletProviderType>
	| SignedInWithWallet<WalletProviderType>;

// Type representing the chosen-or-better states. This is what you get when targetStep is
// 'WalletChosen' and the target is reached: the wallet may be merely chosen, fully connected,
// or signed-in via wallet — all satisfy the lower target.
export type ChosenOrBetter<WalletProviderType> =
	| WalletChosenState<WalletProviderType>
	| WalletConnectedState<WalletProviderType>
	| SignedInWithWallet<WalletProviderType>;

// Full SignedIn type from Connection (includes both popup-based and wallet-based variants)
export type SignedInState<WalletProviderType> = Extract<Connection<WalletProviderType>, {step: 'SignedIn'}>;

// Type guard - narrows Connection based on targetStep and walletOnly
// For 'WalletChosen' target: narrows to ChosenOrBetter (WalletChosen | WalletConnected | SignedIn-with-wallet)
// For 'WalletConnected' target: narrows to ConnectedWithWallet (WalletConnected | SignedIn-with-wallet)
// For 'SignedIn' target with walletOnly: narrows to SignedInWithWallet
// For 'SignedIn' target (default): narrows to SignedIn
export function isTargetStepReached<WalletProviderType, Target extends TargetStep, WalletOnly extends boolean = false>(
	connection: Connection<WalletProviderType>,
	targetStep: Target,
	walletOnly?: WalletOnly,
): connection is Target extends 'WalletChosen'
	? ChosenOrBetter<WalletProviderType>
	: Target extends 'WalletConnected'
		? ConnectedWithWallet<WalletProviderType>
		: WalletOnly extends true
			? SignedInWithWallet<WalletProviderType>
			: SignedInState<WalletProviderType> {
	if (targetStep === 'WalletChosen') {
		// For WalletChosen target, accept WalletChosen OR any higher step (WalletConnected, SignedIn-with-wallet)
		return (
			connection.step === 'WalletChosen' ||
			connection.step === 'WalletConnected' ||
			(connection.step === 'SignedIn' && connection.wallet !== undefined)
		);
	}
	if (targetStep === 'WalletConnected') {
		// For WalletConnected target, accept WalletConnected OR SignedIn-with-wallet
		return connection.step === 'WalletConnected' || (connection.step === 'SignedIn' && connection.wallet !== undefined);
	}
	// For SignedIn target (regardless of walletOnly), only accept SignedIn
	// walletOnly affects the return type narrowing, not the step check
	if (walletOnly) {
		// For SignedIn + walletOnly, only accept SignedIn-with-wallet
		return connection.step === 'SignedIn' && connection.wallet !== undefined;
	}
	// For SignedIn target, accept any SignedIn variant
	return connection.step === 'SignedIn';
}

function viemChainInfoToSwitchChainInfo(chainInfo: BasicChainInfo): {
	chainId: `0x${string}`;
	readonly rpcUrls?: readonly string[];
	readonly blockExplorerUrls?: readonly string[];
	readonly chainName?: string;
	readonly iconUrls?: readonly string[];
	readonly nativeCurrency?: {
		name: string;
		symbol: string;
		decimals: number;
	};
} {
	return {
		chainId: `0x${Number(chainInfo.id).toString(16)}`,
		chainName: chainInfo.name,
		nativeCurrency: chainInfo.nativeCurrency,
		rpcUrls: chainInfo.rpcUrls ? [...chainInfo.rpcUrls.default.http] : [],
		blockExplorerUrls: chainInfo.blockExplorers?.default?.url ? [chainInfo.blockExplorers.default.url] : undefined,
	};
}

// Base (unprefixed) storage key names. A connection namespaces its own storage by prepending its
// `storagePrefix` setting to these, so several connections in one page never share a slot.
// With no prefix the effective keys are byte-identical to what single-connection apps already have.
const baseStorageKeyAccount = '__origin_account';
const baseStorageKeyLastWallet = '__last_wallet';

// `signer.mnemonicKey` used to hold `originKey`, which is not one derived key but the ENTROPY the
// whole origin account derives from: the session signer is index 0 of the mnemonic built from it,
// and every other key that origin could ever derive is index 1, 2, 3 onward. It is no longer
// produced here, but it can still ARRIVE from two directions: storage written by an older version,
// and the wallet host popup, which is deployed independently of the version an app ships and can
// therefore be running an older `deriveOriginAccount`. So the account is stripped on every path it
// can take into this library, and the persisting side treats it as an invariant rather than
// trusting its callers.
type OriginAccountWithLegacyEntropyKey = OriginAccount & {signer: {mnemonicKey?: `0x${string}`}};

function carriesEntropyKey(account: OriginAccount | undefined): boolean {
	return !!account?.signer && 'mnemonicKey' in account.signer;
}

/**
 * The same account without the legacy entropy key. Returns a COPY rather than mutating: the object
 * may be one an app already holds a reference to, and silently emptying a field under it is worse
 * than handing back a clean one. Returns the input untouched when there is nothing to strip.
 */
function withoutEntropyKey(account: OriginAccount): OriginAccount {
	if (!carriesEntropyKey(account)) {
		return account;
	}
	const {mnemonicKey, ...signer} = account.signer as OriginAccountWithLegacyEntropyKey['signer'];
	return {...account, signer};
}

export type ConnectOptions = {
	requireUserConfirmationBeforeSignatureRequest?: boolean;
	doNotStoreLocally?: boolean;
	requestSignatureRightAway?: boolean;
};

export type EnsureConnectedOptions = ConnectOptions & {
	skipChainCheck?: boolean; // Skip chain validation for WalletConnected step
	// Initiate a connection attempt even when the flow is at rest on a picker step.
	// Only use it when you know no picker is on screen: it connects with the given (or default) mechanism
	// instead of waiting for the user's choice.
	forceConnect?: boolean;
};

// Error thrown by `ensureConnected` when a connection attempt ends without reaching the target step.
// `cause` (and the convenience `code` copied from it) is the underlying error reported by the wallet,
// so callers can distinguish a user rejection (EIP-1193 code 4001) from a genuine failure.
export class ConnectionFailure extends Error {
	name = 'ConnectionFailure';
	readonly code?: unknown;
	constructor(message: string, cause?: unknown) {
		super(message);
		this.cause = cause;
		this.code = (cause as {code?: unknown} | undefined)?.code;
	}
}

// Steps where a connection attempt is actively in progress: reaching one of them means an attempt started,
// and staying in one means we should keep waiting.
const stepsInProgress: readonly string[] = [
	'FetchingWallets',
	'WaitingForWalletConnection',
	'ChooseWalletAccount',
	'PopupLaunched',
	'WaitingForSignature',
];
// Steps where the flow is at rest, waiting for a brand new user decision.
// Note these are also the steps `ensureConnected` is commonly called from (the picker is showing),
// so being in one of them is NOT a failure by itself: only a transition back into one after an attempt started is.
// `WalletChosen` counts as at rest too: a failed upgrade restores it WITH a fresh error, so the
// error branch rejects before this list is even reached — and a resting `WalletChosen` carrying a
// stale error is as retryable as a picker carrying one.
const stepsAtRest: readonly string[] = ['Idle', 'MechanismToChoose', 'WalletToChoose', 'WalletChosen'];

export type ConnectionStore<
	WalletProviderType,
	Target extends TargetStep = 'SignedIn',
	WalletOnly extends boolean = false,
> = {
	subscribe: (run: (value: Connection<WalletProviderType>) => void) => () => void;
	connect: (
		mechanism?: Target extends 'WalletConnected'
			? WalletMechanism<string | undefined, `0x${string}` | undefined>
			: WalletOnly extends true
				? WalletMechanism<string | undefined, `0x${string}` | undefined>
				: Mechanism,
		options?: ConnectOptions,
	) => Promise<void>;
	cancel: () => void;
	back: (step: 'MechanismToChoose' | 'Idle' | 'WalletToChoose') => void;
	clearError: () => void;
	requestSignature: () => Promise<void>;
	connectToAddress: (
		address: `0x${string}`,
		options?: {requireUserConfirmationBeforeSignatureRequest: boolean},
	) => void;
	disconnect: () => void;
	// Pick a wallet via EIP-6963 and set it as the read provider WITHOUT going through
	// the connect/accounts flow. The wallet's provider is set on the always-on wrapper so
	// reads route through it (when `prioritizeWalletProvider` is true), but no accounts are
	// requested and signing is refused. Transitions to the `WalletChosen` step.
	// If `name` is omitted and only one wallet is detected, auto-selects it; if multiple
	// wallets are detected, transitions to `WalletToChoose` for the user to pick. On a
	// `targetStep: 'WalletChosen'` store, that picker's handler should call `selectWallet`
	// (not `connect`, which is the upgrade path and pops eth_requestAccounts).
	// Note `WalletChosen` is a resting point, not a step towards a HIGHER target: on a
	// 'SignedIn'/'WalletConnected' store it satisfies nothing by itself — call `connect()`
	// to upgrade from it. Pass `options.doNotStoreLocally` to keep the choice out of
	// persisted storage (no auto-connect restore on reload).
	selectWallet: (name?: string, options?: {doNotStoreLocally?: boolean}) => Promise<void>;
	getSignatureForPublicKeyPublication: () => Promise<`0x${string}`>;
	getDelegation: (target: {chainId: number; contract: `0x${string}`; deadline?: number}) => Promise<SavedDelegation>;
	switchWalletChain: (chainInfo?: BasicChainInfo) => Promise<void>;
	unlock: () => Promise<void>;

	// ensureConnected signature depends on target and walletOnly
	ensureConnected: Target extends 'WalletChosen'
		? {
				// Resolves to ChosenOrBetter rather than exactly WalletChosen: a wallet that is
				// already connected or signed in satisfies the lower target.
				(options?: EnsureConnectedOptions): Promise<ChosenOrBetter<WalletProviderType>>;
				(
					step: 'WalletChosen',
					mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
					options?: EnsureConnectedOptions,
				): Promise<ChosenOrBetter<WalletProviderType>>;
			}
		: Target extends 'WalletConnected'
			? {
					(options?: EnsureConnectedOptions): Promise<WalletConnected<WalletProviderType>>;
					(
						step: 'WalletConnected',
						mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
						options?: EnsureConnectedOptions,
					): Promise<WalletConnected<WalletProviderType>>;
				}
			: WalletOnly extends true
				? {
						// walletOnly: true for SignedIn - returns SignedInWithWallet (not full SignedIn union)
						(options?: EnsureConnectedOptions): Promise<SignedInWithWallet<WalletProviderType>>;
						(
							step: 'WalletConnected',
							mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
							options?: EnsureConnectedOptions,
						): Promise<WalletConnected<WalletProviderType>>;
						(
							step: 'SignedIn',
							mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
							options?: EnsureConnectedOptions,
						): Promise<SignedInWithWallet<WalletProviderType>>;
					}
				: {
						(options?: EnsureConnectedOptions): Promise<SignedIn<WalletProviderType>>;
						(
							step: 'WalletConnected',
							mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
							options?: EnsureConnectedOptions,
						): Promise<WalletConnected<WalletProviderType>>;
						(
							step: 'SignedIn',
							mechanism?: Mechanism,
							options?: EnsureConnectedOptions,
						): Promise<SignedIn<WalletProviderType>>;
					};

	// Method to check if target step is reached with proper type narrowing
	isTargetStepReached: (
		connection: Connection<WalletProviderType>,
	) => connection is Target extends 'WalletChosen'
		? ChosenOrBetter<WalletProviderType>
		: Target extends 'WalletConnected'
			? ConnectedWithWallet<WalletProviderType>
			: WalletOnly extends true
				? SignedInWithWallet<WalletProviderType>
				: SignedInState<WalletProviderType>;

	// New properties
	targetStep: Target;
	walletOnly: WalletOnly;

	// Existing properties
	provider: WalletProviderType;
	chainId: string;
	chainInfo: ChainInfo<WalletProviderType>;

	// Request tracking - subscribe to RPC request events
	onRequest: (handler: RequestEventHandler) => () => void;
};

// Every store shape a caller might hold. `createConnection` no longer returns the last member:
// a `WalletConnected` connection is always wallet-only at runtime, so its overloads report
// `WalletOnly = true`. It is kept in the union deliberately, because the type is exported and
// narrowing it would break any consumer that spelled it out explicitly. For `WalletConnected` the
// two members differ only in the `walletOnly` literal anyway: every other member of
// `ConnectionStore` ignores `WalletOnly` once `Target` is `'WalletChosen'` or `'WalletConnected'`
// (both are wallet-only by definition, so the union spells them with `WalletOnly = true` only).
export type AnyConnectionStore<WalletProviderType> =
	| ConnectionStore<WalletProviderType, 'WalletChosen', true>
	| ConnectionStore<WalletProviderType, 'SignedIn', true>
	| ConnectionStore<WalletProviderType, 'WalletConnected', true>
	| ConnectionStore<WalletProviderType, 'SignedIn', false>
	| ConnectionStore<WalletProviderType, 'WalletConnected', false>;

// Function overloads for proper typing
//
// `walletHost` is optional exactly when no popup can be reached: on both `WalletConnected`
// overloads (which never sign in) and on the `walletOnly: true` `SignedIn` overloads (where
// `connect` always defaults the mechanism to `{type: 'wallet'}`, so the mechanism picker is never
// shown). It stays REQUIRED on the `walletOnly?: false` `SignedIn` overloads, which can reach the
// hosted email/oauth/mnemonic popups. That split is the promise; see the README section
// "Wallet-only sign-in with no backend", and `test/types/wallet-only-no-host.types.ts` which fails
// to compile if it is flattened.
//
// The `WalletChosen` and `WalletConnected` overloads report `WalletOnly = true`, because that is
// what the runtime computes: `walletOnly = settings.walletOnly || targetStep === 'WalletChosen' ||
// targetStep === 'WalletConnected'`, so both stores always expose `walletOnly === true`.

// WalletChosen target with custom wallet connector - walletHost optional
export function createConnection<WalletProviderType>(settings: {
	targetStep: 'WalletChosen';
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	autoConnect?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	storagePrefix?: string;
}): ConnectionStore<WalletProviderType, 'WalletChosen', true>;

// WalletChosen target with default Ethereum connector - walletHost optional
export function createConnection(settings: {
	targetStep: 'WalletChosen';
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	autoConnect?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	storagePrefix?: string;
}): ConnectionStore<UnderlyingEthereumProvider, 'WalletChosen', true>;

// WalletConnected target with custom wallet connector - walletHost optional
export function createConnection<WalletProviderType>(settings: {
	targetStep: 'WalletConnected';
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	autoConnect?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	storagePrefix?: string;
}): ConnectionStore<WalletProviderType, 'WalletConnected', true>;

// WalletConnected target with default Ethereum connector - walletHost optional
export function createConnection(settings: {
	targetStep: 'WalletConnected';
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	autoConnect?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	storagePrefix?: string;
}): ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>;

// SignedIn target with walletOnly: true (custom wallet connector) - walletHost optional
export function createConnection<WalletProviderType>(settings: {
	targetStep?: 'SignedIn';
	walletOnly: true;
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	domainRedirectBridge?: boolean;
	storagePrefix?: string;
}): ConnectionStore<WalletProviderType, 'SignedIn', true>;

// SignedIn target with walletOnly: true (default Ethereum connector) - walletHost optional
export function createConnection(settings: {
	targetStep?: 'SignedIn';
	walletOnly: true;
	walletHost?: string;
	nodeURL?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	domainRedirectBridge?: boolean;
	storagePrefix?: string;
}): ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', true>;

// SignedIn target (explicit) with custom wallet connector - walletHost required
export function createConnection<WalletProviderType>(settings: {
	targetStep?: 'SignedIn';
	walletOnly?: false;
	walletHost: string;
	nodeURL?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	signingOrigin?: string;
	// Permissions to ask for at connect time. See `PermissionDeclaration`.
	permissions?: PermissionDeclaration[];
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	domainRedirectBridge?: boolean;
	storagePrefix?: string;
}): ConnectionStore<WalletProviderType, 'SignedIn', false>;

// SignedIn target (default) with default Ethereum connector - walletHost required
export function createConnection(settings: {
	targetStep?: 'SignedIn';
	walletOnly?: false;
	walletHost: string;
	nodeURL?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	signingOrigin?: string;
	// Permissions to ask for at connect time. See `PermissionDeclaration`.
	permissions?: PermissionDeclaration[];
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	domainRedirectBridge?: boolean;
	storagePrefix?: string;
}): ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', false>;

// Implementation signature
export function createConnection<WalletProviderType = UnderlyingEthereumProvider>(settings: {
	targetStep?: TargetStep;
	walletOnly?: boolean;
	signingOrigin?: string;
	// Permissions to ask for at connect time. See `PermissionDeclaration`.
	permissions?: PermissionDeclaration[];
	walletHost?: string;
	autoConnect?: boolean;
	walletConnector?: WalletConnector<WalletProviderType>;
	requestSignatureAutomaticallyIfPossible?: boolean;
	useCurrentAccount?: 'always' | 'whenSingle' | false;
	nodeURL?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
	// opt-in: enable the Same-Origin Callback Bridge (domain-redirect fallback)
	// for the oauth-redirection flow. Requires hosting `_etherplay_accounts.html`
	// on the parent origin.
	domainRedirectBridge?: boolean;
	// Namespace this connection's persisted state (both `localStorage` and `sessionStorage`).
	// A page may run several connections at once. The typical case is a player connection
	// (`targetStep: 'SignedIn'`) plus a separate payment connection
	// (`targetStep: 'WalletConnected'`) so the payer need not be the signed-in player.
	// Without distinct prefixes those connections share one identity slot and one
	// last-wallet slot, and overwrite/delete each other's state. Give each connection its
	// own prefix and they become fully independent.
	// Defaults to '', which keeps the historical keys `__origin_account` and `__last_wallet`
	// exactly as they are, so existing single-connection apps keep their stored session.
	storagePrefix?: string;
}): ConnectionStore<WalletProviderType, TargetStep, boolean> {
	function originToSignWith() {
		return settings.signingOrigin || origin;
	}

	// Per-connection storage namespace. Computed once, up front, because the auto-connect block
	// below reads storage during construction.
	const storagePrefix = settings.storagePrefix || '';
	const storageKeyAccount = `${storagePrefix}${baseStorageKeyAccount}`;
	const storageKeyLastWallet = `${storagePrefix}${baseStorageKeyLastWallet}`;

	const walletConnector =
		settings.walletConnector || (new EthereumWalletConnector() as unknown as WalletConnector<WalletProviderType>);
	const alwaysOnChainId = '' + settings.chainInfo.id;
	const alwaysOnProviderWrapper = walletConnector.createAlwaysOnProvider({
		endpoint:
			'provider' in settings.chainInfo
				? settings.chainInfo.provider
				: settings.nodeURL
					? settings.nodeURL
					: settings.chainInfo.rpcUrls.default.http[0],
		chainId: '' + settings.chainInfo.id,
		prioritizeWalletProvider: settings.prioritizeWalletProvider,
		requestsPerSecond: settings.requestsPerSecond,
	});

	// Determine target step (defaults to 'SignedIn')
	const targetStep: TargetStep = settings.targetStep || 'SignedIn';

	// Determine walletOnly (defaults to false, but true implies WalletConnected target behavior for mechanism)
	const walletOnly = settings.walletOnly || targetStep === 'WalletChosen' || targetStep === 'WalletConnected';

	let autoConnect = true;
	if (typeof settings.autoConnect !== 'undefined') {
		autoConnect = settings.autoConnect;
	}

	// For SignedIn target, we can auto-request signature if configured
	// For WalletConnected target, this is always false (we never auto-request signature)
	const requestSignatureAutomaticallyIfPossible =
		targetStep === 'SignedIn' ? settings.requestSignatureAutomaticallyIfPossible || false : false;

	// The list as last published. Kept so that an UNCHANGED list keeps its identity across publishes:
	// the wrapper hands back a fresh array every call, and publishing a new array (and so a new
	// `wallet` object) on every unrelated `set` would invalidate `derived` stores, `{#key}` blocks and
	// effect dependencies in consumers for no reason. Requests are compared by identity because a
	// `PendingRequest` is created once and never mutated.
	let publishedPendingRequests: PendingRequest[] = [];
	function currentPendingRequests(): PendingRequest[] {
		const latest = alwaysOnProviderWrapper.getPendingRequests();
		if (
			latest.length === publishedPendingRequests.length &&
			latest.every((request, i) => request === publishedPendingRequests[i])
		) {
			return publishedPendingRequests;
		}
		publishedPendingRequests = latest;
		return latest;
	}

	let $connection: Connection<WalletProviderType> = {
		step: 'Idle',
		loading: true,
		wallet: undefined,
		wallets: [],
		pendingRequests: currentPendingRequests(),
	};
	const _store = writable<Connection<WalletProviderType>>($connection);
	// THE ONE PLACE A PUBLISHED STATE IS BUILT, which is what makes the announcement rule a
	// property of the store rather than a habit of whoever wrote the last rebuild.
	//
	// `pendingRequests` is stamped here from the wrapper, so no caller can assert an empty list and
	// none has to remember to copy one. `ConnectionInput` does not even carry the field, so the rule
	// is now enforced by the type rather than by nine identical call sites — and by the tenth kind of
	// site, the paths that build NO wallet, which was not a call site at all and so lost the list
	// silently.
	//
	// The deprecated `wallet.pendingRequests` mirror is stamped from the same read, so the two cannot
	// drift while consumers migrate.
	function set(connection: ConnectionInput<WalletProviderType>) {
		// A STATE THAT SHOWS NO WALLET MUST NOT LEAVE ONE LIVE, and this is where that is made true
		// rather than at each of the eleven places that used to remember it. Two of those eleven did
		// not: a bare `connect()` landing on `MechanismToChoose`, and a sign-in popup launched by a
		// user who was already wallet-connected. Both left the wrapper holding the wallet with its
		// status still `connected`, so it kept SIGNING for a state showing no wallet.
		//
		// `WaitingForWalletConnection` is the one exception, and it is a real one rather than an
		// oversight: it is the in-progress step of `connect` itself, which shows no wallet precisely
		// because it is in the middle of registering one. Every other wallet-less step is somewhere the
		// flow RESTS.
		//
		// Enforced here rather than asserted because the failure directions are not symmetric. A
		// forgotten teardown keeps a wallet signing invisibly, which is the bug this exists to stop; an
		// unwanted one makes reads fall back to the configured endpoint and signing refuse, which is
		// loud and safe. So the automatic behaviour is the conservative one.
		if (!connection.wallet && connection.step !== 'WaitingForWalletConnection') {
			teardownWallet();
		}
		const pendingRequests = currentPendingRequests();
		if (!connection.wallet) {
			$connection = {...connection, pendingRequests};
			_store.set($connection);
			return $connection;
		}
		// Callers hand back a wallet they spread from the published state, so it usually already
		// carries the mirror. Read through a widened view rather than rebuilding blindly: when the
		// list has not changed, the wallet object keeps its identity and consumers' `derived` stores,
		// `{#key}` blocks and effect dependencies do not re-run on an unrelated publish.
		const incomingWallet = connection.wallet as WalletStateInput<WalletProviderType> & {
			pendingRequests?: PendingRequest[];
		};
		$connection = {
			...connection,
			pendingRequests,
			wallet:
				incomingWallet.pendingRequests === pendingRequests
					? (incomingWallet as WalletState<WalletProviderType>)
					: {...connection.wallet, pendingRequests},
		};
		_store.set($connection);
		return $connection;
	}

	// HOW `pendingRequests` IS MAINTAINED.
	//
	// The wrapper owns the list; the store only mirrors it. The mirror is stamped in `set` above, on
	// EVERY publish, so a state cannot be built that contradicts the wrapper — including one that
	// carries no wallet. This subscription's job is only to make the store publish again when the
	// list changes, since a request starting or ending is not otherwise a state transition.
	//
	// The rule exists because asserting `[]` is not a harmless guess: it ERASES an outstanding
	// request, and permanently, since the next event for that request is the one that ends it, which
	// writes an empty list too, so nothing ever puts it back. The user is left holding a wallet popup
	// that the app believes does not exist. That was a real bug, and the flow that caused it is the
	// ordinary one: a send against a LOCKED wallet raises the connection flow, so `connect()` runs
	// while the wallet is holding the transaction and rebuilds the state under it. See
	// `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`.
	//
	// Never unsubscribed, deliberately. It used to be torn down by `disconnect()`, which silenced
	// request announcements for the REST OF THE CONNECTION'S LIFE, since nothing re-subscribes: a
	// disconnect followed by a reconnect left the app blind to every subsequent wallet prompt. The
	// wrapper is created here and lives exactly as long as this connection, so there is nothing to
	// release.
	alwaysOnProviderWrapper.onRequest(() => {
		// Republish. `set` re-reads the wrapper, so this needs to say nothing about the list itself,
		// and it must run whether or not a wallet is currently in the state: a request outstanding
		// while the flow rests on `wallet: undefined` is exactly the case that used to go unreported.
		set($connection);
	});
	// Where the flow comes to rest when a connection attempt fails.
	//
	// The rule: rest on the step that offers the user a real next decision, and never on a step this app has
	// no reason to render. In wallet-only mode the mechanism picker is never shown (`connect` always defaults
	// the mechanism to `{type: 'wallet'}`), so resting on `MechanismToChoose` there is a dead end: the app
	// renders nothing and the user can neither retry nor cancel.
	// - not wallet-only: `MechanismToChoose`, the user can pick another mechanism.
	// - wallet-only with several wallets detected: `WalletToChoose`, the user can pick another wallet.
	// - wallet-only with a single (or no) wallet: `Idle`, there is no choice left to offer.
	// The error is always kept, since the UI uses it to explain the failure next to the picker.
	//
	// Auto-connect failures follow the same rule and rest on `Idle`: the user asked for nothing, so there is
	// no decision to offer them. A cancelled popup is likewise a cancellation, not a failure, and rests on `Idle`.
	function setConnectionFailure(error: {message: string; cause?: any}) {
		const wallets = $connection.wallets;
		// Every resting state below has `wallet: undefined`, so `set` tears the live wallet down.
		if (!walletOnly) {
			set({step: 'MechanismToChoose', wallets, wallet: undefined, error});
		} else if (wallets.length > 1) {
			set({step: 'WalletToChoose', mechanism: {type: 'wallet'}, wallets, wallet: undefined, error});
		} else {
			set({step: 'Idle', loading: false, wallets, wallet: undefined, error});
		}
	}
	function setError(error: {message: string; cause?: any}) {
		if ($connection) {
			set({
				...$connection,
				error,
			});
		} else {
			throw new Error(`no connection`);
		}
	}

	function clearError() {
		if ($connection) {
			set({
				...$connection,
				error: undefined,
			});
		}
	}

	let _wallet: {provider: WalletProvider<WalletProviderType>; chainId: string} | undefined;

	let popup: PopupPromise<OriginAccount> | undefined;

	// Wallet announcements are not guaranteed to be unique.
	//
	// EIP-6963 discovery is page-wide: anyone dispatching `eip6963:requestProvider` makes every
	// installed wallet announce itself again, to every listener currently attached. A second
	// connection constructed while this one is still listening therefore replays the same wallets
	// into this connection's list. Appending them blindly showed one installed wallet twice, which
	// pushed the flow into `WalletToChoose` ("2 wallets available") instead of connecting directly.
	//
	// So the list is built as a set, keyed on the announcement identity rather than on who asked for
	// it. That holds no matter how many connections, connectors or unrelated libraries are
	// requesting providers in the page, and callers need not think about it.
	function isSameWallet(a: WalletHandle<WalletProviderType>, b: WalletHandle<WalletProviderType>): boolean {
		// `uuid` is the EIP-6963 identity of an announcement. `rdns` is the stable identity of the
		// wallet itself, checked as a fallback for wallets that regenerate their uuid per announcement.
		if (a.info.uuid && b.info.uuid && a.info.uuid === b.info.uuid) {
			return true;
		}
		return !!a.info.rdns && a.info.rdns === b.info.rdns;
	}

	function fetchWallets() {
		walletConnector.fetchWallets((detail) => {
			const existingWallets = $connection.wallets;
			if (existingWallets.some((existing) => isSameWallet(existing, detail))) {
				return;
			}

			set({
				...$connection,
				wallets: [...existingWallets, detail],
			});
		});
	}

	function waitForWallet(name: string): Promise<WalletHandle<WalletProviderType>> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval);
				reject('timeout');
			}, 1000);
			const interval = setInterval(() => {
				const wallet = $connection.wallets.find((v) => v.info.name == name);
				if (wallet) {
					clearTimeout(timeout);
					clearInterval(interval);
					resolve(wallet);
				}
			}, 100);
		});
	}

	// One-shot cleanup of accounts persisted by older versions, which carried `signer.mnemonicKey`:
	// the entropy the whole origin account derives from, sitting at rest in this origin's storage.
	// Not writing it any more does nothing for anyone who already has one on disk.
	//
	// At construction, for EVERY connection, rather than inside `getOriginAccount`: an app with
	// `autoConnect: false` never reads its stored account at all, so nothing would ever come across
	// the legacy blob and the seed would sit there untouched for as long as the app is installed.
	// Both storages, each in place, because they can hold different things.
	//
	// Behind the same `typeof window` guard as everything else here, so SSR and prerender
	// construction stays storage-inert (see `test/ssr-inert.test.ts`).
	if (typeof window !== 'undefined') {
		try {
			stripStoredEntropyKey(localStorage);
			stripStoredEntropyKey(sessionStorage);
		} catch {
			// Storage access throws outright in some configurations (disabled cookies, Safari private
			// browsing). Failing to clean up must never stop a connection from being constructed.
		}
	}

	// Auto-connect logic based on targetStep
	// When targetStep: 'WalletConnected' - only check lastWallet
	// When targetStep: 'SignedIn' - check originAccount first, then fallback to lastWallet
	let autoConnectHandled = false;
	if (autoConnect) {
		if (typeof window !== 'undefined') {
			try {
				// For SignedIn target, check for existing account first
				if (targetStep === 'SignedIn') {
					const existingAccount = getOriginAccount();
					if (existingAccount && existingAccount.signer) {
						autoConnectHandled = true;
						const mechanismUsed = existingAccount.mechanismUsed as
							| AuthMechanism
							| WalletMechanism<string, `0x${string}`>;
						if (mechanismUsed.type == 'wallet') {
							const walletMechanism = mechanismUsed as WalletMechanism<string, `0x${string}`>;
							waitForWallet(walletMechanism.name)
								.then(async (walletDetails: WalletHandle<WalletProviderType>) => {
									const walletProvider = walletDetails.walletProvider;
									const chainIdAsHex = await withTimeout(walletProvider.getChainId());
									const chainId = Number(chainIdAsHex).toString();
									_wallet = {provider: walletProvider, chainId};
									alwaysOnProviderWrapper.setWalletProvider(walletProvider.underlyingProvider);
									watchForChainIdChange(_wallet.provider);
									let accounts: `0x${string}`[] = [];
									accounts = await withTimeout(walletProvider.getAccounts());
									accounts = accounts.map((v) => v.toLowerCase() as `0x${string}`);
									set({
										step: 'SignedIn',
										account: existingAccount,
										mechanism: walletMechanism,
										wallets: $connection.wallets,
										wallet: {
											provider: walletProvider,
											accounts,
											status: 'connected',
											accountChanged: undefined,
											chainId,
											invalidChainId: alwaysOnChainId != chainId,
											switchingChain: false,
										},
									});
									alwaysOnProviderWrapper.setWalletStatus('connected');
									onAccountChanged(accounts);
									watchForAccountChange(walletProvider);
								})
								.catch((err) => {
									// The wallet may have been registered on the wrapper before the failure (e.g.
									// getAccounts threw). `set` tears it down: Idle carries no wallet.
									set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
								});
						} else {
							set({
								step: 'SignedIn',
								account: existingAccount,
								mechanism: mechanismUsed,
								wallets: $connection.wallets,
								wallet: undefined,
							});
						}
					}
				}

				// For WalletChosen target, restore the wallet choice without requesting accounts.
				// This is the auto-connect path for the "chosen but unconnected" feature: the
				// wallet provider is set so reads route through it, but no eth_requestAccounts or
				// eth_accounts is called. The wallet is in 'disconnected' status.
				if (targetStep === 'WalletChosen') {
					autoConnectHandled = true;
					const lastWallet = getLastWallet();
					if (lastWallet) {
						waitForWallet(lastWallet.name)
							.then(async (walletDetails: WalletHandle<WalletProviderType>) => {
								const walletProvider = walletDetails.walletProvider;
								const chainIdAsHex = await withTimeout(walletProvider.getChainId());
								const chainId = Number(chainIdAsHex).toString();
								_wallet = {provider: walletProvider, chainId};
								alwaysOnProviderWrapper.setWalletProvider(walletProvider.underlyingProvider);
								alwaysOnProviderWrapper.setWalletStatus('disconnected');
								watchForChainIdChange(_wallet.provider);
								set({
									step: 'WalletChosen',
									mechanism: {type: 'wallet', name: lastWallet.name},
									wallets: $connection.wallets,
									wallet: {
										provider: walletProvider,
										accounts: [],
										status: 'disconnected',
										connecting: false,
										accountChanged: undefined,
										chainId,
										invalidChainId: alwaysOnChainId != chainId,
										switchingChain: false,
									},
								});
							})
							.catch((err) => {
								// The wallet may have been registered on the wrapper before the failure (e.g.
								// getAccounts threw). `set` tears it down: Idle carries no wallet.
								set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
							});
					} else {
						set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
					}
				}

				// For both targets, fallback to lastWallet if no account found (or WalletConnected target)
				if (!autoConnectHandled) {
					const lastWallet = getLastWallet();
					// A lastWallet without an address was saved by selectWallet (WalletChosen flow).
					// The WalletConnected/SignedIn auto-connect needs an address to restore the
					// account; without one, fall back to Idle rather than constructing an invalid state.
					if (lastWallet && lastWallet.address) {
						waitForWallet(lastWallet.name)
							.then(async (walletDetails: WalletHandle<WalletProviderType>) => {
								const walletProvider = walletDetails.walletProvider;
								const chainIdAsHex = await withTimeout(walletProvider.getChainId());
								const chainId = Number(chainIdAsHex).toString();
								_wallet = {provider: walletProvider, chainId};
								alwaysOnProviderWrapper.setWalletProvider(walletProvider.underlyingProvider);
								watchForChainIdChange(_wallet.provider);

								let accounts: `0x${string}`[] = [];
								accounts = await withTimeout(walletProvider.getAccounts());
								accounts = accounts.map((v) => v.toLowerCase() as `0x${string}`);
								set({
									step: 'WalletConnected',
									mechanism: lastWallet,
									wallets: $connection.wallets,
									wallet: {
										provider: walletProvider,
										accounts,
										status: 'connected',
										accountChanged: undefined,
										chainId,
										invalidChainId: alwaysOnChainId != chainId,
										switchingChain: false,
									},
									account: {address: lastWallet.address},
								});
								alwaysOnProviderWrapper.setWalletStatus('connected');
								onAccountChanged(accounts);
								watchForAccountChange(walletProvider);
							})
							.catch((err) => {
								// The wallet may have been registered on the wrapper before the failure (e.g.
								// getAccounts threw). `set` tears it down: Idle carries no wallet.
								set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
							});
					} else {
						set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
					}
				}
			} catch {
				set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
			}
		}
	} else {
		set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
	}
	fetchWallets();

	/**
	 * Remove the legacy entropy key from ONE storage, in place.
	 *
	 * Per storage, rather than reading one and re-saving through `saveOriginAccount`: that writes
	 * BOTH slots, so cleaning up would resurrect an account into a storage it had already left. The
	 * two do not expire together (Safari's ITP evicts `localStorage` after seven days of no
	 * interaction while an open tab keeps its `sessionStorage`), and a cleanup that restores a
	 * deleted session is a different bug. Each slot is fixed where it lies or left alone.
	 */
	function stripStoredEntropyKey(storage: Storage) {
		const raw = storage.getItem(storageKeyAccount);
		if (!raw) {
			return;
		}
		let account: OriginAccount;
		try {
			account = JSON.parse(raw) as OriginAccount;
		} catch {
			// Not parseable, so not an account this library wrote, and not ours to rewrite.
			return;
		}
		if (carriesEntropyKey(account)) {
			storage.setItem(storageKeyAccount, JSON.stringify(withoutEntropyKey(account)));
		}
	}

	function getOriginAccount(): OriginAccount | undefined {
		const fromStorage = localStorage.getItem(storageKeyAccount);
		if (fromStorage) {
			// Stripped again on the way out. The construction-time cleanup above has already fixed the
			// stored copy; this is what guarantees the RESTORED SESSION object carries no seed even if a
			// legacy blob appeared after construction, e.g. written by an older build of the app running
			// in another tab on this same origin.
			return withoutEntropyKey(JSON.parse(fromStorage) as OriginAccount);
		}
	}
	function saveOriginAccount(account: OriginAccount) {
		// The invariant lives on the WRITE side: nothing carrying the entropy key is ever persisted,
		// whatever produced the account. Stripping only at the sites that currently build one would be
		// a statement about today's callers; this is a statement about the storage.
		const accountSTR = JSON.stringify(withoutEntropyKey(account));
		sessionStorage.setItem(storageKeyAccount, accountSTR);
		localStorage.setItem(storageKeyAccount, accountSTR);
	}
	function deleteOriginAccount() {
		sessionStorage.removeItem(storageKeyAccount);
		localStorage.removeItem(storageKeyAccount);
	}

	function getLastWallet(): WalletMechanism<string, `0x${string}` | undefined> | undefined {
		const fromStorage = localStorage.getItem(storageKeyLastWallet);
		if (fromStorage) {
			return JSON.parse(fromStorage) as WalletMechanism<string, `0x${string}` | undefined>;
		}
	}
	function saveLastWallet(wallet: WalletMechanism<string, `0x${string}` | undefined>) {
		const lastWalletSTR = JSON.stringify(wallet);
		sessionStorage.setItem(storageKeyLastWallet, lastWalletSTR);
		localStorage.setItem(storageKeyLastWallet, lastWalletSTR);
	}
	function deleteLastWallet() {
		sessionStorage.removeItem(storageKeyLastWallet);
		localStorage.removeItem(storageKeyLastWallet);
	}

	let signaturePending: {reject: (error: unknown) => void; id: number} | undefined = undefined;
	let signatureCounter = 0;
	function _requestSignature(provider: WalletProvider<WalletProviderType>, msg: string, address: `0x${string}`) {
		const id = ++signatureCounter;
		if (signaturePending) {
			const tmp = signaturePending;
			signaturePending = undefined;
			tmp.reject(new Error('signature request replaced', {cause: {code: 111111}}));
		}
		return new Promise<`0x${string}`>((resolve, reject) => {
			signaturePending = {reject, id};

			// console.log(`check for timeout...`);
			// this step ensure timeout
			// await withTimeout(
			// 	provider.request({
			// 		method: 'eth_chainId',
			// 	}),
			// );
			// await withTimeout(
			// 	provider.request({
			// 		method: 'eth_accounts',
			// 	}),
			// );
			provider
				.signMessage(msg, address)
				.then((signature) => {
					if (signaturePending?.id === id) {
						signaturePending = undefined;
						resolve(signature);
					}
				})
				.catch((err) => {
					if (signaturePending?.id === id) {
						signaturePending = undefined;
						reject(err);
					}
				});
		});
	}

	async function requestSignature() {
		if ($connection.step !== 'WalletConnected' && $connection.step !== 'WaitingForSignature') {
			throw new Error(`invalid step: ${$connection.step}, needs to be WalletConnected`);
		}

		const provider = $connection.wallet.provider;
		const message = originKeyMessage(originToSignWith());

		set({
			...$connection,
			step: 'WaitingForSignature',
		});

		let signature: `0x${string}`;
		try {
			signature = await _requestSignature(provider, message, $connection.mechanism.address);
		} catch (err) {
			console.error(err);
			if ((err as any)?.cause?.code === 111111) {
				// We ignore replaced signature request
				return;
			}
			// TODO handle rejection (code: 4001 ?)
			set({
				...$connection,
				step: 'WalletConnected',
				mechanism: {
					type: 'wallet',
					name: $connection.mechanism.name,
					address: $connection.mechanism.address,
				},
				error: {message: 'failed to sign message', cause: err},
			});
			return;
		}

		const originKey = fromSignatureToKey(signature);
		const originMnemonic = fromEntropyKeyToMnemonic(originKey);
		const originAccount = walletConnector.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

		const account = {
			address: $connection.mechanism.address as `0x${string}`,
			signer: {
				origin: originToSignWith(),
				address: originAccount.address,
				publicKey: originAccount.publicKey,
				// `originKey` stays local to this function: it is the entropy the whole origin account is
				// derived from, and this object gets persisted. See `OriginAccount['signer']`.
				privateKey: originAccount.privateKey,
			},
			metadata: {},
			mechanismUsed: $connection.mechanism,
			savedPublicKeyPublicationSignature: undefined,
			// Nothing pre-generated on the wallet path, and nothing missing either: the owner is a
			// live wallet that can be asked to sign at the moment a credential is needed, which is
			// strictly better than minting one in advance for a contract it may never touch. Use
			// `getDelegation`. Pre-generation exists for the hosted mechanisms, which cannot sign
			// live because sign-in is the only moment their key is reachable.
			savedDelegations: [],
			// ...but if the app ASKED, it gets an answer. Silence here would be indistinguishable
			// from "nobody asked", which is the one thing a permission result exists to prevent: the
			// app would offer a re-prompt for something that was never refused and needs no prompt
			// at all. `sign-on-demand` says the credential is available whenever it is wanted.
			permissions: declaredPermissionsUnavailable(),
			accountType: walletConnector.accountGenerator.type,
		};
		set({
			...$connection,
			step: 'SignedIn',
			account,
			wallet: $connection.wallet,
		});
		if (remember) {
			saveOriginAccount(account);
		}
	}

	function connectToAddress(
		address: `0x${string}`,
		options?: {requireUserConfirmationBeforeSignatureRequest: boolean},
	) {
		if ($connection.wallet) {
			connect(
				{
					type: 'wallet',
					address,
					name: $connection.mechanism.name,
				},
				{
					requireUserConfirmationBeforeSignatureRequest: options?.requireUserConfirmationBeforeSignatureRequest,
				},
			);
		} else {
			throw new Error(`need to be using a wallet`);
		}
	}

	function onChainChanged(chainIdAsHex: `0x${string}`) {
		const chainId = Number(chainIdAsHex).toString();
		if (_wallet) {
			_wallet.chainId = chainId;
		}
		if ($connection.wallet && $connection.wallet.chainId != chainId) {
			set({
				...$connection,
				wallet: {
					...$connection.wallet,
					chainId,
					invalidChainId: alwaysOnChainId != chainId,
				},
			});
		}
	}

	function onAccountChanged(accounts: `0x${string}`[]) {
		// TODO lastAccount
		// console.log('account changed', accounts);
		const accountsFormated = accounts.map((a) => a.toLowerCase()) as `0x${string}`[];

		if ($connection.wallet) {
			const locked = accountsFormated.length == 0;
			const addressSignedIn = $connection.mechanism.address;

			if (locked) {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						status: 'locked',
						unlocking: false,
					},
				});
				alwaysOnProviderWrapper.setWalletStatus('locked');
			} else {
				const disconnected = accountsFormated.find((v) => v == addressSignedIn) ? false : true;

				if (disconnected) {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							status: 'disconnected',
							connecting: false,
						},
					});
					alwaysOnProviderWrapper.setWalletStatus('disconnected');
				} else {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							status: 'connected',
						},
					});
					alwaysOnProviderWrapper.setWalletStatus('connected');
				}
			}

			if (accountsFormated.length > 0 && accountsFormated[0] != $connection.mechanism.address) {
				if (
					$connection.wallet &&
					(settings?.useCurrentAccount == 'always' ||
						(settings?.useCurrentAccount == 'whenSingle' && accountsFormated.length == 1))
				) {
					connectToAddress(accountsFormated[0]);
				} else {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							accountChanged: accountsFormated[0],
							accounts: accountsFormated,
						},
					});
				}
			} else {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						accountChanged: undefined,
						accounts: accountsFormated,
					},
				});
			}
		}
	}

	// TODO lastAccounts
	let lockCheckInterval: number | undefined;
	async function checkLockStatus() {
		try {
			const provider = $connection.wallet?.provider;
			if (provider) {
				let accounts = await withTimeout(provider.getAccounts());
				if (accounts.length == 0) {
					onAccountChanged(accounts);
				}
			}
		} catch {}
	}
	function watchForAccountChange(walletProvider: WalletProvider<WalletProviderType>) {
		walletProvider.listenForAccountsChanged(onAccountChanged);
		// we also poll accounts for checking lock status as Metamask does not notify it
		if (lockCheckInterval) {
			clearInterval(lockCheckInterval);
			lockCheckInterval = undefined;
		}
		lockCheckInterval = setInterval(checkLockStatus, 1000);
	}
	function stopWatchingForAccountChange(walletProvider: WalletProvider<WalletProviderType>) {
		walletProvider.stopListenForAccountsChanged(onAccountChanged);
		if (lockCheckInterval) {
			clearInterval(lockCheckInterval);
			lockCheckInterval = undefined;
		}
	}

	function watchForChainIdChange(walletProvider: WalletProvider<WalletProviderType>) {
		walletProvider.listenForChainChanged(onChainChanged);
	}
	function stopWatchingForChainIdChange(walletProvider: WalletProvider<WalletProviderType>) {
		walletProvider.stopListenForChainChanged(onChainChanged);
	}

	// Tear down the live wallet: stop routing requests through it, stop watching it, and
	// refuse signing. Any transition to a state whose `wallet` is `undefined` must go through
	// this (or re-register a different wallet immediately after), otherwise the always-on
	// wrapper keeps routing — and, while its status is 'connected', even SIGNING — through a
	// wallet the state no longer shows.
	function teardownWallet() {
		if (_wallet) {
			alwaysOnProviderWrapper.setWalletProvider(undefined);
			alwaysOnProviderWrapper.setWalletStatus('disconnected');
			stopWatchingForAccountChange(_wallet.provider);
			stopWatchingForChainIdChange(_wallet.provider);
			_wallet = undefined;
		}
	}

	// Restore the WalletChosen state after a failed upgrade attempt (a rejected accounts
	// request, an empty accounts answer, a dropped chainId, ...). The wallet was successfully
	// CHOSEN — only the connect/accounts step failed — so the choice must not be thrown away:
	// reads keep routing through the CHOSEN wallet (status: 'disconnected') and the failure is
	// set as the error on the restored state. This holds even when the failed attempt targeted
	// a DIFFERENT wallet: a refused accounts prompt on wallet B must not silently move the
	// read path the user had chosen on wallet A.
	//
	// Returns false when the flow was not upgrading from WalletChosen (no chosen mechanism or
	// wallet was captured), so the caller falls back to the ordinary connection-failure handling.
	function restoreWalletChosenAfterFailedConnect(
		errorMessage: string,
		cause: unknown,
		chosenMechanism: WalletMechanism<string, undefined> | undefined,
		chosenWallet: {provider: WalletProvider<WalletProviderType>; chainId: string} | undefined,
	): boolean {
		if (!chosenMechanism || !chosenWallet) {
			return false;
		}
		if (_wallet && _wallet.provider !== chosenWallet.provider) {
			// The attempt got far enough to register a DIFFERENT wallet on the wrapper: stop
			// watching it before the chosen one takes the wrapper back.
			stopWatchingForAccountChange(_wallet.provider);
			stopWatchingForChainIdChange(_wallet.provider);
		}
		// The fresher chainId wins: `onChainChanged` keeps updating the live `_wallet`, so when
		// the attempt was on the same provider its chainId may be newer than the captured one.
		const chainId = _wallet && _wallet.provider === chosenWallet.provider ? _wallet.chainId : chosenWallet.chainId;
		_wallet = {provider: chosenWallet.provider, chainId};
		stopWatchingForAccountChange(_wallet.provider);
		// Re-establish what the start of connect() tore down. If the failure happened early
		// (getChainId threw), the wrapper provider and the chain watcher were never
		// re-registered: without this the restored state would claim reads route through the
		// wallet while they silently fall back to the configured endpoint. stop-then-start so
		// a late failure (after re-registration) cannot register the watcher twice.
		alwaysOnProviderWrapper.setWalletProvider(_wallet.provider.underlyingProvider);
		alwaysOnProviderWrapper.setWalletStatus('disconnected');
		stopWatchingForChainIdChange(_wallet.provider);
		watchForChainIdChange(_wallet.provider);
		set({
			step: 'WalletChosen',
			mechanism: chosenMechanism,
			wallets: $connection.wallets,
			wallet: {
				provider: _wallet.provider,
				accounts: [],
				status: 'disconnected',
				connecting: false,
				accountChanged: undefined,
				chainId,
				invalidChainId: alwaysOnChainId != chainId,
				switchingChain: false,
			},
			error: {message: errorMessage, cause},
		});
		return true;
	}

	// WHAT `connect` MEANS, AND WHY IT IS NOT WHAT `ensureConnected` MEANS.
	//
	// `connect` drives the flow from the USER'S CHOICE. A bare `connect()` means "the user wants to
	// connect something", so with nothing naming a wallet it opens the picker — including from a
	// state that already has a wallet, which is how a consumer's switch-wallet button works. It does
	// not inspect the wallet's status, and it does not acquire a second meaning on a locked one.
	//
	// `ensureConnected` promises a TARGET instead, so it must do whatever reaching that target takes.
	// That is why it, and only it, reconnects a `WalletConnected` wallet that has gone locked or
	// disconnected: it cannot hand back a connection the caller can use otherwise. Hence this helper
	// having exactly one caller, which is not an oversight.
	//
	// `unlock()` is the narrow remedy in between, and is the one to reach for on a locked wallet: it
	// prompts the wallet and KEEPS the step, the account and the wallet, where re-running the flow
	// rebuilds all three. `wallet.status` is published precisely so a consumer can route on it and
	// offer "Unlock" rather than "Connect" when it says `locked`.
	//
	// The asymmetry is DELIBERATE, and used to be only implicit, which is how it came to be read as a
	// bug: a bare `connect()` on a locked wallet lands on the picker, and the picker tears the live
	// wallet down. What made that look destructive was a SEPARATE defect, now fixed — the teardown
	// also erased the announcement of whatever the wallet was still holding. It no longer does, since
	// `pendingRequests` lives on the connection and survives a state with no wallet, so the picker
	// costs a click and nothing else.
	//
	// Reasoned through in `docs/adr/0002-connect-ensure-connected-and-unlock-are-three-promises.md`,
	// including the version of this that made `connect` reconnect too, and why it was rejected. The
	// three behaviours are pinned side by side in `test/locked-wallet-reconnect.test.ts`, so that
	// collapsing any one of them into another fails.
	function mechanismToReconnect(): WalletMechanism<string, `0x${string}`> | undefined {
		if (
			$connection.step === 'WalletConnected' &&
			($connection.wallet.status === 'locked' || $connection.wallet.status === 'disconnected')
		) {
			return $connection.mechanism;
		}
		return undefined;
	}

	let remember: boolean = false;
	/**
	 * @param internal not part of the public `connect` surface. `addressIsPreference` marks a
	 * mechanism this library REUSED from the current state rather than one the caller asked for, so
	 * that a vanished address degrades to an ordinary connect instead of failing the attempt. See
	 * `resolveRequestedAddress` below.
	 */
	async function connect(mechanism?: Mechanism, options?: ConnectOptions, internal?: {addressIsPreference?: boolean}) {
		if (!mechanism && (targetStep === 'WalletConnected' || walletOnly)) {
			mechanism = {type: 'wallet'};
		}
		remember = !(options?.doNotStoreLocally || false);
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				// Remember what connect() is about to modify, so the catch block can distinguish
				// "was upgrading from WalletChosen" from "first-time connect". A failed upgrade
				// restores WalletChosen, and the restored state must describe the wallet that was
				// CHOSEN, which stays the read path even when the failed attempt targeted a
				// different wallet.
				const chosenMechanismBeforeConnect = $connection.step === 'WalletChosen' ? $connection.mechanism : undefined;
				const chosenWalletBeforeConnect = $connection.step === 'WalletChosen' ? _wallet : undefined;
				const specificAddress = mechanism.address;
				// WHICH ACCOUNT THE ATTEMPT IS FOR, once the wallet has said what it has.
				//
				// An address the CALLER named is a demand: `connectToAddress(a)` and
				// `connect({type: 'wallet', address: a})` mean that account and no other, so a wallet that
				// cannot offer it fails the attempt rather than connecting to something else.
				//
				// An address this library REUSED is only a preference. `ensureConnected` reconnects a
				// locked wallet by replaying the mechanism the connection already had, which keeps the
				// ordinary case (unlock, come back to the same account) from bouncing a multi-account user
				// into the account picker. But the user is free to unlock on a DIFFERENT account, and then
				// the replayed address names something the wallet no longer has. Treating that as a demand
				// threw, which landed in the catch and tore the wallet down: the reconnect performed the
				// very teardown it exists to prevent, one step later. Degrading to an ordinary connect is
				// what the caller asked for anyway, since it asked to be connected and named nothing.
				const resolveRequestedAddress = (available: `0x${string}`[]): `0x${string}` | undefined => {
					if (!specificAddress || available.includes(specificAddress)) {
						return specificAddress;
					}
					if (internal?.addressIsPreference) {
						return undefined;
					}
					throw new Error(`could not find address ${specificAddress}`);
				};
				const walletName =
					mechanism.name ||
					($connection.step === 'WalletChosen' ? $connection.mechanism.name : undefined) ||
					($connection.wallets.length == 1 ? $connection.wallets[0].info.name : undefined);
				if (walletName) {
					const wallet = $connection.wallets.find((v) => v.info.name == walletName || v.info.uuid == walletName);
					if (wallet) {
						if (_wallet) {
							alwaysOnProviderWrapper.setWalletProvider(undefined);
							stopWatchingForAccountChange(_wallet.provider);
							stopWatchingForChainIdChange(_wallet.provider);
						}

						const mechanismToSave: WalletMechanism<string, undefined> = {
							type: 'wallet',
							name: walletName,
						};

						set({
							step: 'WaitingForWalletConnection', // TODO FetchingAccounts
							mechanism: mechanismToSave,
							wallets: $connection.wallets,
							wallet: undefined,
						});
						try {
							const provider = wallet.walletProvider;
							const chainIdAsHex = await withTimeout(provider.getChainId());
							const chainId = Number(chainIdAsHex).toString();
							_wallet = {
								chainId,
								provider,
							};
							// TODO
							alwaysOnProviderWrapper.setWalletProvider(_wallet.provider.underlyingProvider);
							watchForChainIdChange(_wallet.provider);
							let accounts = await withTimeout(provider.getAccounts());
							accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
							if (accounts.length === 0) {
								set({
									step: 'WaitingForWalletConnection', // TODO add another step to unlock ?
									mechanism: mechanismToSave,
									wallets: $connection.wallets,
									wallet: undefined,
								});
								accounts = await provider.requestAccounts();
								accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
								if (accounts.length > 0) {
									const requestedAddress = resolveRequestedAddress(accounts);
									const nextStep =
										!settings?.useCurrentAccount && !requestedAddress && accounts.length > 1
											? 'ChooseWalletAccount'
											: 'WalletConnected';
									const account = requestedAddress || accounts[0];

									const newState: ConnectionInput<WalletProviderType> =
										nextStep === 'ChooseWalletAccount'
											? {
													step: nextStep,
													mechanism: mechanismToSave,
													wallets: $connection.wallets,

													wallet: {
														provider: _wallet.provider,
														accounts,
														status: 'connected',
														accountChanged: undefined,
														chainId,
														invalidChainId: alwaysOnChainId != chainId,
														switchingChain: false,
													},
												}
											: {
													step: nextStep,
													mechanism: {
														...mechanismToSave,
														address: account,
													},
													wallets: $connection.wallets,
													wallet: {
														provider: _wallet.provider,
														accounts,
														status: 'connected',
														accountChanged: undefined,
														chainId,
														invalidChainId: alwaysOnChainId != chainId,
														switchingChain: false,
													},
													account: {address: account},
												};
									if (
										newState.step === 'WalletConnected' &&
										(requestSignatureAutomaticallyIfPossible || options?.requestSignatureRightAway) &&
										!options?.requireUserConfirmationBeforeSignatureRequest
									) {
										watchForAccountChange(_wallet.provider);

										set(newState);
										alwaysOnProviderWrapper.setWalletStatus('connected');
										saveLastWallet(newState.mechanism);
										await requestSignature();
									} else {
										set(newState);
										alwaysOnProviderWrapper.setWalletStatus('connected');
										if (newState.step === 'WalletConnected') {
											saveLastWallet(newState.mechanism);
										}

										watchForAccountChange(_wallet.provider);
									}
								} else {
									// An empty accounts answer after a successful request is a failed
									// upgrade when coming from WalletChosen: keep the choice, exactly as
									// the catch block does for a REJECTED accounts request.
									if (
										!restoreWalletChosenAfterFailedConnect(
											'could not get any accounts',
											undefined,
											chosenMechanismBeforeConnect,
											chosenWalletBeforeConnect,
										)
									) {
										setConnectionFailure({message: 'could not get any accounts'});
									}
								}
							} else {
								const requestedAddress = resolveRequestedAddress(accounts);
								const account = requestedAddress || accounts[0];
								const nextStep =
									!settings?.useCurrentAccount && !requestedAddress && accounts.length > 1
										? 'ChooseWalletAccount'
										: 'WalletConnected';
								const newState: ConnectionInput<WalletProviderType> =
									nextStep === 'ChooseWalletAccount'
										? {
												step: nextStep,
												mechanism: mechanismToSave,
												wallets: $connection.wallets,
												wallet: {
													provider: _wallet.provider,
													accounts,
													status: 'connected',
													accountChanged: undefined,
													chainId,
													invalidChainId: alwaysOnChainId != chainId,
													switchingChain: false,
												},
											}
										: {
												step: nextStep,
												mechanism: {
													...mechanismToSave,
													address: account,
												},
												wallets: $connection.wallets,
												wallet: {
													provider: _wallet.provider,
													accounts,
													status: 'connected',
													accountChanged: undefined,
													chainId,
													invalidChainId: alwaysOnChainId != chainId,
													switchingChain: false,
												},
												account: {address: account},
											};
								if (
									newState.step === 'WalletConnected' &&
									(requestSignatureAutomaticallyIfPossible || options?.requestSignatureRightAway) &&
									!options?.requireUserConfirmationBeforeSignatureRequest
								) {
									set(newState);
									alwaysOnProviderWrapper.setWalletStatus('connected');
									saveLastWallet(newState.mechanism);
									watchForAccountChange(_wallet.provider);
									await requestSignature();
								} else {
									watchForAccountChange(_wallet.provider);
									set(newState);
									alwaysOnProviderWrapper.setWalletStatus('connected');
									if (newState.step === 'WalletConnected') {
										saveLastWallet(newState.mechanism);
									}
								}
							}
						} catch (err) {
							// Distinguish EIP-1193 error codes so the dapp can surface a meaningful
							// message instead of a generic "failed to connect".
							// 4100 (Unauthorized): the wallet cannot authorise accounts — it may be
							// read-only, locked, or not yet configured (e.g. werust's keyless
							// provider). 4001 (User Rejected Request): the user actively declined in
							// the wallet popup. Anything else is a genuine failure.
							const code = (err as {code?: unknown})?.code;
							let errorMessage = `failed to connect to wallet`;
							if (code === 4100) {
								errorMessage =
									'The wallet is not authorized to provide accounts. It may be read-only, locked, or not yet configured.';
							} else if (code === 4001) {
								errorMessage = 'Connection request was declined.';
							}
							// If the user was upgrading from WalletChosen (they had already picked a
							// wallet for reads and then tried to connect for accounts), a failed
							// connect must NOT throw away the choice: restore WalletChosen so reads
							// keep routing through the wallet (status: 'disconnected').
							// Otherwise setConnectionFailure lands the flow on its resting step; it
							// also tears the wallet down, because every failure state's `wallet` is
							// `undefined` — a failed attempt must not keep routing requests (including
							// read-only RPC calls like eth_call) through the failed wallet.
							if (
								!restoreWalletChosenAfterFailedConnect(
									errorMessage,
									err,
									chosenMechanismBeforeConnect,
									chosenWalletBeforeConnect,
								)
							) {
								setConnectionFailure({message: errorMessage, cause: err});
							}
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						setConnectionFailure({message: `failed to get wallet ${walletName}`});
					}
				} else {
					// TODO can also be done automatically before hand
					// set({
					// 	step: 'FetchingWallets',
					// 	mechanism: { type: 'wallet', wallet: undefined }
					// });

					// Reached from a state that HAS a wallet whenever nothing names one: a bare
					// `connect()` with several wallets announced, including on a locked wallet. That is
					// this function's contract, not an oversight — see the note on `mechanismToReconnect`
					// above for why `connect`, `ensureConnected` and `unlock` mean three different things
					// here, and why a consumer facing a locked wallet wants `unlock()`. The picker state
					// drops the wallet and `set` tears it down; whatever it is still holding stays
					// announced, on `pendingRequests`.
					set({
						step: 'WalletToChoose',
						mechanism: {type: 'wallet'},
						wallet: undefined,
						wallets: $connection.wallets,
					});
				}
			} else {
				// Popup-based auth requires walletHost
				if (!settings.walletHost) {
					throw new Error('walletHost is required for popup-based authentication (email, oauth, mnemonic)');
				}
				// Same-Origin Callback Bridge (domain-redirect fallback): only relevant
				// for the oauth-redirection flow, where the opener can be severed by COOP.
				let decryptKeyPair: CryptoKeyPair | undefined;
				let domainRedirectPublicKeyB64: string | undefined;
				const isOauthRedirection = mechanism.type === 'oauth' && !mechanism.usePopup;
				if (
					settings.domainRedirectBridge &&
					isOauthRedirection &&
					typeof window !== 'undefined' &&
					window.crypto?.subtle
				) {
					try {
						decryptKeyPair = await generateEcdhKeyPair();
						domainRedirectPublicKeyB64 = await exportPublicKeyB64(decryptKeyPair.publicKey);
					} catch (err) {
						console.error('failed to set up domain-redirect bridge', err);
						decryptKeyPair = undefined;
						domainRedirectPublicKeyB64 = undefined;
					}
				}
				popup = connectViaPopup({
					mechanism,
					walletHost: settings.walletHost,
					decryptKeyPair,
					domainRedirectPublicKeyB64,
				});
				// This attempt's popup, kept so the handlers below can tell "my popup finished" from "a
				// later launch replaced me". Launching a second popup rejects the first, and without this
				// the first attempt's failure handler would land on `Idle` on top of the second attempt.
				const launchedPopup = popup;
				// `PopupLaunched` carries no wallet, so `set` tears down the one a user who was already
				// wallet-connected had: it must stop being able to sign from the moment the popup opens,
				// not whenever the popup happens to finish.
				//
				// Under `prioritizeWalletProvider` that also stops READS routing through it for the
				// popup's duration; they fall back to the configured endpoint, which still answers. Same
				// trade `back()` and `cancel()` make, and the right way round: a read served by the
				// endpoint is correct, a signature served by a wallet the state does not show is the
				// hazard.
				set({
					step: 'PopupLaunched',
					popupClosed: false,
					mechanism,
					wallets: $connection.wallets,
					wallet: undefined,
				});

				const unsubscribe = popup.subscribe(($popup) => {
					if (popup === launchedPopup && $connection?.step === 'PopupLaunched') {
						if ($popup.closed) {
							set({
								...$connection,
								popupClosed: true,
							});
						}
					}
				});
				try {
					// Stripped HERE rather than only in `saveOriginAccount`, so that the account handed to the
					// app carries no seed either, whatever `remember` says. This is the one path where an
					// account arrives from code this package does not version: the wallet host is deployed
					// separately, so an app on a current build can be talking to an older popup.
					const result = withoutEntropyKey(await popup);
					// console.log({result});
					set({
						step: 'SignedIn',
						account: result,
						mechanism,
						wallets: $connection.wallets,
						wallet: undefined,
					});
					if (remember) {
						saveOriginAccount(result);
					}
				} catch (err) {
					console.error({error: err});
					// A REFUSAL IS NOT A CANCELLATION, and the app has to be able to tell them apart. Closing
					// the popup is a user action with nothing to report, so it goes back to Idle silently, as
					// it always has. Anything else is the wallet host refusing and saying why (a denied
					// required permission, a cross-origin request the signing origin never consented to), and
					// dropping that reason leaves the app unable to offer the remedy: `cross-origin-blocked`
					// means bring your own delegate and register it onchain, not retry the same popup.
					//
					// Resting on `Idle` rather than going through `setConnectionFailure`, which would land a
					// non-wallet-only connection on the mechanism picker. Where the popup comes to rest is
					// deliberately UNCHANGED by this: a picker is for a failure another choice could fix, and
					// picking a different sign-in method does not make a refused origin acceptable. Only the
					// reason is added, which is what `ensureConnected` reports instead of "Connection cancelled".
					const refusal = err as {type?: string; message?: string} | undefined;
					const canceled = !refusal || refusal.type === 'cancelation';
					// Only this attempt's failure, and only while this attempt still owns the flow.
					//
					// `cancel()` and `back(step)` settle this promise on purpose (that is what makes an
					// awaited `connect()` return at all), and they have ALREADY chosen where the flow comes
					// to rest. Landing on `Idle` here as well would overrule them, so `back('MechanismToChoose')`
					// during a popup would bounce the user to `Idle` a microtask later.
					if (popup !== launchedPopup || $connection.step !== 'PopupLaunched') {
						return;
					}
					set({
						step: 'Idle',
						loading: false,
						wallet: undefined,
						wallets: $connection.wallets,
						error: canceled ? undefined : {message: refusal.message || 'sign in failed', cause: refusal},
					});
				} finally {
					unsubscribe();
				}
			}
		} else {
			// The mechanism picker drops the wallet, and `set` tears the live one down with it.
			set({
				step: 'MechanismToChoose',
				wallets: $connection.wallets,
				wallet: undefined,
			});
		}
	}

	/**
	 * Resolve once the flow reaches `step`, initiating a connection attempt when needed.
	 *
	 * It never sits doing nothing: it either initiates an attempt, resolves, or rejects with
	 * a `ConnectionFailure` (whose `cause`/`code` carry the underlying wallet error, so a user
	 * rejection shows up as EIP-1193 code 4001).
	 *
	 * It initiates from `Idle`, and from a picker step (`MechanismToChoose`, `WalletToChoose`) that still
	 * carries the error of a previous failed attempt, which is what makes a retry after a rejected wallet
	 * prompt work. It deliberately does NOT initiate from a picker step without an error: that means the
	 * user is mid-choice with the picker on screen, and connecting there would hijack their choice. In that
	 * case it waits for the user to pick (or cancel). Pass `{forceConnect: true}` to connect anyway.
	 */
	// ensureConnected overloads - the default step depends on targetStep
	function ensureConnected(
		options?: EnsureConnectedOptions,
	): Promise<WalletChosen<WalletProviderType> | WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>>;
	function ensureConnected(
		step: 'WalletChosen',
		mechanismOrOptions?: WalletMechanism<string | undefined, `0x${string}` | undefined> | EnsureConnectedOptions,
		options?: EnsureConnectedOptions,
	): Promise<ChosenOrBetter<WalletProviderType>>;
	function ensureConnected(
		step: 'WalletConnected',
		mechanismOrOptions?: WalletMechanism<string | undefined, `0x${string}` | undefined> | EnsureConnectedOptions,
		options?: EnsureConnectedOptions,
	): Promise<WalletConnected<WalletProviderType>>;
	function ensureConnected(
		step: 'SignedIn',
		mechanism?: Mechanism,
		options?: EnsureConnectedOptions,
	): Promise<SignedIn<WalletProviderType>>;
	async function ensureConnected<Step extends 'WalletChosen' | 'WalletConnected' | 'SignedIn'>(
		stepOrMechanismOrOptions?: Step | Mechanism | EnsureConnectedOptions,
		mechanismOrOptions?: Mechanism | EnsureConnectedOptions,
		options?: EnsureConnectedOptions,
	): Promise<WalletChosen<WalletProviderType> | WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>> {
		// Determine if first arg is a step string, mechanism, or options
		let step: 'WalletChosen' | 'WalletConnected' | 'SignedIn';
		let mechanism: Mechanism | undefined;
		let opts: EnsureConnectedOptions | undefined;

		if (typeof stepOrMechanismOrOptions === 'string') {
			// First arg is a step
			step = stepOrMechanismOrOptions as 'WalletChosen' | 'WalletConnected' | 'SignedIn';
			// Check if second arg is a mechanism (has 'type') or options (doesn't have 'type')
			if (mechanismOrOptions && 'type' in (mechanismOrOptions as any)) {
				mechanism = mechanismOrOptions as Mechanism;
				opts = options;
			} else {
				mechanism = undefined;
				opts = mechanismOrOptions as EnsureConnectedOptions | undefined;
			}
		} else if (stepOrMechanismOrOptions && 'type' in (stepOrMechanismOrOptions as any)) {
			// First arg is a mechanism
			step = targetStep; // Use configured target as default
			mechanism = stepOrMechanismOrOptions as Mechanism;
			opts = mechanismOrOptions as EnsureConnectedOptions | undefined;
		} else {
			// First arg is options or undefined
			step = targetStep; // Use configured target as default
			mechanism = undefined;
			opts = stepOrMechanismOrOptions as EnsureConnectedOptions | undefined;
		}

		// For WalletConnected or WalletChosen step, default to wallet mechanism
		if (!mechanism && (step === 'WalletConnected' || step === 'WalletChosen')) {
			mechanism = {type: 'wallet'};
		}

		const promise = new Promise<
			WalletChosen<WalletProviderType> | WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>
		>((resolve, reject) => {
			let forceConnect = false;
			// Whether the mechanism below was REPLAYED from the current state rather than asked for.
			let reconnecting = false;

			// The error (if any) already sitting in the store before we start.
			// Only an error that appears after this point tells us that *our* attempt failed.
			const errorOnEntry = $connection.error;

			// Helper to check if resolution conditions are met
			const canResolve = (connection: Connection<WalletProviderType>): boolean => {
				if (step === 'WalletChosen') {
					// For WalletChosen, accept WalletChosen OR any higher step
					return (
						connection.step === 'WalletChosen' ||
						connection.step === 'WalletConnected' ||
						(connection.step === 'SignedIn' && connection.wallet !== undefined)
					);
				}
				// Must be at the target step
				if (connection.step !== step) return false;

				// For WalletConnected step, check chain validity unless skipped
				if (step === 'WalletConnected' && !opts?.skipChainCheck) {
					// connection.wallet should exist when step is WalletConnected
					if (connection.wallet?.invalidChainId) {
						return false; // Wrong chain, wait for chain change
					}
				}

				return true;
			};

			const reconnect = mechanismToReconnect();
			if (reconnect) {
				// we reuse existing mechanism as we just want to reconnect
				forceConnect = true;
				mechanism = reconnect;
				// ...but its ADDRESS is only a preference, because the user may unlock on another
				// account, and a replayed address is not something the caller asked for.
				reconnecting = true;
			} else if (canResolve($connection)) {
				// Only resolve if step matches AND chain is valid (or skipChainCheck)
				resolve($connection as any);
				return;
			}
			let idlePassed = $connection.step != 'Idle';

			// Initiating from a picker step is only safe when we can tell it apart from "the user is choosing
			// right now": a picker still carrying the error of a previous attempt means that attempt failed and
			// nothing has driven the flow since, so re-initiating is exactly what the caller asked for. It cannot
			// hijack a choice either: when a choice is genuinely needed, `connect` with a default mechanism just
			// re-enters the same picker (and clears the stale error), and we keep waiting for the user.
			const retryingAfterFailure = idlePassed && stepsAtRest.includes($connection.step) && !!errorOnEntry;
			if (!idlePassed || forceConnect || opts?.forceConnect || retryingAfterFailure) {
				if (step === 'WalletChosen') {
					const walletName =
						mechanism && typeof mechanism === 'object' && 'name' in mechanism
							? (mechanism as {name?: string}).name
							: undefined;
					selectWallet(walletName, opts);
				} else {
					connect(mechanism, opts, {addressIsPreference: reconnecting});
				}
			}

			// An attempt is considered started once we observe a step where the connection is in progress.
			// Falling back to a resting step from there means the attempt ended without reaching the target.
			let attemptStarted = false;
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const settle = (perform: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				// unsubscribe can still be undefined here if the store settles during the initial (synchronous) subscription
				unsubscribe?.();
				perform();
			};

			unsubscribe = _store.subscribe((connection) => {
				if (settled) {
					return;
				}
				if (!idlePassed && connection.step !== 'Idle') {
					idlePassed = true;
				}
				// Check full resolution conditions including chain validity
				if (canResolve(connection)) {
					settle(() => resolve(connection as any));
					return;
				}

				if (stepsInProgress.includes(connection.step)) {
					// still going, nothing to decide yet
					attemptStarted = true;
					return;
				}

				// A fresh error means the attempt failed (rejected wallet prompt, no accounts, unusable wallet, ...).
				// The failure handlers set it at the very moment they fall back to a resting step, which can be `Idle`,
				// so this is checked before the cancellation case below to report the actual cause rather than
				// a generic cancellation.
				const error = connection.error;
				if (error && error !== errorOnEntry) {
					settle(() => reject(new ConnectionFailure(error.message, error.cause)));
					return;
				}

				// Reject on disconnect/back to Idle
				if (connection.step === 'Idle' && idlePassed) {
					settle(() => reject(new ConnectionFailure('Connection cancelled')));
					return;
				}

				// The attempt went back to a resting step without an error: it was aborted (back/cancel).
				// This must never trigger on a resting step we merely started from, hence `attemptStarted`.
				if (attemptStarted && stepsAtRest.includes(connection.step)) {
					settle(() => reject(new ConnectionFailure('Connection cancelled')));
				}
			});
			if (settled) {
				unsubscribe();
			}
		});

		return promise;
	}

	function disconnect() {
		deleteOriginAccount();
		deleteLastWallet();
		// The wallet goes with the Idle state below, via `set`.
		// Request announcements are NOT torn down here. Disconnecting drops this app's wallet state;
		// it does not reach into the user's wallet and withdraw a prompt already on their screen, and
		// nothing re-subscribes, so unsubscribing here left the connection permanently unable to
		// report any wallet request for the rest of its life.
		set({
			step: 'Idle',
			loading: false,
			wallet: undefined,
			wallets: $connection.wallets,
		});
	}

	// Pick a wallet via EIP-6963 and set it as the read provider WITHOUT going through the
	// connect/accounts flow. The wallet's provider is set on the always-on wrapper so reads route
	// through it (when `prioritizeWalletProvider` is true), but no accounts are requested and
	// signing is refused (status: 'disconnected').
	//
	// This is the entry point for the `targetStep: 'WalletChosen'` flow: a blockchain indexer (or
	// any read-only consumer) can let the user pick their wallet as a decentralised read node
	// without the friction of eth_requestAccounts.
	//
	// If `name` is omitted and only one wallet is detected, auto-selects it; if multiple wallets
	// are detected, transitions to `WalletToChoose` for the user to pick.
	async function selectWallet(name?: string, options?: {doNotStoreLocally?: boolean}) {
		const walletName = name || ($connection.wallets.length == 1 ? $connection.wallets[0].info.name : undefined);
		if (!walletName) {
			// Multiple wallets, no name specified - show picker. The picker state drops the wallet, so
			// `set` tears down a previously chosen one rather than leaving it routing.
			set({
				step: 'WalletToChoose',
				mechanism: {type: 'wallet'},
				wallets: $connection.wallets,
				wallet: undefined,
			});
			return;
		}
		const wallet = $connection.wallets.find((v) => v.info.name == walletName || v.info.uuid == walletName);
		if (!wallet) {
			// A name lookup miss attempts nothing: keep the current choice (and the read path
			// through it) and report the error on the CURRENT state — throwing the choice away
			// over a typo or a wallet uninstalled between render and click would deselect the
			// user's read path without them refusing anything.
			setError({message: `failed to get wallet ${walletName}`});
			return;
		}
		// Clear old wallet watchers if switching from a previously chosen/connected wallet.
		// The provider is deliberately left on the wrapper until the new one replaces it
		// (below or, on failure, via setConnectionFailure's teardown), so reads do not flap
		// to the configured endpoint during the switch.
		if (_wallet) {
			stopWatchingForAccountChange(_wallet.provider);
			stopWatchingForChainIdChange(_wallet.provider);
		}
		try {
			const provider = wallet.walletProvider;
			const chainIdAsHex = await withTimeout(provider.getChainId());
			const chainId = Number(chainIdAsHex).toString();
			_wallet = {chainId, provider};
			alwaysOnProviderWrapper.setWalletProvider(provider.underlyingProvider);
			alwaysOnProviderWrapper.setWalletStatus('disconnected');
			watchForChainIdChange(provider);
			// Persist the choice so it survives reloads. The address is undefined because we
			// have not requested accounts; getLastWallet restores it as a chosen-but-unconnected
			// wallet (the WalletChosen auto-connect path).
			if (!options?.doNotStoreLocally) {
				saveLastWallet({type: 'wallet', name: walletName});
			}
			set({
				step: 'WalletChosen',
				mechanism: {type: 'wallet', name: walletName},
				wallets: $connection.wallets,
				wallet: {
					provider: provider,
					accounts: [],
					status: 'disconnected',
					connecting: false,
					accountChanged: undefined,
					chainId,
					invalidChainId: alwaysOnChainId != chainId,
					switchingChain: false,
				},
			});
		} catch (err) {
			// setConnectionFailure tears down the previously chosen wallet (provider still on
			// the wrapper if the new wallet's getChainId threw before setWalletProvider) before
			// landing on its `wallet: undefined` resting step.
			setConnectionFailure({message: `failed to select wallet ${walletName}`, cause: err});
		}
	}

	function back(step: 'MechanismToChoose' | 'Idle' | 'WalletToChoose') {
		popup?.cancel();
		// Every back() target drops the wallet from the state, and `set` takes the live one with it.
		if (step === 'MechanismToChoose') {
			set({step, wallets: $connection.wallets, wallet: undefined});
		} else if (step === 'Idle') {
			set({step, loading: false, wallet: undefined, wallets: $connection.wallets});
		} else if (step === 'WalletToChoose') {
			set({step, wallet: undefined, wallets: $connection.wallets, mechanism: {type: 'wallet'}});
		}
	}

	const popupLauncher = createPopupLauncher<OriginAccount>();

	function connectViaPopup(popupSettings: PopupSettings) {
		let popupURL = new URL(`${popupSettings.walletHost}/login/`);
		let fullWindow = false;

		// Same-Origin Callback Bridge (domain-redirect fallback): the parent's public
		// key is carried through the redirect chain as a query param so it survives
		// the full-page OAuth round-trip.
		if (popupSettings.domainRedirectPublicKeyB64) {
			popupURL.searchParams.append('domain-redirect-public-key', popupSettings.domainRedirectPublicKeyB64);
		}

		// WHICH HOSTED PROVIDER THE HOST SHOULD USE FOR EMAIL AND OAUTH.
		//
		// That is all this parameter means. It is chosen ONCE, here, at the app's build time, and
		// appended to every popup URL for every mechanism, so it cannot express a per-mechanism choice
		// and must not be asked to: the host routes by MECHANISM, and derives a mnemonic sign-in
		// locally without consulting this at all.
		//
		// Deliberately not made per-mechanism here. Which mechanisms a host answers itself is host
		// implementation knowledge, and putting it in this library would oblige every third-party
		// client to reproduce it and then drift from it.
		const hostedAuthProvider = (import.meta as any).env?.VITE_AUTH_PROVIDER || 'openfort';
		popupURL.searchParams.append('provider', hostedAuthProvider);

		if (popupSettings.mechanism.type === 'mnemonic') {
			popupURL.searchParams.append('type', 'mnemonic');
		} else if (popupSettings.mechanism.type === 'email') {
			popupURL.searchParams.append('type', 'email');
			if (popupSettings.mechanism.email) {
				popupURL.searchParams.append('email', encodeURIComponent(popupSettings.mechanism.email));
			}
			if (popupSettings.mechanism.mode) {
				popupURL.searchParams.append('emailMode', popupSettings.mechanism.mode);
			}
		} else if (popupSettings.mechanism.type === 'oauth') {
			popupURL.searchParams.append('type', 'oauth');

			if ('connection' in popupSettings.mechanism.provider) {
				popupURL.searchParams.append('oauth-provider', popupSettings.mechanism.provider.id);
				popupURL.searchParams.append('oauth-connection', popupSettings.mechanism.provider.connection);
			} else {
				popupURL.searchParams.append('oauth-provider', popupSettings.mechanism.provider.id);
			}

			if (!popupSettings.mechanism.usePopup) {
				popupURL.searchParams.append('oauth-redirection', 'true');
			}
		} else {
			throw new Error(`mechanism ${(popupSettings.mechanism as any).type} not supported`);
		}

		popupURL.searchParams.append('account-type', walletConnector.accountGenerator.type);

		// if (popupSettings.extraParams) {
		// 	for (const [key, value] of Object.entries(popupSettings.extraParams)) {
		// 		popupURL.searchParams.append(`${key}`, value);
		// 	}
		// }

		const currentURL = new URL(location.href);

		const entriesToAdd: [string, string][] = [];
		currentURL.searchParams.forEach((value, key) => {
			if (key.startsWith('renraku_')) {
				entriesToAdd.push([key.slice(`renraku_`.length), value]);
			}
		});

		if (currentURL.searchParams.has('eruda')) {
			entriesToAdd.push(['eruda', currentURL.searchParams.get('eruda') || '']);
		}
		if (currentURL.searchParams.has('debug')) {
			entriesToAdd.push(['debug', currentURL.searchParams.get('debug') || '']);
		}
		if (currentURL.searchParams.has('log')) {
			entriesToAdd.push(['log', currentURL.searchParams.get('log') || '']);
		}
		// Testing aid for the domain-redirect bridge: forces the BroadcastChannel
		// delivery path on the bridge page (skips window.opener.postMessage).
		if (currentURL.searchParams.has('forceBroadcastChannel')) {
			entriesToAdd.push(['forceBroadcastChannel', currentURL.searchParams.get('forceBroadcastChannel') || '']);
		}

		if (settings.signingOrigin) {
			entriesToAdd.push(['signingOrigin', settings.signingOrigin]);
		}

		// What the app is asking for, carried to the host as JSON. It is a REQUEST and nothing more:
		// the host decides each entry, and enforces its decision by withholding what it did not grant,
		// so nothing here is trusted beyond "these are the things to ask about".
		if (settings.permissions && settings.permissions.length > 0) {
			entriesToAdd.push(['permissions', JSON.stringify(settings.permissions)]);
		}

		for (const entryToAdd of entriesToAdd) {
			popupURL.searchParams.append(entryToAdd[0], entryToAdd[1]);
		}
		return popupLauncher.launchPopup(popupURL.toString(), {
			fullWindow,
			decryptKeyPair: popupSettings.decryptKeyPair,
		});
	}

	function cancel() {
		popup?.cancel();
		deleteLastWallet();
		// Landing on Idle drops the wallet from the state, and `set` tears it down with it.
		set({step: 'Idle', wallet: undefined, loading: false, wallets: $connection.wallets});
	}

	// The answer a live-signing owner gives to a connect-time declaration.
	//
	// Parsed through the same function the host uses, so an unknown permission type normalises
	// identically on both paths rather than arriving at the app in two different shapes.
	function declaredPermissionsUnavailable(): PermissionOutcome[] | undefined {
		if (!settings.permissions || settings.permissions.length === 0) {
			return undefined;
		}
		return parsePermissionRequests(settings.permissions).map((request) => ({
			request,
			granted: false as const,
			reason: 'sign-on-demand' as const,
		}));
	}

	/**
	 * The credential authorizing this session's signer to act for the account at one contract.
	 *
	 * TWO SOURCES, ONE SHAPE. A hosted account minted its credentials at sign-in, because that is
	 * the only moment its key is reachable, so this returns the stored record. A wallet owner is
	 * right here, so this asks it to sign now, which is the better moment: consent at the point of
	 * use beats consent at the door, and nothing is minted for a contract the app never touches.
	 *
	 * Returns the whole record rather than the signature alone, deliberately. A signature is not
	 * usable without the exact `delegate` and `deadline` it was made over, since those are inside
	 * the bytes; handing back all three keeps the caller from having to remember what it asked for,
	 * and makes this interchangeable with `findSavedDelegation`.
	 *
	 * @param target the contract and chain to authorize at, and how long the signature may be
	 *        presented for (unix seconds; 0, the default, means no expiry)
	 */
	async function getDelegation(target: {
		chainId: number;
		contract: `0x${string}`;
		deadline?: number;
	}): Promise<SavedDelegation> {
		if ($connection.step !== 'SignedIn') {
			throw new Error('Not signed in');
		}
		const account = $connection.account;
		const deadline = target.deadline ?? 0;
		const contract = target.contract.toLowerCase() as `0x${string}`;

		if ($connection.mechanism.type === 'wallet') {
			if (!_wallet) {
				throw new Error(`no provider`);
			}
			const message = delegationMessage({
				delegate: account.signer.address,
				contract,
				chainId: target.chainId,
				deadline,
			});
			// Through the wrapper, NOT `_wallet.provider`, so the request is announced: see
			// `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`. This one has no step
			// of its own, so `pendingRequests` is the only thing standing between the user and an
			// unexplained wallet popup asking them to hand a browser key authority over their account.
			//
			// The `_wallet` check above therefore guards a DIFFERENT object than the one that signs: the
			// wrapper signs with whatever `setWalletProvider` last registered on it. The two are kept in
			// lockstep (every site that assigns `_wallet` registers it, and the only window where they
			// disagree is inside `connect()`, which `step !== 'SignedIn'` already excludes), so the check
			// is still the right one to make. Said out loud because it is exactly the kind of unstated
			// assumption the ADR exists to stop being inherited: if wallet registration ever stops being
			// unconditional, this needs to ask the wrapper instead.
			const signature = await alwaysOnProviderWrapper.signMessage(message, account.address, {
				purpose: 'delegation',
			});
			return {chainId: target.chainId, contract, delegate: account.signer.address, deadline, signature};
		}

		const saved = findSavedDelegation(account.savedDelegations, {chainId: target.chainId, contract});
		// The deadline is INSIDE the signature, so a stored credential only answers a request that
		// names the same one. Returning it for a different deadline would hand back bytes that
		// cannot verify, which fails onchain instead of here.
		if (saved && (target.deadline === undefined || saved.deadline === deadline)) {
			return saved;
		}

		// A hosted account cannot sign after sign-in, so the remedy is to sign in again rather than
		// anything the app can do from here. See the permission outcomes on the account for whether
		// this was declined, not understood, or never asked for.
		throw new Error(
			`no delegation credential for contract ${contract} on chain ${target.chainId}; sign in again to request one`,
		);
	}

	// `async` is load-bearing, not decoration: without it the `throw`s below leave this function
	// SYNCHRONOUSLY while its signature promises a rejection, so
	// `getSignatureForPublicKeyPublication().catch(showTheReason)` never runs its handler and the
	// app gets an uncaught exception instead of the reason. `getDelegation` beside it is async and
	// rejects, and two siblings on the same object failing in two different ways is a difference
	// nothing in either signature would warn a caller about.
	async function getSignatureForPublicKeyPublication(): Promise<`0x${string}`> {
		if ($connection.step !== 'SignedIn') {
			throw new Error('Not signed in');
		}
		const account = $connection.account;
		if ($connection.mechanism.type === 'wallet') {
			if (!_wallet) {
				throw new Error(`no provider`);
			}
			const message = originPublicKeyPublicationMessage(originToSignWith(), account.signer.publicKey);
			// Announced, for the same reason as `getDelegation` above.
			return alwaysOnProviderWrapper.signMessage(message, account.address, {
				purpose: 'public-key-publication',
			});
		}

		if (account.savedPublicKeyPublicationSignature) {
			return Promise.resolve(account.savedPublicKeyPublicationSignature);
		}

		// TODO offer a way to use iframe + popup to sign the message
		// this would require saving mnemonic or privatekey on etherplay localstorage though
		throw new Error(`no saved public key publication signature for ${account.address}`);
	}

	async function unlock() {
		const wallet = $connection.wallet;
		if (!wallet || wallet.status !== 'locked') {
			throw new Error(`invalid state`);
		}

		set({
			...$connection,
			wallet: {
				...wallet,
				unlocking: true,
			},
		});

		try {
			await wallet.provider.requestAccounts().then(onAccountChanged);
		} catch {
			set({
				...$connection,
				wallet: {
					...wallet,
					unlocking: false,
				},
			});
		}
	}

	/**
	 * Ask the user's wallet to move to a chain, adding it first if the wallet has never seen it.
	 *
	 * TWO PROMPTS, not one, and which of them is up is published as `wallet.switchingChain`
	 * (`'switchingChain'` then `'addingChain'`). That distinction is not cosmetic: "add this
	 * network" is a different question from "switch network", and a consumer wording them the same
	 * way asks the user to approve something other than what the wallet is showing.
	 *
	 * That state is also the whole justification for these two calls bypassing the always-on
	 * wrapper, which is where every other request the user answers is announced. See
	 * `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: "each already publishes
	 * a dedicated state the consumer renders... if any of those states is removed, that call moves
	 * onto the wrapper." So collapsing these two values into a boolean, or dropping them, is not a
	 * simplification: it is a decision to route these through the wrapper instead.
	 */
	async function switchWalletChain(chainInfo?: BasicChainInfo) {
		if (!$connection.wallet) {
			throw new Error(`invalid state: no wallet to ask`);
		}

		const wallet = $connection.wallet;
		const chainInfoToUse = chainInfo || settings.chainInfo;
		const params = viemChainInfoToSwitchChainInfo(chainInfoToUse);
		const chainId = '' + chainInfoToUse.id;
		const chainIdAsHex = params.chainId;
		/** How to name this chain to the user, whether or not the app gave it a name. */
		const named = params?.chainName || `chain with id = ${chainId}`;

		// A wallet prompt is up, and WHICH one. Guarded because the user is free to disconnect while
		// they look at it, and a state with no wallet has nothing to say about a switch.
		const nowAsking = (prompt: 'switchingChain' | 'addingChain') => {
			if ($connection.wallet) {
				set({...$connection, wallet: {...$connection.wallet, switchingChain: prompt}});
			}
		};

		// THE SINGLE EXIT. Every path out of this function comes through here, which is what makes
		// the rule legible rather than remembered: an error is set by whoever GIVES UP, and by
		// nobody on the way past. Setting one before a recovery that then worked is exactly the bug
		// this shape prevents, and it shipped: the user landed on the requested chain with a banner
		// saying it had failed.
		//
		// `error` is omitted rather than set to `undefined` when there is none, so a successful
		// switch does not silently clear an unrelated error the app has not shown yet.
		const doneAsking = (error?: {message: string; cause?: unknown}) => {
			if ($connection.wallet) {
				set({
					...$connection,
					wallet: {...$connection.wallet, switchingChain: false},
					...(error ? {error} : {}),
				});
			}
		};

		/** 4001 is the user saying no. A refusal is not a failure and has nothing to report. */
		const isRefusal = (err: unknown) => (err as {code?: unknown} | undefined)?.code === 4001;

		try {
			nowAsking('switchingChain');
			// These methods report success as `null`, so a non-null RESULT is an error reported
			// without throwing. Turning it into a throw here is what puts both shapes on one road,
			// including the road to the recovery below.
			const result = await wallet.provider.switchChain(chainIdAsHex);
			if (result) {
				throw result;
			}
			// The chain itself is not recorded here: the wallet announces `chainChanged`, and that is
			// what moves the connection, exactly as when the user switches chain in the wallet.
			doneAsking();
			return;
		} catch (err) {
			if (isRefusal(err)) {
				doneAsking();
				return;
			}
			if (!params?.rpcUrls || params.rpcUrls.length === 0) {
				// Nothing left to try: the wallet cannot switch to this chain, and there is no rpcUrl to
				// add it with. `cause` keeps what the wallet actually said, since the message below is
				// this library's summary and the branch is reached both from a refusal to switch and
				// from a wallet reporting its error as a result.
				const message = `Chain "${named}" is not available on your wallet`;
				doneAsking({message, cause: err});
				throw new Error(message);
			}
		}

		// The wallet does not know this chain. Asking it to ADD one is a second prompt, with the
		// details the wallet needs to describe the chain to the user.
		nowAsking('addingChain');
		try {
			const result = await wallet.provider.addChain({
				chainId: chainIdAsHex,
				rpcUrls: params.rpcUrls,
				chainName: params.chainName,
				blockExplorerUrls: params.blockExplorerUrls,
				iconUrls: params.iconUrls,
				nativeCurrency: params.nativeCurrency,
			});
			if (result) {
				throw result;
			}
			doneAsking();
		} catch (err) {
			if (isRefusal(err)) {
				doneAsking();
				return;
			}
			const message = `Failed to add new chain: ${named}`;
			doneAsking({message, cause: err});
			throw err;
		}
	}

	// Method on the store to check if target step is reached
	function storeIsTargetStepReached(connection: Connection<WalletProviderType>): boolean {
		if (targetStep === 'WalletChosen') {
			// For WalletChosen target, accept WalletChosen OR any higher step
			return (
				connection.step === 'WalletChosen' ||
				connection.step === 'WalletConnected' ||
				(connection.step === 'SignedIn' && connection.wallet !== undefined)
			);
		}
		if (targetStep === 'WalletConnected') {
			// For WalletConnected target, accept WalletConnected OR SignedIn-with-wallet
			return (
				connection.step === 'WalletConnected' || (connection.step === 'SignedIn' && connection.wallet !== undefined)
			);
		}
		// For SignedIn target
		if (walletOnly) {
			// With walletOnly, only accept SignedIn-with-wallet
			return connection.step === 'SignedIn' && connection.wallet !== undefined;
		}
		// Accept any SignedIn variant
		return connection.step === 'SignedIn';
	}

	const store = {
		subscribe: _store.subscribe,
		connect,
		cancel,
		back,
		clearError,
		requestSignature,
		connectToAddress,
		disconnect,
		selectWallet,
		getSignatureForPublicKeyPublication,
		getDelegation,
		switchWalletChain,
		unlock,
		ensureConnected: ensureConnected as any, // Cast to bypass complex conditional typing
		isTargetStepReached: storeIsTargetStepReached as any, // Cast for type guard
		targetStep,
		walletOnly,
		provider: alwaysOnProviderWrapper.provider,
		chainId: '' + settings.chainInfo.id,
		chainInfo: settings.chainInfo,
		onRequest: (handler: RequestEventHandler) => alwaysOnProviderWrapper.onRequest(handler),
	};

	return store as ConnectionStore<WalletProviderType, TargetStep, boolean>;
}
