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

// THE TARGET STEPS ARE ORDERED, and this array is the only place that says so.
//
// `SignedIn` implies `WalletConnected` implies `WalletChosen`, so "has this connection reached the
// target" is a comparison on this array rather than a hand-written comparison per step. It used to
// be written out three times, and one of the three (`ensureConnected`'s own `canResolve`) got the
// order right for `WalletChosen` and then compared the other two exactly, which did not answer
// wrong so much as never answer at all: a connection resting at `SignedIn` and asked for
// `WalletConnected` satisfied nothing, initiated nothing, and waited forever.
//
// A fourth step added to `TargetStep` lands here once, in order, and every satisfaction check
// follows.
const orderedTargetSteps: readonly TargetStep[] = ['WalletChosen', 'WalletConnected', 'SignedIn'];

/**
 * Is the connection AT OR BEYOND the target step?
 *
 * `requireWallet` is for the one case the order does not capture: `SignedIn` is the only target
 * step reachable without a wallet (the hosted email/oauth/mnemonic mechanisms), so a wallet target
 * is never satisfied by a state that has none, and a `SignedIn` target is only wallet-bound when
 * the caller says so.
 */
function stepIsAtOrBeyond<WalletProviderType>(
	connection: Connection<WalletProviderType>,
	target: TargetStep,
	options?: {requireWallet?: boolean},
): boolean {
	const reached = orderedTargetSteps.indexOf(connection.step as TargetStep);
	if (reached === -1) {
		// An in-progress or picker step is not a resting point at any target.
		return false;
	}
	if (reached < orderedTargetSteps.indexOf(target)) {
		return false;
	}
	if ((target !== 'SignedIn' || options?.requireWallet) && connection.wallet === undefined) {
		return false;
	}
	return true;
}

/**
 * The wallet is not on the account a caller asked this connection to act as.
 *
 * A RESTING STATE RATHER THAN AN ERROR, because it is not one: the user has a wallet, it works,
 * and it is simply on a different account than the one this request needs (replacing a stuck
 * transaction reuses its nonce, so it must be signed by the same key, and no other account will
 * do). There is a remedy and the user is the only one who can apply it, so this is published as an
 * instruction to render — "this was paid from 0xabc…, your wallet is on 0xdef…, switch or cancel" —
 * next to a connection that is still usable.
 *
 * Only a CALLER-SUPPLIED address produces it. An address this library replayed from the connection's
 * own state is a preference and keeps degrading to an ordinary connect, because the user never asked
 * for it.
 *
 * Two ways out, and the app has to offer both:
 * - the user switches account in their wallet, and the original request proceeds on its own (driven
 *   by `accountsChanged`, which is what makes this work on wallets that expose one account at a
 *   time and can therefore never offer the requested one in a list);
 * - the user acknowledges it (`acknowledgeAddressUnavailable()`), which is a CANCELLATION: the
 *   pending `ensureConnected` rejects with `ConnectionFailure('Connection cancelled')`, the same
 *   shape as any other "the user chose not to".
 */
export type AddressUnavailable = {
	/** The address the caller asked the connection to be able to act as. */
	requested: `0x${string}`;
	/** The wallet the request went to, by the name this connection knows it by, when known. */
	walletName?: string;
	// The three fields below describe the wallet AS IT IS NOW, not as it was when the attempt ran:
	// they are re-derived when the wallet announces a change, because "switch to the account we need"
	// is not advice a user can follow if it names an account they have already left. The state clears
	// itself outright once the wallet does offer `requested`.
	/**
	 * The account that wallet is on instead. Absent only when the wallet is offering none at all,
	 * which is what a wallet that has since been LOCKED reports: this state is kept up to date as
	 * the wallet moves, so it can go from naming an account to naming none.
	 */
	selected?: `0x${string}`;
	/**
	 * What the wallet is EXPOSING right now. Not what the user owns, and not a picker.
	 *
	 * MetaMask answers `eth_accounts` with every account the user permitted; Rabby (among others)
	 * answers with the one account it is currently on. So this list is frequently a single entry that
	 * does not contain `requested`, while the user is holding `requested` all along. An app that
	 * renders it as an exhaustive choice, or reads "absent" as "the user does not have it", is wrong
	 * for those wallets. `message` is the remedy that works everywhere: switch in the wallet.
	 *
	 * Empty when the wallet is offering no account at all, which is what a locked wallet reports.
	 */
	available: `0x${string}`[];
	/**
	 * A sentence an app can render as an INSTRUCTION rather than an error. Addresses are not
	 * shortened here: how to abbreviate an address is the app's decision, and every field the
	 * sentence is built from is on this object.
	 */
	message: string;
};

/**
 * The resting reason, built in ONE place.
 *
 * Two sites produce it: the attempt that discovers the address is not on offer, and the account
 * handler that keeps it true afterwards. They must word it identically, and a sentence written
 * twice is a sentence that will disagree once.
 */
function describeAddressUnavailable(details: {
	requested: `0x${string}`;
	walletName?: string;
	selected?: `0x${string}`;
	available: `0x${string}`[];
}): AddressUnavailable {
	const named = details.walletName ? `Wallet "${details.walletName}"` : 'The wallet';
	return {
		...details,
		message: details.selected
			? `${named} is on ${details.selected} and cannot act as ${details.requested}. Switch to that account in the wallet, or cancel.`
			: `${named} is not offering ${details.requested}. Select that account in the wallet, or cancel.`,
	};
}

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

/**
 * WHY a connection attempt ended without reaching what was asked for.
 *
 * A machine-readable discriminant, so an app never has to parse `message` or infer from which
 * fields happen to be absent. It is called `reason` and not `code` because `ConnectionFailure.code`
 * is taken: that one carries the EIP-1193 code off `cause`, and the two answer different questions
 * ("what did the wallet say" versus "what happened to my call").
 *
 * FORWARD COMPATIBILITY, decided rather than left implicit. This is a closed union so the type
 * system can exhaust it, but **new members may appear in a MINOR version**, because a reason this
 * library cannot yet tell apart is a reason it may learn to tell apart. That is why `'failed'`
 * exists as a catch-all: most future causes land there and need no new member, and anything that
 * does get one was previously indistinguishable from a generic failure anyway. **Keep a `default`
 * branch in your switch.** An exhaustive switch with no default is the one shape a new member can
 * break, and the trade was taken knowingly: a union you cannot switch on is worth less than one
 * that may grow.
 *
 * - `cancelled` — the user closed or dismissed the connect flow (`cancel()`, `back(...)`, closing
 *   the hosted popup, or a disconnect while the call was waiting). Nothing failed and nothing is
 *   worth showing: they decided. **Say nothing.**
 * - `address-unavailable-acknowledged` — the user read `connection.addressUnavailable` ("your
 *   wallet is not on that account") and chose not to switch. Also a decision, also not an error,
 *   and deliberately carrying the SAME `message` as `cancelled` (`'Connection cancelled'`) so that
 *   every existing "a refusal maps to cancelled" path keeps working untouched. Tell the two apart
 *   by THIS field, not by the shape.
 * - `superseded` — a newer `ensureConnected` naming a DIFFERENT address took the connection's one
 *   account slot. The user decided nothing; the app asked for two things at once. Retry it, or use
 *   two connections with different `storagePrefix`es.
 * - `unreachable` — the connection came to rest, nothing is in progress, and nothing can be
 *   initiated from here, so the target cannot be reached without a fresh gesture. An outcome to
 *   REPORT ("could not connect, try again"), not a silent no-op.
 * - `wallet-rejected` — the wallet prompt was declined (EIP-1193 4001). Offer a retry.
 * - `wallet-unavailable` — the wallet cannot authorise accounts (EIP-1193 4100): read-only,
 *   locked, or not configured. Retrying the same prompt will not help; the user must act in the
 *   wallet.
 * - `no-accounts` — the wallet answered the request with an empty account list. It looks like a
 *   refusal and is not one, which is why it does not alias onto `cancelled`.
 * - `cross-origin-blocked` — the wallet host refused a cross-origin request. The remedy is a
 *   registered delegate, not retrying the same popup. `cause` is the host's
 *   `{type: 'cross-origin-blocked', windowOrigin, signingOrigin}`.
 * - `host-refused` — the wallet host refused for a reason of ITS own, which this library does not
 *   model. The host is deployed separately and chooses its own vocabulary, so its `type` is passed
 *   through untouched on `cause` rather than being mapped to a member this library cannot verify:
 *   read `(err.cause as {type?: string})?.type` and `err.message` to distinguish them.
 * - `failed` — anything else, with the underlying error on `cause`. The catch-all: treat it as "it
 *   did not work", show `message`, offer a retry.
 */
