import type {AlchemyMechanism, OriginAccount} from '@etherplay/alchemy';
import type {WalletConnector, WalletHandle, WalletProvider} from '@etherplay/wallet-connector';
import {EthereumWalletConnector, type UnderlyingEthereumProvider} from '@etherplay/wallet-connector-ethereum';
import {writable} from 'svelte/store';
import {createPopupLauncher, type PopupPromise} from './popup.js';
import {
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	originKeyMessage,
	originPublicKeyPublicationMessage,
} from '@etherplay/alchemy';
import {withTimeout} from './utils.js';

export {fromEntropyKeyToMnemonic, originPublicKeyPublicationMessage, originKeyMessage};
export type {OriginAccount};

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

export type PopupSettings = {
	walletHost: string;
	mechanism: AlchemyMechanism;
	// extraParams?: Record<string, string>;
};

export type WalletMechanism<WalletName extends string | undefined, Address extends `0x${string}` | undefined> = {
	type: 'wallet';
} & (WalletName extends undefined ? {name?: undefined} : {name: WalletName}) &
	(Address extends undefined ? {address?: undefined} : {address: Address});

export type Mechanism = AlchemyMechanism | WalletMechanism<string | undefined, `0x${string}` | undefined>;

export type FullfilledMechanism = AlchemyMechanism | WalletMechanism<string, `0x${string}`>;

export type TargetStep = 'WalletConnected' | 'SignedIn';

