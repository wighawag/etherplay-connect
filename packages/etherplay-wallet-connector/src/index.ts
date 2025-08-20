export type WalletHandle<UnderlyingProvider> = {
	walletProvider: WalletProvider<UnderlyingProvider>;
	info: WalletInfo;
};
export type WalletInfo = {uuid: string; name: string; icon: string; rdns: string};
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
		endpoint: string;
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

export interface AlwaysOnProviderWrapper<WalletProviderType> {
	setWalletProvider: (walletProvider: WalletProviderType | undefined) => void;
	setWalletStatus: (newStatus: 'connected' | 'locked' | 'disconnected') => void;

	// TODO replace with a ChainConnection type that expose the chainId and provider but also the full chainInfo ?
	chainId: string;
	provider: WalletProviderType;
}

export interface ChainConnection<WalletProviderType> {
	chainId: string;
	provider: WalletProviderType;
}
