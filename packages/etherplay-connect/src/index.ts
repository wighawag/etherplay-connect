import type {
	WalletConnector,
	WalletHandle,
	WalletProvider,
	PendingRequest,
	RequestEventHandler,
} from '@etherplay/wallet-connector';
import {EthereumWalletConnector, type UnderlyingEthereumProvider} from '@etherplay/wallet-connector-ethereum';
import {writable} from 'svelte/store';
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

export type TargetStep = 'WalletConnected' | 'SignedIn';

export type WalletState<WalletProviderType> = {
	provider: WalletProvider<WalletProviderType>;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`;
	chainId: string;
	invalidChainId: boolean;
	switchingChain: 'addingChain' | 'switchingChain' | false;
	pendingRequests: PendingRequest[];
} & ({status: 'connected'} | {status: 'locked'; unlocking: boolean} | {status: 'disconnected'; connecting: boolean});

type WaitingForSignature<WalletProviderType> = {
	step: 'WaitingForSignature';
	mechanism: WalletMechanism<string, `0x${string}`>;
	wallet: WalletState<WalletProviderType>;
	account: {address: `0x${string}`};
};

type WalletConnected<WalletProviderType> = {
	step: 'WalletConnected';
	mechanism: WalletMechanism<string, `0x${string}`>;
	wallet: WalletState<WalletProviderType>;
	account: {address: `0x${string}`};
};

type SignedIn<WalletProviderType> =
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
			wallet: WalletState<WalletProviderType>;
	  };

export type Connection<WalletProviderType> = {
	// The connection can have an error in every state.
	// a banner or other mechanism to show error should be used.
	// error should be dismissable
	error?: {message: string; cause?: any};
	// wallets represent the web3 wallet installed on the user browser
	wallets: WalletHandle<WalletProviderType>[];
} & ( // loading can be true initially as the system will try to auto-login and fetch installed web3 wallet // Start in Idle
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
	// Once the wallet is connected, if multiple account are connected to the site
	// the user can choose which one to connect to
	| {
			step: 'ChooseWalletAccount';
			mechanism: WalletMechanism<string, undefined>;
			wallet: WalletState<WalletProviderType>;
	  }
	// Once the wallet is connected, the system will need a signature
	// this state represent the fact and require another user interaction to request the signature
	| WalletConnected<WalletProviderType>
	// This state is triggered once the signature is requested, the user will have to confirm with its wallet
	| WaitingForSignature<WalletProviderType>
	// Finally the user is fully signed in
	// wallet?.accountChanged if set, represent the fact that the user has changed its web3-wallet accounnt.
	// wallet?.invalidChainId if set, represent the fact that the wallet is connected to a different chain.
	// wallet?.switchingChain if set, represent the fact that the user is currently switching chain.
	// a notification could be shown to the user so that he can switch the app to use that other account.
	| SignedIn<WalletProviderType>
);

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

// Type representing wallet-connected states (both WalletConnected and SignedIn-via-wallet)
// This is what you get when targetStep is 'WalletConnected' and target is reached
// Both variants have WalletMechanism and wallet
export type ConnectedWithWallet<WalletProviderType> =
	| WalletConnectedState<WalletProviderType>
	| SignedInWithWallet<WalletProviderType>;

// Full SignedIn type from Connection (includes both popup-based and wallet-based variants)
export type SignedInState<WalletProviderType> = Extract<Connection<WalletProviderType>, {step: 'SignedIn'}>;

// Type guard - narrows Connection based on targetStep and walletOnly
// For 'WalletConnected' target: narrows to ConnectedWithWallet (WalletConnected | SignedIn-with-wallet)
// For 'SignedIn' target with walletOnly: narrows to SignedInWithWallet
// For 'SignedIn' target (default): narrows to SignedIn
export function isTargetStepReached<WalletProviderType, Target extends TargetStep, WalletOnly extends boolean = false>(
	connection: Connection<WalletProviderType>,
	targetStep: Target,
	walletOnly?: WalletOnly,
): connection is Target extends 'WalletConnected'
	? ConnectedWithWallet<WalletProviderType>
	: WalletOnly extends true
		? SignedInWithWallet<WalletProviderType>
		: SignedInState<WalletProviderType> {
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
const stepsAtRest: readonly string[] = ['Idle', 'MechanismToChoose', 'WalletToChoose'];

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
	getSignatureForPublicKeyPublication: () => Promise<`0x${string}`>;
	getDelegation: (target: {chainId: number; contract: `0x${string}`; deadline?: number}) => Promise<SavedDelegation>;
	switchWalletChain: (chainInfo?: BasicChainInfo) => Promise<void>;
	unlock: () => Promise<void>;

	// ensureConnected signature depends on target and walletOnly
	ensureConnected: Target extends 'WalletConnected'
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
	) => connection is Target extends 'WalletConnected'
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
// `ConnectionStore` ignores `WalletOnly` once `Target` is `'WalletConnected'`.
export type AnyConnectionStore<WalletProviderType> =
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
// Both `WalletConnected` overloads report `WalletOnly = true`, because that is what the runtime
// computes: `walletOnly = settings.walletOnly || targetStep === 'WalletConnected'`, so a
// `WalletConnected` store always exposes `walletOnly === true`.

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

	// Subscribe to request events from the provider to update pendingRequests
	const unsubscribeRequestEvents = alwaysOnProviderWrapper.onRequest(() => {
		// Only update if we have a wallet connected
		if ($connection.wallet) {
			const currentPending = alwaysOnProviderWrapper.getPendingRequests();
			set({
				...$connection,
				wallet: {
					...$connection.wallet,
					pendingRequests: currentPending,
				},
			});
		}
	});

	// Determine target step (defaults to 'SignedIn')
	const targetStep: TargetStep = settings.targetStep || 'SignedIn';

	// Determine walletOnly (defaults to false, but true implies WalletConnected target behavior for mechanism)
	const walletOnly = settings.walletOnly || targetStep === 'WalletConnected';

	let autoConnect = true;
	if (typeof settings.autoConnect !== 'undefined') {
		autoConnect = settings.autoConnect;
	}

	// For SignedIn target, we can auto-request signature if configured
	// For WalletConnected target, this is always false (we never auto-request signature)
	const requestSignatureAutomaticallyIfPossible =
		targetStep === 'SignedIn' ? settings.requestSignatureAutomaticallyIfPossible || false : false;

	let $connection: Connection<WalletProviderType> = {step: 'Idle', loading: true, wallet: undefined, wallets: []};
	const _store = writable<Connection<WalletProviderType>>($connection);
	function set(connection: Connection<WalletProviderType>) {
		$connection = connection;
		_store.set($connection);
		return $connection;
	}
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
											pendingRequests: [],
										},
									});
									alwaysOnProviderWrapper.setWalletStatus('connected');
									onAccountChanged(accounts);
									watchForAccountChange(walletProvider);
								})
								.catch((err) => {
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

				// For both targets, fallback to lastWallet if no account found (or WalletConnected target)
				if (!autoConnectHandled) {
					const lastWallet = getLastWallet();
					if (lastWallet) {
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
										pendingRequests: [],
									},
									account: {address: lastWallet.address},
								});
								alwaysOnProviderWrapper.setWalletStatus('connected');
								onAccountChanged(accounts);
								watchForAccountChange(walletProvider);
							})
							.catch((err) => {
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

	function getOriginAccount(): OriginAccount | undefined {
		const fromStorage = localStorage.getItem(storageKeyAccount);
		if (fromStorage) {
			return JSON.parse(fromStorage) as OriginAccount;
		}
	}
	function saveOriginAccount(account: OriginAccount) {
		const accountSTR = JSON.stringify(account);
		sessionStorage.setItem(storageKeyAccount, accountSTR);
		localStorage.setItem(storageKeyAccount, accountSTR);
	}
	function deleteOriginAccount() {
		sessionStorage.removeItem(storageKeyAccount);
		localStorage.removeItem(storageKeyAccount);
	}

	function getLastWallet(): WalletMechanism<string, `0x${string}`> | undefined {
		const fromStorage = localStorage.getItem(storageKeyLastWallet);
		if (fromStorage) {
			return JSON.parse(fromStorage) as WalletMechanism<string, `0x${string}`>;
		}
	}
	function saveLastWallet(wallet: WalletMechanism<string, `0x${string}`>) {
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
				privateKey: originAccount.privateKey,
				mnemonicKey: originKey,
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

	let remember: boolean = false;
	async function connect(mechanism?: Mechanism, options?: ConnectOptions) {
		if (!mechanism && (targetStep === 'WalletConnected' || walletOnly)) {
			mechanism = {type: 'wallet'};
		}
		remember = !(options?.doNotStoreLocally || false);
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const specificAddress = mechanism.address;
				const walletName =
					mechanism.name || ($connection.wallets.length == 1 ? $connection.wallets[0].info.name : undefined);
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
									const nextStep =
										!settings?.useCurrentAccount && !specificAddress && accounts.length > 1
											? 'ChooseWalletAccount'
											: 'WalletConnected';
									let account = accounts[0];
									if (specificAddress) {
										if (accounts.find((v) => v === specificAddress)) {
											account = specificAddress;
										} else {
											// TODO error
											throw new Error(`could not find address ${specificAddress}`);
										}
									}

									const newState: Connection<WalletProviderType> =
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
														pendingRequests: [],
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
														pendingRequests: [],
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
									setConnectionFailure({message: 'could not get any accounts'});
								}
							} else {
								let account = accounts[0];
								if (specificAddress) {
									if (accounts.find((v) => v === specificAddress)) {
										account = specificAddress;
									} else {
										// TODO error
										throw new Error(`could not find address ${specificAddress}`);
									}
								}
								const nextStep =
									!settings?.useCurrentAccount && !specificAddress && accounts.length > 1
										? 'ChooseWalletAccount'
										: 'WalletConnected';
								const newState: Connection<WalletProviderType> =
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
													pendingRequests: [],
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
													pendingRequests: [],
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
							// Clean up the wallet provider that was set mid-connect: if the
							// attempt fails (4100, 4001, timeout, …) the always-on
							// provider wrapper would otherwise keep routing ALL requests
							// (including read-only RPC calls like eth_call) through the
							// failed wallet, breaking the dapp's data fetches.
							if (_wallet) {
								stopWatchingForChainIdChange(_wallet.provider);
								stopWatchingForAccountChange(_wallet.provider);
								alwaysOnProviderWrapper.setWalletProvider(undefined);
								_wallet = undefined;
							}
							// Distinguish EIP-1193 error codes so the dapp can surface a
							// meaningful message instead of a generic "failed to connect".
							// 4100 (Unauthorized): the wallet cannot authorise accounts —
							// it may be read-only, locked, or not yet configured (e.g.
							// werust's keyless provider). 4001 (User Rejected Request):
							// the user actively declined in the wallet popup. Anything
							// else is a genuine failure.
							const code = (err as {code?: unknown})?.code;
							if (code === 4100) {
								setConnectionFailure({
									message:
										'The wallet is not authorized to provide accounts. It may be read-only, locked, or not yet configured.',
									cause: err,
								});
							} else if (code === 4001) {
								setConnectionFailure({message: 'Connection request was declined.', cause: err});
							} else {
								setConnectionFailure({message: `failed to connect to wallet`, cause: err});
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
				set({
					step: 'PopupLaunched',
					popupClosed: false,
					mechanism,
					wallets: $connection.wallets,
					wallet: undefined,
				});

				const unsubscribe = popup.subscribe(($popup) => {
					if ($connection?.step === 'PopupLaunched') {
						if ($popup.closed) {
							set({
								...$connection,
								popupClosed: true,
							});
						}
					}
				});
				try {
					const result = await popup;
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
	): Promise<WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>>;
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
	async function ensureConnected<Step extends 'WalletConnected' | 'SignedIn'>(
		stepOrMechanismOrOptions?: Step | Mechanism | EnsureConnectedOptions,
		mechanismOrOptions?: Mechanism | EnsureConnectedOptions,
		options?: EnsureConnectedOptions,
	): Promise<WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>> {
		// Determine if first arg is a step string, mechanism, or options
		let step: 'WalletConnected' | 'SignedIn';
		let mechanism: Mechanism | undefined;
		let opts: EnsureConnectedOptions | undefined;

		if (typeof stepOrMechanismOrOptions === 'string') {
			// First arg is a step
			step = stepOrMechanismOrOptions as 'WalletConnected' | 'SignedIn';
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

		// For WalletConnected step, default to wallet mechanism
		if (!mechanism && step === 'WalletConnected') {
			mechanism = {type: 'wallet'};
		}

		const promise = new Promise<WalletConnected<WalletProviderType> | SignedIn<WalletProviderType>>(
			(resolve, reject) => {
				let forceConnect = false;

				// The error (if any) already sitting in the store before we start.
				// Only an error that appears after this point tells us that *our* attempt failed.
				const errorOnEntry = $connection.error;

				// Helper to check if resolution conditions are met
				const canResolve = (connection: Connection<WalletProviderType>): boolean => {
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

				if (
					$connection.step == 'WalletConnected' &&
					($connection.wallet.status == 'locked' || $connection.wallet.status === 'disconnected')
				) {
					forceConnect = true;
					mechanism = $connection.mechanism; // we reuse existing mechanism as we just want to reconnect
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
					connect(mechanism, opts);
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
			},
		);

		return promise;
	}

	function disconnect() {
		deleteOriginAccount();
		deleteLastWallet();
		if (_wallet) {
			alwaysOnProviderWrapper.setWalletProvider(undefined);
			stopWatchingForAccountChange(_wallet.provider);
			stopWatchingForChainIdChange(_wallet.provider);
		}
		_wallet = undefined;
		unsubscribeRequestEvents();
		set({
			step: 'Idle',
			loading: false,
			wallet: undefined,
			wallets: $connection.wallets,
		});
	}

	function back(step: 'MechanismToChoose' | 'Idle' | 'WalletToChoose') {
		popup?.cancel();
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

		const authProvider = (import.meta as any).env?.VITE_AUTH_PROVIDER || 'openfort';
		popupURL.searchParams.append('provider', authProvider);

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
			const signature = await _wallet.provider.signMessage(message, account.address);
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

	function getSignatureForPublicKeyPublication(): Promise<`0x${string}`> {
		if ($connection.step !== 'SignedIn') {
			throw new Error('Not signed in');
		}
		const account = $connection.account;
		if ($connection.mechanism.type === 'wallet') {
			if (!_wallet) {
				throw new Error(`no provider`);
			}
			const message = originPublicKeyPublicationMessage(originToSignWith(), account.signer.publicKey);
			return _wallet.provider.signMessage(message, account.address);
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

	async function switchWalletChain(chainInfo?: BasicChainInfo) {
		if (!$connection.wallet) {
			throw new Error(`invali state`);
		}

		const chainInfoToUse = chainInfo || settings.chainInfo;

		const params = viemChainInfoToSwitchChainInfo(chainInfoToUse);

		const chainId = '' + chainInfoToUse.id;
		const chainIdAsHex = params.chainId;

		const wallet = $connection.wallet;
		// if (!wallet) {
		// 	throw new Error(`no wallet`);
		// }

		try {
			// attempt to switch...
			set({
				...$connection,
				wallet: {...$connection.wallet, switchingChain: 'switchingChain'},
			});
			const result = await wallet.provider.switchChain(chainIdAsHex);
			if (!result) {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
					});
				}

				// logger.info(`wallet_switchEthereumChain: complete`);
				// this will be taken care with `chainChanged` (but maybe it should be done there ?)
				// handleNetwork(chainId);
			} else {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
						error: {
							message: `Failed to switch to ${params?.chainName || `chain with id = ${chainId}`}`,
							cause: result,
						},
					});
				}
				throw result;
			}
		} catch (err) {
			if ((err as any).code === 4001) {
				// logger.info(`wallet_addEthereumChain: failed but error code === 4001, we ignore as user rejected it`, err);
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
					});
				}
				return;
			}
			// if ((err as any).code === 4902) {
			else if (params && params.rpcUrls && params.rpcUrls.length > 0) {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: 'addingChain'},
					});
				}
				// logger.info(`wallet_switchEthereumChain: could not switch, try adding the chain via "wallet_addEthereumChain"`);
				try {
					const result = await wallet.provider.addChain({
						chainId: chainIdAsHex,
						rpcUrls: params.rpcUrls,
						chainName: params.chainName,
						blockExplorerUrls: params.blockExplorerUrls,
						iconUrls: params.iconUrls,
						nativeCurrency: params.nativeCurrency,
					});
					if (!result) {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
							});
						}
						// this will be taken care with `chainChanged` (but maybe it should be done there ?)
						// handleNetwork(chainId);
					} else {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
								error: {
									message: `Failed to add new chain: ${params?.chainName || `chain with id = ${chainId}`}`,
									cause: result,
								},
							});
						}
						// logger.info(`wallet_addEthereumChain: a non-undefinded result means an error`, result);
						throw result;
					}
				} catch (err) {
					if ((err as any).code !== 4001) {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
								error: {
									message: `Failed to add new chain: ${params?.chainName || `chain with id = ${chainId}`}`,
									cause: err,
								},
							});
						}
						// logger.info(`wallet_addEthereumChain: failed`, err);
						// TODO ?
						// set({
						// 	error: {message: `Failed to add new chain`, cause: err},
						// });
						// for now:
						throw err;
					} else {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
							});
						}
						// logger.info(`wallet_addEthereumChain: failed but error code === 4001, we ignore as user rejected it`, err);
						return;
					}
				}
			} else {
				const errorMessage = `Chain "${params?.chainName || `with chainId = ${chainId}`} " is not available on your wallet`;
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
						error: {
							message: errorMessage,
						},
					});
				}

				throw new Error(errorMessage);
			}
		}
	}

	// Method on the store to check if target step is reached
	function storeIsTargetStepReached(connection: Connection<WalletProviderType>): boolean {
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