export type ConnectionFailureReason =
	| 'cancelled'
	| 'address-unavailable-acknowledged'
	| 'superseded'
	| 'unreachable'
	| 'wallet-rejected'
	| 'wallet-unavailable'
	| 'no-accounts'
	| 'cross-origin-blocked'
	| 'host-refused'
	| 'failed';

/**
 * The error a connection comes to rest carrying, which an app renders.
 *
 * `reason` is REQUIRED, and that is the whole design: it makes the compiler enumerate every place
 * that can put an error on the connection, rather than leaving the next one to remember. This
 * codebase has twice fixed bugs whose root cause was an invariant maintained at N call sites
 * instead of one.
 *
 * It is the same vocabulary as the `ConnectionFailure` a pending `ensureConnected` rejects with,
 * and not by coincidence: that failure COPIES this field, so the state an app renders and the
 * error a caller catches cannot disagree about what happened.
 */
export type ConnectionError = {message: string; cause?: any; reason: ConnectionFailureReason};

// What the connection is, independently of which step it is at.
//
// Named rather than written inline below so that `set` can be given the same thing MINUS
// `pendingRequests`, which it stamps itself from the wrapper: see `ConnectionInput`.
type ConnectionCommon<WalletProviderType> = {
	// The connection can have an error in every state.
	// a banner or other mechanism to show error should be used.
	// error should be dismissable
	// `reason` says WHICH failure this is, in a closed vocabulary: see `ConnectionFailureReason`.
	error?: ConnectionError;
	/**
	 * Set when a caller asked this connection to act as an address the wallet is not offering.
	 *
	 * It sits BESIDE `error` rather than in it, and for the same reason it is not a throw: nothing
	 * failed. It is a resting reason with a remedy only the user can apply, so an app renders it as
	 * an instruction (see `AddressUnavailable`), not as a red banner.
	 *
	 * Like `error`, it survives a state built by spreading the current one and is dropped by any
	 * fresh transition, so a new attempt clears it without anybody remembering to.
	 */
	addressUnavailable?: AddressUnavailable;
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
//
// It is also what `ensureConnected('WalletConnected')` RESOLVES to, and that is the honest type
// rather than a widening for its own sake: the steps are ordered, so a signed-in connection
// satisfies the target and is handed back as itself. Typing that result as `WalletConnected` said
// `step: 'WalletConnected'` about a state whose step is `'SignedIn'`, and described its `account`
// as `{address}` when it is a whole `OriginAccount`.
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
	// One ordered comparison, shared with the store's own `isTargetStepReached` and with
	// `ensureConnected`. `walletOnly` narrows the RETURN TYPE and, for a `SignedIn` target, also the
	// check: a hosted sign-in has no wallet to act through.
	return stepIsAtOrBeyond(connection, targetStep, {requireWallet: !!walletOnly});
}

/**
 * Can this connection sign as `address` RIGHT NOW, with no flow initiated and nothing prompted?
 *
 * The question `connection.account.address` does not answer. That field is the address the
 * connection AGREED ON, which is the right thing for it to be: it survives the user locking their
 * wallet, revoking the site, or switching account behind the connection's back, all of which keep
 * `step: 'WalletConnected'` and change nothing about who was agreed on. What they change is whether
 * anybody can sign, and that is what this reads (`wallet.status`, and the accounts the wallet is
 * actually offering).
 *
 * It exists because a consumer needed it, wrote the comparison itself against `account.address`,
 * and got a locked wallet wrong: it skipped its `ensureConnected` call, let the transaction out,
 * and reported the provider's `{code: 4001}` as "transaction rejected by user" about a prompt
 * nobody was ever shown. Use this to RENDER readiness (enable a button, show "unlock to pay"), and
 * `ensureConnected(step, {type: 'wallet', address})` to actually reach it.
 *
 * Chain is deliberately not part of the answer: signing as an address is chain-independent, and
 * `wallet.invalidChainId` is the separate question with its own separate remedy.
 */