export type WalletState<WalletProviderType> = {
	provider: WalletProvider<WalletProviderType>;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`;
	chainId: string;
	invalidChainId: boolean;
	switchingChain: 'addingChain' | 'switchingChain' | false;
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
			mechanism: AlchemyMechanism;
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
			mechanism: AlchemyMechanism;
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

const storageKeyAccount = '__origin_account';
const storageKeyLastWallet = '__last_wallet';

export type ConnectOptions = {
	requireUserConfirmationBeforeSignatureRequest?: boolean;
	doNotStoreLocally?: boolean;
	requestSignatureRightAway?: boolean;
};

export type EnsureConnectedOptions = ConnectOptions & {
	skipChainCheck?: boolean; // Skip chain validation for WalletConnected step
};

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
	requestSignature: () => Promise<void>;
	connectToAddress: (
		address: `0x${string}`,
		options?: {requireUserConfirmationBeforeSignatureRequest: boolean},
	) => void;
	disconnect: () => void;
	getSignatureForPublicKeyPublication: () => Promise<`0x${string}`>;
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
};

export type AnyConnectionStore<WalletProviderType> =
	| ConnectionStore<WalletProviderType, 'SignedIn', true>
	| ConnectionStore<WalletProviderType, 'WalletConnected', true>
	| ConnectionStore<WalletProviderType, 'SignedIn', false>
	| ConnectionStore<WalletProviderType, 'WalletConnected', false>;

// Function overloads for proper typing

// WalletConnected target with custom wallet connector - walletHost optional
export function createConnection<WalletProviderType>(settings: {
	targetStep: 'WalletConnected';
	walletHost?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	autoConnect?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<WalletProviderType, 'WalletConnected'>;

// WalletConnected target with default Ethereum connector - walletHost optional
export function createConnection(settings: {
	targetStep: 'WalletConnected';
	walletHost?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	autoConnect?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<UnderlyingEthereumProvider, 'WalletConnected', true>;

// SignedIn target with walletOnly: true (custom wallet connector) - walletHost optional
export function createConnection<WalletProviderType>(settings: {
	targetStep?: 'SignedIn';
	walletOnly: true;
	walletHost?: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<WalletProviderType, 'SignedIn', true>;

// SignedIn target with walletOnly: true (default Ethereum connector) - walletHost optional
export function createConnection(settings: {
	targetStep?: 'SignedIn';
	walletOnly: true;
	walletHost?: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', true>;

// SignedIn target (explicit) with custom wallet connector - walletHost required
export function createConnection<WalletProviderType>(settings: {
	targetStep?: 'SignedIn';
	walletOnly?: false;
	walletHost: string;
	chainInfo: ChainInfo<WalletProviderType>;
	walletConnector: WalletConnector<WalletProviderType>;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<WalletProviderType, 'SignedIn', false>;

// SignedIn target (default) with default Ethereum connector - walletHost required
export function createConnection(settings: {
	targetStep?: 'SignedIn';
	walletOnly?: false;
	walletHost: string;
	chainInfo: ChainInfo<UnderlyingEthereumProvider>;
	walletConnector?: undefined;
	signingOrigin?: string;
	autoConnect?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<UnderlyingEthereumProvider, 'SignedIn', false>;

// Implementation signature
export function createConnection<WalletProviderType = UnderlyingEthereumProvider>(settings: {
	targetStep?: TargetStep;
	walletOnly?: boolean;
	signingOrigin?: string;
	walletHost?: string;
	autoConnect?: boolean;
	walletConnector?: WalletConnector<WalletProviderType>;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	chainInfo: ChainInfo<WalletProviderType>;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): ConnectionStore<WalletProviderType, TargetStep, boolean> {
	function originToSignWith() {
		return settings.signingOrigin || origin;
	}

	const walletConnector =
		settings.walletConnector || (new EthereumWalletConnector() as unknown as WalletConnector<WalletProviderType>);
	const alwaysOnChainId = '' + settings.chainInfo.id;
	const alwaysOnProviderWrapper = walletConnector.createAlwaysOnProvider({
		endpoint:
			'provider' in settings.chainInfo ? settings.chainInfo.provider : settings.chainInfo.rpcUrls.default.http[0],
		chainId: '' + settings.chainInfo.id,
		prioritizeWalletProvider: settings.prioritizeWalletProvider,
		requestsPerSecond: settings.requestsPerSecond,
	});
	// Determine target step (defaults to 'SignedIn')
	const targetStep: TargetStep = settings.targetStep || 'SignedIn';

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

	let _wallet: {provider: WalletProvider<WalletProviderType>; chainId: string} | undefined;

	let popup: PopupPromise<OriginAccount> | undefined;

	function fetchWallets() {
		walletConnector.fetchWallets((detail) => {
			const existingWallets = $connection.wallets;
			existingWallets.push(detail);

			set({
				...$connection,
				wallets: existingWallets,
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
							| AlchemyMechanism
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
				if ($connection.wallet && settings?.alwaysUseCurrentAccount) {
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
										!settings?.alwaysUseCurrentAccount && !specificAddress && accounts.length > 1
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
									set({
										step: 'MechanismToChoose',
										wallets: $connection.wallets,
										wallet: undefined,
										error: {message: 'could not get any accounts'},
									});
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
									!settings?.alwaysUseCurrentAccount && !specificAddress && accounts.length > 1
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
							set({
								step: 'MechanismToChoose',
								wallets: $connection.wallets,
								wallet: undefined,
								error: {message: `failed to connect to wallet`, cause: err},
							});
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						set({
							step: 'MechanismToChoose',
							wallets: $connection.wallets,
							wallet: undefined,
							error: {message: `failed to get wallet ${walletName}`},
						});
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
				popup = connectViaPopup({
					mechanism,
					walletHost: settings.walletHost,
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
					set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
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
				if (!idlePassed || forceConnect) {
					connect(mechanism, opts);
				}
				const unsubscribe = _store.subscribe((connection) => {
					// Reject on disconnect/back to Idle
					if (connection.step === 'Idle' && idlePassed) {
						unsubscribe();
						reject(new Error('Connection cancelled'));
					}
					if (!idlePassed && connection.step !== 'Idle') {
						idlePassed = true;
					}
					// Check full resolution conditions including chain validity
					if (canResolve(connection)) {
						unsubscribe();
						resolve(connection as any);
					}
				});
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

			if (popupSettings.mechanism.provider.id === 'auth0') {
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

		if (settings.signingOrigin) {
			entriesToAdd.push(['signingOrigin', settings.signingOrigin]);
		}

		for (const entryToAdd of entriesToAdd) {
			popupURL.searchParams.append(entryToAdd[0], entryToAdd[1]);
		}
		return popupLauncher.launchPopup(popupURL.toString(), {fullWindow});
	}

	function cancel() {
		popup?.cancel();
		deleteLastWallet();
		set({step: 'Idle', wallet: undefined, loading: false, wallets: $connection.wallets});
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

	// Determine walletOnly (defaults to false, but true implies WalletConnected target behavior for mechanism)
	const walletOnly = settings.walletOnly || targetStep === 'WalletConnected';

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
		requestSignature,
		connectToAddress,
		disconnect,
		getSignatureForPublicKeyPublication,
		switchWalletChain,
		unlock,
		ensureConnected: ensureConnected as any, // Cast to bypass complex conditional typing
		isTargetStepReached: storeIsTargetStepReached as any, // Cast for type guard
		targetStep,
		walletOnly,
		provider: alwaysOnProviderWrapper.provider,
		chainId: '' + settings.chainInfo.id,
		chainInfo: settings.chainInfo,
	};

	return store as ConnectionStore<WalletProviderType, TargetStep, boolean>;
}
