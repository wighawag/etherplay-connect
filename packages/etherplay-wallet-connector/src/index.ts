export type WalletHandle<UnderlyingProvider> = {
	walletProvider: WalletProvider<UnderlyingProvider>;
	info: WalletInfo;
};
export type WalletInfo = {
	uuid: string;
	name: string;
	icon: string;
	rdns: string;
	/**
	 * This wallet ANSWERS BY ITSELF: it puts nothing on the user's screen and waits for nobody.
	 *
	 * A declaration, beside the name and the icon, because it is the same kind of fact: something
	 * only the wallet knows and every consumer would otherwise have to re-infer. An app that renders
	 * "your wallet will ask you to confirm this in a moment", a connect prompt, or an account picker
	 * is describing an interaction that, for such a wallet, never happens, and it cannot tell from the
	 * outside: a generated in-tab key and a browser extension expose the same provider surface.
	 *
	 * ABSENT MEANS LOUD. Every wallet this library discovers over EIP-6963 is an ordinary wallet that
	 * may prompt, so the field is optional and its absence is the existing behaviour. Only a wallet
	 * that is CONSTRUCTED with a key it holds itself (a chain running in the tab, a burner signer,
	 * a server-side custodian answering over RPC) can honestly set it.
	 *
	 * Polarity is deliberate. `autoApproves` is the exceptional claim, so the safe reading
	 * (`if (info.autoApproves)`) is also the correct one when the field is missing. A field named
	 * `prompts` would make the common case the one nobody writes, and `!info.prompts` would then read
	 * "never prompts" about every ordinary wallet in existence. Use `walletPrompts(info)` to ask the
	 * question the other way round without repeating the polarity.
	 *
	 * It says nothing about SPEED and nothing about TRUST: a wallet that answers instantly because it
	 * holds the key is still the thing signing, and a user who cannot see the request cannot refuse
	 * it. It is exactly the claim "there is no dialog to wait for", and `@etherplay/connect` acts on
	 * it in exactly one way: it does not announce a `PendingRequest` for a wallet that makes it.
	 */
	autoApproves?: boolean;
};

/**
 * Will this wallet put something on the user's screen that they have to answer?
 *
 * The question consumers actually ask, written once so that the default ("yes, assume it does")
 * lives in one place rather than at every `!info.autoApproves` in every app. An unknown wallet
 * prompts: that is the assumption every wallet UI was written under, and the only safe one.
 */
export function walletPrompts(info: WalletInfo | undefined): boolean {
	return !info?.autoApproves;
}

export type ChainInfo = Readonly<{
	chainId: `0x${string}`;
	rpcUrls?: readonly string[];
	blockExplorerUrls?: readonly string[];
	chainName?: string;
	iconUrls?: readonly string[];
	nativeCurrency?: Readonly<{
		name: string;
		symbol: string;
		decimals: number;
	}>;
}>;

export type PrivateKeyAccount = {address: `0x${string}`; publicKey: `0x${string}`; privateKey: `0x${string}`};