export function canActAs<WalletProviderType>(
	connection: Connection<WalletProviderType>,
	address: `0x${string}`,
): boolean {
	const wanted = address.toLowerCase();
	if (!connection.wallet || connection.wallet.status !== 'connected') {
		return false;
	}
	const agreedOn = 'account' in connection ? connection.account?.address : undefined;
	if (!agreedOn || agreedOn.toLowerCase() !== wanted) {
		return false;
	}
	const offered = connection.wallet.accounts;
	// An empty list is what a wallet that was never asked reports, not a denial; `status` is the
	// authority there. A non-empty one that does not contain the address IS a denial.
	//
	// Defensive, and marked as such: no state this library builds reaches here with an empty list
	// (the states that have one, like `WalletChosen`, carry no `account` and are answered above). It
	// is kept for a custom connector that publishes `connected` before it has read any accounts, and
	// it is deliberately not counted as covered by any test.
	if (offered.length > 0 && !offered.some((account) => account.toLowerCase() === wanted)) {
		return false;
	}
	return true;
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

/**
 * Error thrown by `ensureConnected` when a connection attempt ends without reaching the target step.
 *
 * Three fields, answering three different questions:
 *
 * - `reason` — WHAT HAPPENED TO THIS CALL, in a closed vocabulary this library controls. Read this
 *   one to decide what to do. See `ConnectionFailureReason`, including its note on new members.
 * - `cause` — the underlying error, exactly as whoever raised it wrote it (a wallet's EIP-1193
 *   error, the wallet host's `{type, message}` refusal). Unchanged by the arrival of `reason`.
 * - `code` — the convenience copy of `cause.code`, so a user rejection is still `code === 4001`.
 *   `reason === 'wallet-rejected'` now says the same thing without the reach into `cause`.
 *
 * `message` is unchanged on every path, deliberately, including `'Connection cancelled'` for a
 * dismissed `addressUnavailable`: the shape stays the safe one every consumer already maps to "the
 * user chose not to", and `reason` says which of those it was.
 *
 * The third constructor argument is optional so that constructing one by hand (a test double, a
 * consumer's own re-throw) keeps compiling; inside this library every failure comes from one place
 * that always supplies it.
 */
export class ConnectionFailure extends Error {
	name = 'ConnectionFailure';
	readonly code?: unknown;
	readonly reason: ConnectionFailureReason;
	constructor(message: string, cause?: unknown, reason: ConnectionFailureReason = 'failed') {
		super(message);
		this.cause = cause;
		this.code = (cause as {code?: unknown} | undefined)?.code;
		this.reason = reason;
	}
}

/**
 * What an error THROWN AT US means, in the vocabulary above.
 *
 * One function rather than a test repeated at each catch site, because the mapping is the part that
 * has to stay consistent: the same rejected wallet prompt must read as `wallet-rejected` whether it
 * arrives from `eth_requestAccounts`, from a signature request, or from an attempt that rejected
 * before it published anything.
 *
 * Only shapes this library can actually VERIFY are mapped. EIP-1193 codes are a standard the wallet
 * and this library both agree on, and `cross-origin-blocked` is minted by `@etherplay/connect-core`
 * in this same repo. Everything else keeps its own words on `cause` and lands on the catch-all.
 *
 * Note what this deliberately does NOT do: an unknown `{type}` does not become `host-refused` here,
 * because an arbitrary thrown object carrying a `type` is not evidence that a HOST refused
 * anything. Host refusals reach the connection through the popup catch, which uses
 * `reasonForHostRefusal` instead. No path currently throws a host refusal INTO this function; if
 * one ever does, it will read as `failed`, and this is the comment that says to route it through
 * `reasonForHostRefusal` at that point rather than loosening the test here.
 */
function reasonForError(err: unknown): ConnectionFailureReason {
	const code = (err as {code?: unknown} | undefined)?.code;
	if (code === 4001) {
		return 'wallet-rejected';
	}
	if (code === 4100) {
		return 'wallet-unavailable';
	}
	if ((err as {type?: unknown} | undefined)?.type === 'cross-origin-blocked') {
		return 'cross-origin-blocked';
	}
	return 'failed';
}

/**
 * What a WALLET HOST refusal means, in the vocabulary above.
 *
 * The host is deployed separately and picks its own `type` strings, so only types this library can
 * verify are mapped, and everything else passes through as `host-refused` with the host's own
 * `type` left intact on `cause`. Inventing a member per host vocabulary word would be claiming to
 * know something this package cannot check, and would go stale the moment the host shipped a new
 * one.
 *
 * Exactly ONE type is mapped here, `cross-origin-blocked`, which comes from
 * `@etherplay/connect-core` in this repo. The other verifiable type, `cancelation` (raised by this
 * package's own popup, `src/popup.ts`), is handled by the CALLER and never reaches this function:
 * closing the popup sets no error at all, and `ensureConnected` reports it through its own
 * cancellation branch. A `undefined` refusal likewise cannot arrive, for the same reason.
 */
function reasonForHostRefusal(refusal: {type?: string} | undefined): ConnectionFailureReason {
	return refusal?.type === 'cross-origin-blocked' ? 'cross-origin-blocked' : 'host-refused';
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
	// Dismiss a resting `connection.addressUnavailable`, which settles any `ensureConnected` waiting
	// on it as a cancellation. The connection is left connected, on whatever account the wallet is
	// offering. See `AddressUnavailable`.
	acknowledgeAddressUnavailable: () => void;
	// Can this connection sign as `address` right now? Reads the current state and initiates
	// nothing, so it is safe to call while rendering. The standalone `canActAs(connection, address)`
	// is the same answer against a state you already hold (a `$connection` in a reactive block).
	canActAs: (address: `0x${string}`) => boolean;
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
					(options?: EnsureConnectedOptions): Promise<ConnectedWithWallet<WalletProviderType>>;
					(
						step: 'WalletConnected',
						mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
						options?: EnsureConnectedOptions,
					): Promise<ConnectedWithWallet<WalletProviderType>>;
				}
			: WalletOnly extends true
				? {
						// walletOnly: true for SignedIn - returns SignedInWithWallet (not full SignedIn union)
						(options?: EnsureConnectedOptions): Promise<SignedInWithWallet<WalletProviderType>>;
						(
							step: 'WalletConnected',
							mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
							options?: EnsureConnectedOptions,
						): Promise<ConnectedWithWallet<WalletProviderType>>;
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
						): Promise<ConnectedWithWallet<WalletProviderType>>;
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
		// The address a resting reason last named, kept so a dismissal can be attributed to the request
		// the user was looking at even if an attempt clears the field a moment before they click.
		if (connection.addressUnavailable) {
			lastPublishedAddressUnavailable = connection.addressUnavailable.requested;
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
	//
	// `error` carries a REQUIRED `reason` (see `ConnectionFailureReason`). That is not decoration: a
	// pending `ensureConnected` copies it onto the `ConnectionFailure` it rejects with, so what the
	// app renders and what the caller catches cannot disagree, and requiring it here is what makes
	// the compiler enumerate the producers instead of leaving the next one to remember.
	function setConnectionFailure(error: ConnectionError) {
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
	function setError(error: ConnectionError) {
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

	/**
	 * The user has read "your wallet is not on that account" and chosen not to switch.
	 *
	 * THAT IS A CANCELLATION, and it settles the pending `ensureConnected` as one: the same
	 * `ConnectionFailure('Connection cancelled')` a `cancel()` or a `back()` produces, so an app that
	 * already maps a refusal to "the user chose not to" needs no new branch and shows no red error
	 * for a decision.
	 *
	 * The connection itself is left exactly as it is, deliberately. It is CONNECTED, on the account
	 * the wallet is actually offering, and "connected as somebody else, and saying so" is a better
	 * place to leave a user than "not connected at all" — which is what the alternative, failing the
	 * attempt, produced: every failure state carries `wallet: undefined`.
	 */
	function acknowledgeAddressUnavailable() {
		// WHICH request the user dismissed: the one on screen, or the one that was on screen a moment
		// ago if an attempt has just cleared the field out from under them.
		const dismissed = $connection.addressUnavailable?.requested ?? lastPublishedAddressUnavailable;
		if (dismissed) {
			const key = dismissed.toLowerCase();
			addressUnavailableAcknowledgements.set(key, (addressUnavailableAcknowledgements.get(key) ?? 0) + 1);
		}
		// COUNTED, not inferred. A pending `ensureConnected` used to read the reason DISAPPEARING as
		// the dismissal, which is true of this method and of nothing else — and plenty else clears it:
		// the app calling `connect()` itself, a `useCurrentAccount` store following the wallet onto
		// another account, the reason ceasing to be true. Each of those was reported to the caller as
		// `Connection cancelled`, which consumers are told to treat as "the user chose not to", so an
		// event the user never caused was invisible to them.
		//
		// Republished even when the field is already gone (an attempt may have cleared it a moment
		// ago): the publish is what wakes a pending `ensureConnected` to notice the dismissal. Without
		// it, a click landing in that window is counted and then never acted on, which is a wait that
		// nothing ends.
		set({
			...$connection,
			addressUnavailable: undefined,
		});
	}

	// Dismissals of "your wallet is not on that account", COUNTED PER ADDRESS. See
	// `acknowledgeAddressUnavailable`: a pending `ensureConnected` watches the count for the address
	// IT asked about, so that a decision is told apart both from the several other things that clear
	// the same field and from a decision about somebody else's request. A single global count made
	// one dismissal cancel every address-bound call on the connection, including one whose wallet
	// prompt was open at that moment.
	const addressUnavailableAcknowledgements = new Map<string, number>();
	function acknowledgementsFor(address: `0x${string}`): number {
		return addressUnavailableAcknowledgements.get(address.toLowerCase()) ?? 0;
	}
	// The reason most recently PUBLISHED, so that a dismissal arriving in the brief window where an
	// attempt has cleared the field still names the address the user was actually looking at.
	let lastPublishedAddressUnavailable: `0x${string}` | undefined;

	/**
	 * The address-bound `ensureConnected` calls that are still live on this connection, in the order
	 * they were made. Mirrors `addressUnavailableAcknowledgements` above: per connection, per address,
	 * kept by the one thing that knows.
	 *
	 * WHY IT EXISTS. A connection has one wallet, one account and one `addressUnavailable` slot, so a
	 * second call naming a DIFFERENT address supersedes the first: the newer request takes the slot,
	 * the older one loses the state it was resting on and comes to rest with nothing in progress. That
	 * is a real answer and it was already delivered honestly (`could not reach ...`, never a
	 * cancellation the user did not make), but it arrived looking exactly like every other
	 * come-to-rest, so no consumer could tell "your own app asked for something else" from "this
	 * connection cannot get there". Only ONE call knows the difference and it is not the one being
	 * answered, which is why supersession cannot be read off the connection state and needs a
	 * registry.
	 *
	 * Registration is a monotonic id rather than a set, because the question is ordered: an OLDER
	 * request is superseded by a NEWER one, never the other way round.
	 *
	 * WHAT IT IS AND IS NOT. `superseded` says "a later live request names another account", which is
	 * an over-approximation of "that request is what displaced me": if some third thing (the app's own
	 * `connect()`, a disconnect) ends both at once, the older is still labelled superseded. That is
	 * the harmless direction, since the newer request was going to take the slot anyway, and the
	 * remedy the label implies (retry) is the right one either way. The opposite error is avoided by
	 * construction: a call that resolves without ever waiting returns before it registers.
	 *
	 * An entry lives exactly as long as its promise is unsettled, which for an abandoned call means as
	 * long as the promise itself: this map holds no more than the pending calls already do.
	 */
	let addressBoundRequests = 0;
	const liveAddressBoundRequests = new Map<number, `0x${string}`>();
	function registerAddressBoundRequest(address: `0x${string}`): number {
		const id = ++addressBoundRequests;
		liveAddressBoundRequests.set(id, address.toLowerCase() as `0x${string}`);
		return id;
	}
	/** Is a LATER live request naming a DIFFERENT address, i.e. holding the slot this one needs? */
	function isSupersededBy(id: number, address: `0x${string}`): boolean {
		const asked = address.toLowerCase();
		for (const [otherId, otherAddress] of liveAddressBoundRequests) {
			if (otherId > id && otherAddress !== asked) {
				return true;
			}
		}
		return false;
	}

	// How many times the user's WALLET has announced a DIFFERENT set of accounts. It is the unit
	// `ensureConnected` retries on, and it is the honest one: a retry is a response to the user
	// having done something in their wallet, so at most one attempt per announcement bounds the work
	// while never refusing to act on a real gesture. Counting distinct STATES instead looks stricter
	// and refuses the retry when the user returns to a state seen before, which is a normal thing for
	// a person to do.
	//
	// Only a CHANGE counts, and only an account one. The lock poll re-announces an empty list every
	// second, which is the absence of news rather than news, and would otherwise re-license an attempt
	// per second on a locked wallet; a chain change is news, but not news about accounts, and
	// re-prompting for an account because the user switched network answers a question they did not
	// ask.
	let walletAnnouncements = 0;

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
				// A declined signature prompt is the same 4001 a declined connect is, and the same
				// mapping names it: an app that offers "try again" on a rejection must not have to know
				// which prompt was rejected to recognise one.
				error: {message: 'failed to sign message', cause: err, reason: reasonForError(err)},
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
		// NEWS is an announcement that differs from what the connection currently believes — not one
		// that differs from the previous announcement. The two come apart exactly where it matters: an
		// attempt can go and find something else in between, so a wallet announcing the same list twice
		// with a contradicting answer in the middle is telling us something the second time too.
		if (accountsFormated.join(',') !== ($connection.wallet?.accounts ?? []).join(',')) {
			walletAnnouncements++;
		}

		// A RESTING "your wallet is not on that account" MUST KEEP DESCRIBING THE WALLET AS IT IS.
		//
		// Every `set` below rebuilds the state by spreading the current one, so the reason would
		// survive an account change untouched: right about the FACT (the wallet still cannot act as
		// the requested account) and wrong about the DETAIL, since it would go on naming an account
		// the user has already left, and the app renders that sentence as the instruction. Telling
		// somebody to switch away from an account they are not on is worse than saying nothing.
		//
		// Computed here and published WITH the accounts rather than corrected afterwards, so that no
		// intermediate state is ever published in which the two disagree — a correction one publish
		// later is a frame of wrong instruction, which is exactly what an app renders.
		const addressUnavailable = refreshedAddressUnavailable(accountsFormated);

		if ($connection.wallet) {
			const locked = accountsFormated.length == 0;
			const addressSignedIn = $connection.mechanism.address;

			if (locked) {
				set({
					...$connection,
					addressUnavailable,
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
						addressUnavailable,
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
						addressUnavailable,
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
						addressUnavailable,
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
					addressUnavailable,
					wallet: {
						...$connection.wallet,
						accountChanged: undefined,
						accounts: accountsFormated,
					},
				});
			}
		}
	}

	/**
	 * The resting reason, re-derived against what the wallet is offering now.
	 *
	 * `undefined` once the wallet DOES offer the requested account: the reason has simply stopped
	 * being true. A pending `ensureConnected` loses nothing by that — it watches the accounts the
	 * wallet offers rather than this field, precisely so that the state going away because the user
	 * fixed it cannot be mistaken for the user dismissing it.
	 */
	function refreshedAddressUnavailable(offered: `0x${string}`[]): AddressUnavailable | undefined {
		const unavailable = $connection.addressUnavailable;
		if (!unavailable) {
			return undefined;
		}
		if (offered.some((account) => account.toLowerCase() === unavailable.requested.toLowerCase())) {
			return undefined;
		}
		if (offered.join(',') === unavailable.available.join(',')) {
			return unavailable;
		}
		return describeAddressUnavailable({
			requested: unavailable.requested,
			walletName: unavailable.walletName,
			selected: offered[0],
			available: offered,
		});
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
		// Taken as an argument rather than derived from `cause` here: this function is the RESTING
		// half of a failure whose other half is `setConnectionFailure`, and the two must label the
		// same event identically. An empty accounts answer has no `cause` to derive anything from.
		reason: ConnectionFailureReason,
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
			error: {message: errorMessage, cause, reason},
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
	 * @param internal not part of the public `connect` surface. THREE things an address can mean,
	 * and they are told apart here rather than by inspecting the caller:
	 *
	 * - nothing set: a DEMAND. `connectToAddress(a)` and `connect({type: 'wallet', address: a})` mean
	 *   that account and no other, so a wallet that cannot offer it fails the attempt.
	 * - `addressIsPreference`: a mechanism this library REPLAYED from the current state rather than
	 *   one anybody asked for, so a vanished address degrades to an ordinary connect.
	 * - `reportUnavailableAddress`: a demand the caller wants REPORTED rather than thrown, which is
	 *   what `ensureConnected` asks for. Failing the attempt tears the wallet down (every failure
	 *   state carries `wallet: undefined`), which is the worst of the three endings: the user is left
	 *   with no wallet at all over a wallet that is working and merely on another account. So the
	 *   attempt completes on what the wallet does offer and comes to rest carrying
	 *   `addressUnavailable`, which is a state the app can render and the user can answer.
	 *
	 * See `resolveRequestedAddress` below.
	 */
	async function connect(
		mechanism?: Mechanism,
		options?: ConnectOptions,
		internal?: {addressIsPreference?: boolean; reportUnavailableAddress?: boolean},
	) {
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
				// LOWERCASED HERE, at the boundary, because everything downstream compares against the
				// wallet's accounts, which are lowercased on arrival. A checksummed address (what a viem
				// local account hands back, so a perfectly ordinary thing for a caller to be holding) would
				// otherwise fail to match a wallet that is holding that very account. It was a latent
				// papercut while an unmatched address merely failed the attempt; now that a caller's address
				// is a requirement, it would send the user an instruction to switch to the account they are
				// already on.
				const specificAddress = mechanism.address?.toLowerCase() as `0x${string}` | undefined;
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
				//
				// The third possibility is `reportUnavailableAddress`: the demand stands, but the answer is
				// a state rather than a failure. `unavailableAddress` is what records it, and it is read
				// twice below — once to keep the flow off `ChooseWalletAccount` (the caller named an
				// account; offering a picker instead of saying why they cannot have it is answering a
				// different question), and once to stamp `addressUnavailable` on the resting state.
				let unavailableAddress: `0x${string}` | undefined;
				const resolveRequestedAddress = (available: `0x${string}`[]): `0x${string}` | undefined => {
					if (!specificAddress || available.includes(specificAddress)) {
						return specificAddress;
					}
					if (internal?.addressIsPreference) {
						return undefined;
					}
					if (internal?.reportUnavailableAddress) {
						unavailableAddress = specificAddress;
						return undefined;
					}
					throw new Error(`could not find address ${specificAddress}`);
				};
				const walletName =
					mechanism.name ||
					($connection.step === 'WalletChosen' ? $connection.mechanism.name : undefined) ||
					($connection.wallets.length == 1 ? $connection.wallets[0].info.name : undefined);
				/**
				 * The resting reason to publish beside a connection that came back as somebody else.
				 *
				 * Everything the app needs to write the instruction is on it, including the accounts the
				 * wallet IS offering: "switch account" is not actionable advice if the user cannot see
				 * which account the wallet thinks it is on.
				 */
				const addressUnavailableFor = (
					available: `0x${string}`[],
					selected: `0x${string}` | undefined,
				): AddressUnavailable | undefined =>
					unavailableAddress
						? describeAddressUnavailable({requested: unavailableAddress, walletName, selected, available})
						: undefined;
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
									// `!unavailableAddress`: the caller named an account and cannot have it. An account
									// picker would answer a question they did not ask; they get the wallet's current
									// account plus a resting reason naming every account it does offer.
									const nextStep =
										!settings?.useCurrentAccount && !requestedAddress && !unavailableAddress && accounts.length > 1
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
													addressUnavailable: addressUnavailableFor(accounts, account),
												};
									// `!unavailableAddress`: do not raise a SIGNATURE prompt for an account the caller
									// did not ask to sign as. The instruction has to reach the user before anything
									// else asks them for something.
									if (
										newState.step === 'WalletConnected' &&
										!unavailableAddress &&
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
											// `no-accounts`, NOT a cancellation. The wallet answered, and answered with
											// nothing: from the outside that looks like a refusal and it is not one, which
											// is exactly the aliasing a consumer's own sniffing module got wrong.
											'no-accounts',
											chosenMechanismBeforeConnect,
											chosenWalletBeforeConnect,
										)
									) {
										setConnectionFailure({message: 'could not get any accounts', reason: 'no-accounts'});
									}
								}
							} else {
								const requestedAddress = resolveRequestedAddress(accounts);
								const account = requestedAddress || accounts[0];
								// See the same expression on the requestAccounts branch above: a caller who named an
								// account gets a reason, not a picker.
								const nextStep =
									!settings?.useCurrentAccount && !requestedAddress && !unavailableAddress && accounts.length > 1
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
												addressUnavailable: addressUnavailableFor(accounts, account),
											};
								if (
									newState.step === 'WalletConnected' &&
									!unavailableAddress &&
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
							// The message picked per code below and the `reason` a consumer reads instead of
							// re-deriving it are two lists over the same two codes. They agree today and nothing
							// COUPLES them: a third message added here without a matching member in
							// `reasonForError` would be prose the discriminant does not know about. Deriving the
							// message from the reason would fix that and would change every message string, which
							// this change is not allowed to do.
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
							// ONE derivation, read by both halves of the failure. The restore path and
							// `setConnectionFailure` are two landings for the same event, so a reason computed
							// twice is two chances to compute it differently.
							const reason = reasonForError(err);
							if (
								!restoreWalletChosenAfterFailedConnect(
									errorMessage,
									err,
									reason,
									chosenMechanismBeforeConnect,
									chosenWalletBeforeConnect,
								)
							) {
								setConnectionFailure({message: errorMessage, cause: err, reason});
							}
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						// The catch-all, deliberately: the named wallet is not among the announced ones (a typo, an
						// extension uninstalled between render and click). It gets no member of its own because it
						// is not a state the user can answer, and the message already names the wallet.
						setConnectionFailure({message: `failed to get wallet ${walletName}`, reason: 'failed'});
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
						// The host's own `type` stays on `cause`, untouched; `reason` pins only what this library
						// can verify (`cross-origin-blocked`) and passes anything else through as `host-refused`.
						error: canceled
							? undefined
							: {message: refusal.message || 'sign in failed', cause: refusal, reason: reasonForHostRefusal(refusal)},
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
	 * Reach `step`, as the mechanism describes it, doing whatever that takes.
	 *
	 * A TARGET, NOT A STEP COMPARISON. The target is satisfied when the connection is at or beyond
	 * `step` (they are ordered: `SignedIn` implies `WalletConnected` implies `WalletChosen`), AND is
	 * on the wallet the caller named, AND can act as the address the caller named, AND is on the
	 * right chain (unless `skipChainCheck`). Anything the caller did not name is not part of it, so a
	 * bare `ensureConnected()` is unchanged.
	 *
	 * An address or a wallet name a CALLER passes is a REQUIREMENT rather than a hint: the whole
	 * reason to pass one is that this request only means anything for that account (replacing a stuck
	 * transaction reuses its nonce, so it must be signed by the same key). A connection already at
	 * the requested step but holding a different account therefore initiates an attempt rather than
	 * resolving instantly with somebody else. An address this library REPLAYED from the connection's
	 * own state stays a preference, because nobody asked for it.
	 *
	 * IT ALWAYS ANSWERS. There is no timeout, deliberately: a human is in the loop, so any timer is
	 * either long enough to be useless or short enough to cut a user off mid-decision, and it would
	 * report "timed out" for a wallet dialog that is open and perfectly healthy. The rule is narrower
	 * and checkable instead: WAITING IS ONLY LEGITIMATE WHILE SOMETHING IS ACTUALLY IN PROGRESS. See
	 * `awaitingUserReason` below for the closed list of what counts, each of which is a state the app
	 * renders and the user answers. If the target is not satisfied, nothing is in progress and
	 * nothing can be initiated, that is an ANSWER and it is delivered rather than awaited.
	 *
	 * So it ends in one of four ways: it resolves at the target; it rejects with a `ConnectionFailure`
	 * (`cause`/`code` carry the underlying wallet error, so a user rejection is EIP-1193 code 4001);
	 * it rejects with `ConnectionFailure('Connection cancelled')` when the user backs out, including
	 * by acknowledging an `addressUnavailable`; or it stays pending while one of the listed things is
	 * in progress.
	 *
	 * It initiates from `Idle`, from `WalletChosen` (the wallet is chosen, upgrading it is exactly
	 * what was asked), from a resting state that does not satisfy the target, and from a picker step
	 * (`MechanismToChoose`, `WalletToChoose`) that still carries the error of a previous failed
	 * attempt, which is what makes a retry after a rejected wallet prompt work. It deliberately does
	 * NOT initiate from a picker step without an error: that means the user is mid-choice with the
	 * picker on screen, and connecting there would hijack their choice. In that case it waits for the
	 * user to pick (or cancel). Pass `{forceConnect: true}` to connect anyway.
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
	): Promise<ConnectedWithWallet<WalletProviderType>>;
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
				// `?? options`: the second argument may be an EXPLICIT `undefined` mechanism, which is what
				// a caller writes when it has options but nothing to name (`ensureConnected('SignedIn',
				// undefined, {requestSignatureRightAway: true})`, and any call passing a mechanism variable
				// that happens to be unset). Reading only the second argument silently dropped the third,
				// so the options were ignored and the call waited for something the caller had asked it to
				// do itself.
				opts = (mechanismOrOptions as EnsureConnectedOptions | undefined) ?? options;
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
			// WHAT THE CALLER ASKED FOR, captured before `mechanism` can be reassigned below. An address
			// or a wallet name that arrives HERE came from the caller, so it is a requirement; anything
			// this library replays from the current state is a preference and never lands in these.
			const asked = mechanism && mechanism.type === 'wallet' ? mechanism : undefined;
			const askedWalletName = asked?.name;
			// Ignored for a `WalletChosen` target, and that is not an oversight: choosing a wallet never
			// asks it for accounts, so no state that target can reach could ever satisfy an address.
			// Requiring one there would guarantee the hang this rework exists to remove.
			const askedAddress =
				step === 'WalletChosen' ? undefined : (asked?.address?.toLowerCase() as `0x${string}` | undefined);

			let forceConnect = false;
			// Whether the mechanism below was REPLAYED from the current state rather than asked for.
			let reconnecting = false;

			// The error (if any) already sitting in the store before we start.
			// Only an error that appears after this point tells us that *our* attempt failed.
			const errorOnEntry = $connection.error;

			/** Is this connection on the wallet the caller named? Nothing named, nothing to check. */
			const walletNameMatches = (connection: Connection<WalletProviderType>): boolean => {
				if (!askedWalletName) {
					return true;
				}
				const current =
					'mechanism' in connection ? (connection.mechanism as {type?: string; name?: string}) : undefined;
				if (current?.type !== 'wallet' || !current.name) {
					return false;
				}
				if (current.name === askedWalletName) {
					return true;
				}
				// A name may be an EIP-6963 uuid: that is what `connect` looks wallets up by too, so the
				// two spellings of the same wallet must not read as two different wallets here.
				const handle = connection.wallets.find(
					(v) => v.info.name === askedWalletName || v.info.uuid === askedWalletName,
				);
				return !!handle && (handle.info.name === current.name || handle.info.uuid === current.name);
			};

			/**
			 * The part of the target a connection ATTEMPT could fix: the step, the wallet, the account.
			 *
			 * Split from the chain check below because the two call for opposite responses. Reconnecting
			 * moves the step and the account; it does not move the chain, so initiating an attempt over a
			 * chain mismatch would prompt the user for nothing and rebuild a wallet that was fine.
			 */
			const targetReached = (connection: Connection<WalletProviderType>): boolean =>
				stepIsAtOrBeyond(connection, step) &&
				walletNameMatches(connection) &&
				(!askedAddress || canActAs(connection, askedAddress)) &&
				// A `WalletConnected` connection whose wallet has gone locked or revoked is AT the step and
				// cannot act, so it does not satisfy a target that needs it to: that is the one and only
				// reason `ensureConnected` reconnects such a wallet where `connect()` would not (ADR-0002).
				// A `WalletChosen` target is exempt because it never needed accounts in the first place, and
				// `SignedIn` because a signed-in app acts through its session account, which a locked wallet
				// does not invalidate.
				(step === 'WalletChosen' || connection.step !== 'WalletConnected' || connection.wallet.status === 'connected');

			/** The part it could not: only the user, or their wallet, moves the chain. */
			const chainIsRight = (connection: Connection<WalletProviderType>): boolean =>
				step !== 'WalletConnected' || !!opts?.skipChainCheck || !connection.wallet?.invalidChainId;

			const canResolve = (connection: Connection<WalletProviderType>): boolean =>
				targetReached(connection) && chainIsRight(connection);

			const reconnect = mechanismToReconnect();
			if (!reconnect && canResolve($connection)) {
				resolve($connection as any);
				return;
			}
			if (reconnect) {
				// A locked or revoked wallet: reconnecting it is the only way to hand back something usable.
				forceConnect = true;
				if (askedAddress) {
					// The replayed mechanism MUST NOT overrule what the caller named. Substituting the stored
					// address here is precisely how a caller's requirement used to become somebody else's
					// account: the reconnect would come back on the stored one and the caller's address was
					// never looked at again. The wallet name is still worth reusing, since it is the wallet
					// this connection is on and the caller usually did not name one.
					mechanism = {type: 'wallet', name: askedWalletName || reconnect.name, address: askedAddress};
				} else if (askedWalletName && askedWalletName !== reconnect.name) {
					// A different wallet was named: replaying THIS wallet's account would demand an address
					// from a wallet that has no reason to have it.
					mechanism = {type: 'wallet', name: askedWalletName};
				} else {
					mechanism = reconnect;
					// ...and its ADDRESS is only a preference, because the user may unlock on another
					// account, and a replayed address is not something the caller asked for.
					reconnecting = true;
				}
			}
			let idlePassed = $connection.step != 'Idle';

			// An attempt is considered started once we observe a step where the connection is in progress.
			// Falling back to a resting step from there means the attempt ended without reaching the target.
			let attemptStarted = false;
			// Dismissals of the address-unavailable state that happened BEFORE this call: only a later one
			// is this call's answer.
			const acknowledgementsOnEntry = askedAddress ? acknowledgementsFor(askedAddress) : 0;
			// THIS CALL'S PLACE IN THE QUEUE for the connection's one account slot, kept only while the
			// call is live (see `settle`). Registered here, after the early resolve above has already
			// returned, so a call that never waited never claims the slot at all.
			const addressBoundRequestId = askedAddress ? registerAddressBoundRequest(askedAddress) : undefined;
			// WHAT STOPS "try again" FROM BECOMING A LOOP: at most one attempt per wallet announcement.
			//
			// Our own attempts do not bump `walletAnnouncements`, so an attempt can never start another one
			// off its own result, however the wallet answers. Anything past that requires the user to act
			// in their wallet again, which is a person, not a loop.
			//
			// Two earlier versions of this rule are worth not repeating. "One attempt per distinct wallet
			// ANSWER" read well and measured false (the reset that stopped it suppressing legitimate
			// retries forgot the answer every time). "One attempt per distinct STATE" is provably
			// terminating and refuses the retry when the user switches back to an account they were on
			// before, which is an ordinary thing to do and leaves them following an instruction that no
			// longer does anything.
			//
			// Load-bearing, and pinned the hard way: delete this guard and `test/ensure-connected-settles`
			// does not fail, it HANGS, which is the honest signature of the bug it prevents.
			let attemptedAtEvent: number | undefined;
			// An attempt decided on but not started yet: see `scheduleAttempt`.
			let attemptScheduled = false;
			// How many attempts THIS call has started that have not finished yet.
			//
			// The store is not enough to know that. `connect` publishes `WaitingForWalletConnection`
			// before its first await, but `selectWallet` awaits `getChainId` before publishing anything at
			// all, and the popup path can await a key generation first. In that window the store still
			// holds the entry state, nothing is "in progress" as far as any published state is concerned,
			// and the answer branch below would report "nothing is in progress" about an attempt that is
			// running and about to succeed. It did exactly that, for `ensureConnected('WalletChosen')`
			// from any non-Idle state: rejected, and then reached the target anyway.
			let attemptsInFlight = 0;
			let settled = false;
			let unsubscribe: (() => void) | undefined;
			const settle = (perform: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				// unsubscribe can still be undefined here if the store settles during the initial (synchronous) subscription
				unsubscribe?.();
				// This call is over, so it stops competing for the account slot and stops being counted
				// against anybody.
				//
				// HONEST NOTE, because no test fails if this is deleted: it is defensive. For it to change
				// an observable label, a NEWER address-bound call would have to settle while an OLDER one
				// stays live, and every way a newer call can settle publishes a state that also ends an
				// older call resting on it — while an older call that is still waiting is waiting on
				// something in progress, which publishes again in its turn. Kept anyway: it also bounds the
				// map, and "the registry contains the live requests" is cheaper to keep true than to reason
				// about every time somebody adds a settle path.
				if (addressBoundRequestId !== undefined) {
					liveAddressBoundRequests.delete(addressBoundRequestId);
				}
				perform();
			};
			/**
			 * THE ONE PLACE A `ConnectionFailure` IS BUILT, and it takes the reason first.
			 *
			 * Not tidiness: `reason` is the field that must never be forgotten, and a rule kept at four
			 * call sites is a rule that is kept at three of them a year from now. This codebase has
			 * twice fixed bugs whose root cause was exactly that (`pendingRequests`, wallet teardown).
			 */
			const failWith = (reason: ConnectionFailureReason, message: string, cause?: unknown) =>
				settle(() => reject(new ConnectionFailure(message, cause, reason)));
			/**
			 * The MESSAGE is the same for both, and that is the point: every consumer already maps
			 * `'Connection cancelled'` to "the user chose not to" and shows nothing, so a dismissed
			 * `addressUnavailable` must keep arriving in that shape and must not paint a red banner over
			 * a decision. What was missing is WHICH decision, and that is what `reason` adds.
			 */
			const cancelled = (reason: 'cancelled' | 'address-unavailable-acknowledged') =>
				failWith(reason, 'Connection cancelled');

			/**
			 * Start an attempt and stay honest about it while it runs.
			 *
			 * Everything these calls do, they normally do by moving the store, and the subscription below
			 * reads the answer off it. Two things break that, and both are handled here rather than by
			 * guessing from published states:
			 *
			 * - an attempt can be RUNNING while the store still shows the state it started from, because
			 *   `selectWallet` (and the popup path) await before their first publish;
			 * - an attempt can FAIL before its first publish (a hosted mechanism with no `walletHost`),
			 *   after which nothing has changed and nothing will publish again.
			 *
			 * A late rejection, after the flow moved on, settles nothing: `settle` is idempotent and the
			 * store has already answered.
			 */
			const runAttempt = (attempt: Promise<unknown>) => {
				attemptsInFlight++;
				attempt.then(
					() => {
						attemptsInFlight--;
						// Decide again now that it is over. The store may have published its last state while
						// this attempt still counted as in progress, and nothing else will publish again: an
						// attempt that ends without reaching the target has to be answered here or nowhere.
						evaluate($connection);
					},
					(err) => {
						attemptsInFlight--;
						failWith(reasonForError(err), (err as Error)?.message || `could not reach ${step}`, err);
					},
				);
			};

			/** Is the connection sitting on the account the caller asked for, ready to be asked to sign? */
			const readyToSign = (connection: Connection<WalletProviderType>): boolean =>
				connection.step === 'WalletConnected' &&
				connection.wallet.status === 'connected' &&
				walletNameMatches(connection) &&
				(!askedAddress || canActAs(connection, askedAddress));

			/**
			 * Do whatever can be done from where the connection is right now.
			 *
			 * It may deliberately do NOTHING, in the one case where the pending thing is a click in the
			 * app rather than anything this library can start: a `WalletConnected` connection asked for
			 * `SignedIn` on a store that did not ask for the signature to be requested automatically. That
			 * app renders its own "sign in" button, and prompting over the top of it would ask the user
			 * for a signature the app deliberately deferred. `awaitingUserReason` names that state, so it
			 * is a legitimate wait rather than a silent one.
			 */
			const initiate = (): boolean => {
				if (step === 'WalletChosen') {
					runAttempt(selectWallet(askedWalletName, opts));
					return true;
				}
				if (step === 'SignedIn' && readyToSign($connection)) {
					const mayRequestSignature =
						(requestSignatureAutomaticallyIfPossible || opts?.requestSignatureRightAway) &&
						!opts?.requireUserConfirmationBeforeSignatureRequest;
					if (mayRequestSignature) {
						// The narrow remedy: the wallet is already connected on the right account, so the only
						// thing between here and `SignedIn` is the signature. Reconnecting would prompt twice.
						// Failures land on the state as an error, which the subscription below reports.
						runAttempt(requestSignature());
						return true;
					}
					// Nothing started: the pending thing is a click in the app. Reported honestly, so the
					// caller falls through to the wait reasons instead of being told an attempt is running.
					return false;
				}
				runAttempt(
					connect(mechanism, opts, {addressIsPreference: reconnecting, reportUnavailableAddress: !!askedAddress}),
				);
				return true;
			};

			// WHEN AN ATTEMPT MAY BE INITIATED.
			//
			// Not while one is already running (`stepsInProgress`), and not while the user is mid-choice
			// with a picker on screen, since connecting there would hijack their choice. A picker still
			// carrying the error of a previous attempt is the exception: that attempt failed and nothing
			// has driven the flow since, so re-initiating is exactly what the caller asked for. It cannot
			// hijack a choice either, because when a choice is genuinely needed `connect` re-enters the
			// same picker (clearing the stale error) and we keep waiting.
			//
			// Everything else initiates, INCLUDING the resting steps that used to fall through every
			// branch and wait forever: a `WalletChosen` connection asked to connect, and a connection at
			// rest holding an account the caller did not ask for.
			/**
			 * Start an attempt from this state, if one is called for and would not be a repeat.
			 *
			 * Used at entry AND from `evaluate`, which is the fix for an answer that depended on timing:
			 * initiating only at entry meant a call made while some OTHER flow was in progress (a picker
			 * the user was mid-way through, say) got "nothing is in progress" the moment that flow ended
			 * without satisfying it — while the identical call, made one tick later, initiated and
			 * succeeded. Same store, same request, opposite answers.
			 */
			/**
			 * Would attempting AGAINST THIS STATE be wrong, whatever the caller asked for?
			 *
			 * Pulled out because it has to be asked TWICE: once when the attempt is decided on, and again
			 * when a deferred attempt actually runs. The deferral exists precisely because the state moves
			 * in between, so re-checking less than was checked the first time is backwards — and it was:
			 * the microtask used to re-check only the target, so a `useCurrentAccount` store that had
			 * meanwhile started its own connect got a SECOND concurrent one, two `eth_requestAccounts` at
			 * once, and a wallet answering the second with "already processing" would have rejected a call
			 * whose real attempt was still running and about to succeed.
			 */
			const attemptWouldBeWrongNow = (connection: Connection<WalletProviderType>): boolean => {
				if (targetReached(connection) || attemptsInFlight > 0) {
					return true;
				}
				if (stepsInProgress.includes(connection.step)) {
					return true;
				}
				// A picker the user is mid-choice on is theirs, not ours to hijack. One carrying the error
				// of a previous attempt is different: that attempt failed and nothing has driven the flow
				// since, so re-initiating is what the caller asked for.
				const userIsChoosing =
					(connection.step === 'MechanismToChoose' || connection.step === 'WalletToChoose') && !errorOnEntry;
				return userIsChoosing && !opts?.forceConnect && !forceConnect;
			};

			const initiateIfWorthwhile = (
				connection: Connection<WalletProviderType>,
				start: () => boolean = initiate,
			): boolean => {
				if (attemptScheduled || attemptWouldBeWrongNow(connection)) {
					return false;
				}
				if (attemptedAtEvent === walletAnnouncements) {
					return false;
				}
				attemptedAtEvent = walletAnnouncements;
				return start();
			};

			initiateIfWorthwhile($connection);

			/**
			 * WHY WAITING IS LEGITIMATE RIGHT NOW, or `undefined` if it is not.
			 *
			 * The closed list, and the whole of the settle guarantee: every entry is something IN
			 * PROGRESS, and every one of them is published on the connection for the app to render and
			 * for the user to answer. Anything not on this list is not a wait, it is an unanswered
			 * question, and the caller gets an answer instead (see the end of the subscription).
			 *
			 * Deliberately NOT a timeout. A human is in the loop: a timer long enough not to cut someone
			 * off mid-decision is too long to be useful, and it would report "timed out" about a wallet
			 * dialog that is open and healthy.
			 */
			const awaitingUserReason = (connection: Connection<WalletProviderType>): string | undefined => {
				if (attemptsInFlight > 0 || attemptScheduled) {
					// Not inferred from the state: this call started something and it has not come back.
					// Covers the window before an attempt's first publish, which the store cannot show, and
					// the window between deciding to attempt and the microtask that runs it.
					return 'an attempt this call started is still running';
				}
				if (stepsInProgress.includes(connection.step)) {
					return 'an attempt is in progress';
				}
				if (connection.step === 'MechanismToChoose' || connection.step === 'WalletToChoose') {
					return 'the user is choosing';
				}
				if (
					askedAddress &&
					connection.addressUnavailable?.requested.toLowerCase() === askedAddress &&
					// ...and it is still TRUE. A reason that has gone stale (the wallet does offer the
					// account now) licenses a wait that nothing can end: the user has already done the only
					// thing it asks of them. The same freshness test guards the resting branch in `evaluate`,
					// and the two must agree or the disagreement IS the hang.
					!(connection.wallet?.accounts ?? []).some((account) => account.toLowerCase() === askedAddress)
				) {
					// Only OUR request licenses this wait. A reason left on the connection by a different
					// call describes an account this call never asked about, and waiting on somebody else's
					// unanswered question is how a wait becomes unending.
					return 'the wallet is not on the account that was asked for';
				}
				if (targetReached(connection) && !chainIsRight(connection)) {
					return 'the wallet is on another chain';
				}
				if (step === 'SignedIn' && readyToSign(connection)) {
					// The app's own "sign in" button is the pending decision — but only while the connection
					// could actually be asked to sign. On a wallet that has since locked or moved account,
					// `requestSignature()` is not a remedy the user can take, so this is not a wait, and the
					// caller gets an answer instead.
					return 'the signature has not been requested yet';
				}
				return undefined;
			};

			/**
			 * Start an attempt AFTER the current publish, never during it.
			 *
			 * `evaluate` runs inside `set`, and a wallet event does not produce one state: `onAccountChanged`
			 * publishes the new status first and the new accounts second. Starting a connection attempt
			 * from inside the first of those re-enters the store while the handler is still mid-way through
			 * its own transitions, which then continue on top of a state the attempt has replaced — rebuilding
			 * a wallet from one that is no longer there. So the decision is taken synchronously (which is
			 * what keeps the accounting honest) and the work is done once the dust settles, against whatever
			 * state the handler finally left behind.
			 */
			const scheduleAttempt = (): boolean => {
				attemptScheduled = true;
				queueMicrotask(() => {
					attemptScheduled = false;
					if (settled) {
						return;
					}
					// EVERY guard re-applied against the state as it now is, not just the target: the rest of
					// the handler that published may have satisfied the request, started its own attempt, or
					// moved the connection somewhere attempting would be wrong (a popup, an account picker,
					// another wallet). The event guard is NOT re-applied, because this attempt already
					// consumed it when it was scheduled.
					if (attemptWouldBeWrongNow($connection) || !initiate()) {
						evaluate($connection);
					}
				});
				return true;
			};

			/**
			 * Decide, against one state. Called for every publish, AND once more whenever an attempt this
			 * call started comes back, because the last publish may have happened while that attempt was
			 * still running and nothing will publish again afterwards.
			 */
			const evaluate = (connection: Connection<WalletProviderType>) => {
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

				// THE USER DISMISSED the "your wallet is not on that account" state for the address THIS
				// call asked about. Checked before anything else that can return: a decision is an answer
				// whatever else is happening on the connection, and this call may be resting while a
				// DIFFERENT one has the flow in progress — in which case the in-progress branch below would
				// swallow the dismissal, and nothing would publish again to bring it back.
				//
				// Read from the acknowledgement count FOR THAT ADDRESS rather than from the reason
				// disappearing. Several things clear that field and only one of them is a decision; and a
				// decision about one address is not an answer to a request about another.
				if (askedAddress && acknowledgementsFor(askedAddress) !== acknowledgementsOnEntry) {
					cancelled('address-unavailable-acknowledged');
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
					// The reason is COPIED, never re-derived. Deriving it again here from `message` or from
					// `cause` is how the state an app renders and the error a caller catches come to disagree
					// about one event: they are the same failure, so they carry the same label by construction.
					failWith(error.reason, error.message, error.cause);
					return;
				}

				// Reject on disconnect/back to Idle
				if (connection.step === 'Idle' && idlePassed) {
					cancelled('cancelled');
					return;
				}

				// The attempt went back to a resting step without an error: it was aborted (back/cancel).
				// This must never trigger on a resting step we merely started from, hence `attemptStarted`.
				if (attemptStarted && stepsAtRest.includes(connection.step)) {
					cancelled('cancelled');
					return;
				}

				// THE WALLET IS NOT ON THE ACCOUNT THIS CALL ASKED FOR, and the connection is resting on a
				// state that says so. That is the app's to render and the user's to answer, so nothing is
				// attempted while it stands: re-attempting would prompt them again for the account they are
				// being asked to switch to.
				//
				// The moment the wallet DOES offer it, this stops applying and the ordinary rule below picks
				// the request back up, which is what carries the user through without a click in the app.
				const unavailable = connection.addressUnavailable;
				if (
					askedAddress &&
					unavailable?.requested.toLowerCase() === askedAddress &&
					!(connection.wallet?.accounts ?? []).some((account) => account.toLowerCase() === askedAddress)
				) {
					return;
				}

				// A REQUIREMENT THE CALLER NAMED IS UNMET, and no attempt has been made from this state.
				//
				// Re-initiating here, and only here, is the fix for an answer that depended on timing: a
				// call made while some OTHER flow was in progress (an account picker the user was part-way
				// through, say) used to get "nothing is in progress" the moment that flow ended on the wrong
				// account, while the identical call one tick later initiated and succeeded.
				//
				// Deliberately NOT extended to an unmet STEP. A connection that comes to rest below the
				// target has chosen to rest there and the app renders that (a `WalletConnected` state under
				// a `SignedIn` target is waiting for the app's own sign-in button), and re-running `connect`
				// from a state that names no wallet opens the picker — which is `connect`'s meaning, and
				// nobody's idea of what a promise-shaped call should do behind their back.
				if (!walletNameMatches(connection) || (askedAddress && !canActAs(connection, askedAddress))) {
					if (initiateIfWorthwhile(connection, scheduleAttempt)) {
						return;
					}
				}

				// NOTHING IS IN PROGRESS AND NOTHING CAN BE INITIATED: that is an answer, and it is
				// delivered rather than awaited. Silently waiting here is the failure this guard exists to
				// make impossible, and it is stated as a POSITIVE list (`awaitingUserReason`) on purpose:
				// a new step, or a new resting reason, is unreachable-by-default rather than a fresh way
				// to hang.
				const waitReason = awaitingUserReason(connection);
				if (!waitReason) {
					// The message names where the connection actually is, including the wallet's status,
					// because the likeliest way to arrive here is a wallet that went locked or was revoked
					// between the attempt finishing and this state being published.
					const wallet = connection.wallet ? ` (wallet ${connection.wallet.status})` : '';
					// SUPERSEDED, when a NEWER address-bound call is holding the connection's one account
					// slot: this call did not come to rest because the connection cannot get there, it came to
					// rest because the app itself asked for a different account in the meantime. The two are
					// indistinguishable from the state (the newer request took the `addressUnavailable` slot
					// with it, so there is nothing left on the connection to read), and telling them apart is
					// the difference between "this connection is stuck" and "retry, it was your own doing".
					//
					// The MESSAGE is unchanged, deliberately: it is the honest `could not reach ...` this path
					// has always produced, and specifically not a cancellation, because the user decided
					// nothing.
					const superseded =
						askedAddress !== undefined &&
						addressBoundRequestId !== undefined &&
						isSupersededBy(addressBoundRequestId, askedAddress);
					failWith(
						superseded ? 'superseded' : 'unreachable',
						`could not reach ${step}: the connection is at ${connection.step}${wallet} and nothing is in progress`,
					);
				}
			};

			unsubscribe = _store.subscribe(evaluate);
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
			setError({message: `failed to get wallet ${walletName}`, reason: 'failed'});
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
			setConnectionFailure({message: `failed to select wallet ${walletName}`, cause: err, reason: reasonForError(err)});
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
		const doneAsking = (error?: ConnectionError) => {
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
				doneAsking({message, cause: err, reason: reasonForError(err)});
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
			doneAsking({message, cause: err, reason: reasonForError(err)});
			throw err;
		}
	}

	// Method on the store to check if target step is reached
	function storeIsTargetStepReached(connection: Connection<WalletProviderType>): boolean {
		// The same ordered comparison the exported `isTargetStepReached` makes, against this store's
		// configured target. `walletOnly` only bites on a `SignedIn` target: the lower two are
		// wallet-bound by definition.
		return stepIsAtOrBeyond(connection, targetStep, {requireWallet: walletOnly});
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
		acknowledgeAddressUnavailable,
		canActAs: (address: `0x${string}`) => canActAs($connection, address),
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
