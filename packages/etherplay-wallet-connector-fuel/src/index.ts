import type {
	WalletConnector,
	ChainInfo,
	WalletProvider,
	WalletHandle,
	AlwaysOnProviderWrapper,
	AccountGenerator,
	PrivateKeyAccount,
} from '@etherplay/wallet-connector';

export type UnderlyingFuelProvider = any; // TODO

export class FuelWalletConnector implements WalletConnector<UnderlyingFuelProvider> {
	accountGenerator: AccountGenerator = new FuelAccountGenerator();
	fetchWallets(walletAnnounced: (walletInfo: WalletHandle<UnderlyingFuelProvider>) => void): void {
		// TODO
	}

	createAlwaysOnProvider(params: {
		endpoint: string;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<UnderlyingFuelProvider> {
		throw new Error('Method not implemented.');
	}
}

export class FuelAccountGenerator implements AccountGenerator {
	type = 'ethereum';
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount {
		throw new Error('Method not implemented.');
	}
	signTextMessage(message: string, privateKey: `0x${string}`): `0x${string}` {
		throw new Error('Method not implemented.');
	}
}

export class FuelWalletProvider implements WalletProvider<UnderlyingFuelProvider> {
	public readonly underlyingProvider: UnderlyingFuelProvider;
	constructor(protected windowProvider: any) {
		// TODO any
		this.underlyingProvider = windowProvider; // TODO
	}
	async signMessage(message: string, account: `0x${string}`): Promise<`0x${string}`> {
		throw new Error('Method not implemented.');
	}

	async getChainId(): Promise<`0x${string}`> {
		throw new Error('Method not implemented.');
	}

	async getAccounts(): Promise<`0x${string}`[]> {
		throw new Error('Method not implemented.');
	}
	async requestAccounts(): Promise<`0x${string}`[]> {
		throw new Error('Method not implemented.');
	}

	listenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		throw new Error('Method not implemented.');
	}
	stopListenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		throw new Error('Method not implemented.');
	}
	listenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		throw new Error('Method not implemented.');
	}
	stopListenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		throw new Error('Method not implemented.');
	}
	async switchChain(chainId: string): Promise<null | any> {
		throw new Error('Method not implemented.');
	}
	async addChain(chainInfo: ChainInfo): Promise<null | any> {
		throw new Error('Method not implemented.');
	}
}