export interface AccountGenerator {
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount;
	signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`>;
	type: string;
}

export interface WalletConnector<UnderlyingProvider> {
	fetchWallets(walletAnnounced: (walletHandle: WalletHandle<UnderlyingProvider>) => void): void;
	createAlwaysOnProvider(params: {
		endpoint: string | UnderlyingProvider;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<UnderlyingProvider>;
	accountGenerator: AccountGenerator;
}

export interface BasicWalletProvider<UnderlyingProvider> {
	underlyingProvider: UnderlyingProvider;
	signMessage: (message: string, account: `0x${string}`) => Promise<`0x${string}`>;
	getChainId: () => Promise<`0x${string}`>;
	requestAccounts: () => Promise<`0x${string}`[]>;
	getAccounts: () => Promise<`0x${string}`[]>;
}

export interface WalletProvider<UnderlyingProvider> extends BasicWalletProvider<UnderlyingProvider> {
	listenForAccountsChanged: (handler: (accounts: `0x${string}`[]) => void) => void;
	stopListenForAccountsChanged: (handler: (accounts: `0x${string}`[]) => void) => void;
	listenForChainChanged: (handler: (chainId: `0x${string}`) => void) => void;
	stopListenForChainChanged: (handler: (chainId: `0x${string}`) => void) => void;
	switchChain: (chainId: `0x${string}`) => Promise<null | any>;
	addChain(chainInfo: ChainInfo): Promise<null | any>;
}

// Transaction methods (require sending or signing a transaction)
export const TRANSACTION_METHODS = ['eth_sendTransaction', 'eth_signTransaction'] as const;
export type TransactionMethod = (typeof TRANSACTION_METHODS)[number];

// Signature methods (require signing a message)
export const SIGNATURE_METHODS = ['personal_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_sign'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

// Combined tracked methods
export const TRACKED_REQUEST_METHODS = [...TRANSACTION_METHODS, ...SIGNATURE_METHODS] as const;
export type TrackedRequestMethod = TransactionMethod | SignatureMethod;

export type PendingRequestKind = 'transaction' | 'signature';

/**
 * WHY the connection is asking, when the connection is the one asking.
 *
 * `kind` says a signature is outstanding; it cannot say which one, and "your wallet is asking for
 * something" is a much weaker sentence than naming what. A delegation in particular grants a
 * browser key authority to act for the account, which is the request a careful user is most right
 * to refuse when it arrives unexplained.
 *
 * ABSENT means the app asked directly through `connection.provider`, where the app already knows
 * what it sent and does not need to be told. Only requests this library originates carry a purpose.
 */
export type RequestPurpose = 'delegation' | 'public-key-publication';

// Discriminated union for PendingRequest - ensures method and kind are properly paired
export type PendingRequest =
	| {
			id: string;
			method: TransactionMethod;
			kind: 'transaction';
			startedAt: number;
			purpose?: RequestPurpose;
			/** See the `account` note below. The `from` of the transaction. */
			account?: `0x${string}`;
	  }
	| {
			id: string;
			method: SignatureMethod;
			kind: 'signature';
			startedAt: number;
			purpose?: RequestPurpose;
			/**
			 * WHO is expected to answer this: the signer of a signature, the `from` of a transaction.
			 *
			 * A pending request can OUTLIVE the wallet state it started under, because the user is free
			 * to switch wallet or account while one is outstanding, and the request stays with the wallet
			 * that is actually holding it. Without this, a consumer rendering "approve this in your
			 * wallet" would point the user at whichever wallet is current, which after a swap is the wrong
			 * one and cannot answer it.
			 *
			 * Compare it against the connected account to tell "your wallet is asking" from "something is
			 * still outstanding on an account you have moved away from", which need different words.
			 *
			 * Optional because it is read out of the request, and a caller is not obliged to make one this
			 * layer can read.
			 */
			account?: `0x${string}`;
	  };

export type RequestEventType = 'requestStart' | 'requestEnd';

export type RequestResult = 'success' | 'error' | 'rejected';

export interface RequestEvent {
	type: RequestEventType;
	request: PendingRequest;
	result?: RequestResult; // Only present on 'requestEnd'
	error?: unknown; // Only present on 'requestEnd' with 'error' result
}

export type RequestEventHandler = (event: RequestEvent) => void;

export interface AlwaysOnProviderWrapper<WalletProviderType> {
	setWalletProvider: (walletProvider: WalletProviderType | undefined) => void;
	setWalletStatus: (newStatus: 'connected' | 'locked' | 'disconnected') => void;

	/**
	 * Ask the connected wallet to sign text, ANNOUNCED.
	 *
	 * This exists so that a signature the library itself needs is reported like any other wallet
	 * request: `onRequest` fires and `getPendingRequests()` lists it for its whole duration. See
	 * `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md` — a request the user must
	 * answer and the app cannot see is a request nothing can explain, cancel or recover from.
	 *
	 * It is a SEPARATE surface from `provider.request` rather than a call through it because the
	 * always-on provider speaks for ONE chain and refuses signing methods when the wallet is
	 * elsewhere. A text signature is chain-independent, and `getDelegation` is explicitly allowed to
	 * mint a credential for a chain other than the connection's, so that guard would reject requests
	 * that are correct.
	 *
	 * @param options.purpose what this signature is FOR, surfaced on the pending request
	 */
	signMessage: (
		message: string,
		account: `0x${string}`,
		options?: {purpose?: RequestPurpose},
	) => Promise<`0x${string}`>;

	/**
	 * Requests currently with the user's wallet.
	 *
	 * AUTHORITATIVE, and the reason it is exposed rather than left to `onRequest` alone: a consumer
	 * rebuilding wallet state mid-request must ask for the current list rather than assume an empty
	 * one. Assuming empty erases a request that is still outstanding, and nothing repopulates it,
	 * because the next event for that request is the one that ends it.
	 */
	getPendingRequests: () => PendingRequest[];

	// TODO replace with a ChainConnection type that expose the chainId and provider but also the full chainInfo ?
	chainId: string;
	provider: WalletProviderType;

	// Event subscription for request tracking
	onRequest: (handler: RequestEventHandler) => () => void; // Returns unsubscribe function
}

export interface ChainConnection<WalletProviderType> {
	chainId: string;
	provider: WalletProviderType;
}
