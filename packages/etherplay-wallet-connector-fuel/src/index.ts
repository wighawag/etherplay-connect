import type {
	WalletConnector,
	ChainInfo,
	WalletProvider,
	WalletHandle,
	AlwaysOnProviderWrapper,
	AccountGenerator,
	PrivateKeyAccount,
} from '@etherplay/wallet-connector';

import {Wallet, Fuel, FuelConnector} from 'fuels';
import {defaultConnectors} from '@fuels/connectors';

export type UnderlyingFuelProvider = FuelConnector;

async function _fetchWallets(
	walletAnnounced: (walletHandle: WalletHandle<UnderlyingFuelProvider>) => void,
): Promise<void> {
	const fuel = new Fuel({
		connectors: defaultConnectors({devMode: true}),
	});
	// await fuel.selectConnector('Fuel Wallet');

	if (await fuel.hasConnector()) {
		const connectors = await fuel.connectors();
		for (const connector of connectors) {
			const image =
				typeof connector.metadata?.image === 'object'
					? connector.metadata.image?.dark
					: connector.metadata?.image || ''; // TODO image missing ?

			walletAnnounced({
				walletProvider: new FuelWalletProvider(connector),
				info: {
					uuid: connector.name,
					name: connector.name,
					icon: image,
					rdns: connector.metadata.install.link, // TODO rdns ?
				},
			});
		}
	}
}

export class FuelWalletConnector implements WalletConnector<UnderlyingFuelProvider> {
	accountGenerator: AccountGenerator = new FuelAccountGenerator();
	fetchWallets(walletAnnounced: (walletInfo: WalletHandle<UnderlyingFuelProvider>) => void): void {
		_fetchWallets(walletAnnounced);
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
		const path = `m/44'/1179993420'/0'/0/${index}`;
		const wallet = Wallet.fromMnemonic(mnemonic, path);
		return {
			// TODO should we allow string or force `0x` prefixed string?
			privateKey: wallet.privateKey as `0x${string}`,
			publicKey: wallet.publicKey as `0x${string}`,
			address: wallet.publicKey as `0x${string}`,
		};
	}
	async signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`> {
		const wallet = Wallet.fromPrivateKey(privateKey);
		const signature = await wallet.signMessage(message);

		// TODO should we allow string or force `0x` prefixed string?
		return signature as `0x${string}`;
	}
}

export class FuelWalletProvider implements WalletProvider<UnderlyingFuelProvider> {
	public readonly underlyingProvider: UnderlyingFuelProvider;
	constructor(protected windowProvider: UnderlyingFuelProvider) {
		// TODO any
		this.underlyingProvider = windowProvider; // TODO
	}
	async signMessage(message: string, account: `0x${string}`): Promise<`0x${string}`> {
		const signature = await this.underlyingProvider.signMessage(message, account);
		// TODO should we allow string or force `0x` prefixed string?
		return signature as `0x${string}`;
	}

	async getChainId(): Promise<`0x${string}`> {
		const network = await this.underlyingProvider.currentNetwork();
		// TODO chainId are hex ?
		return `0x${network.chainId.toString(16)}`;
	}

	async getAccounts(): Promise<`0x${string}`[]> {
		const accounts = await this.underlyingProvider.accounts();

		// TODO should we allow string or force `0x` prefixed string?
		return accounts as `0x${string}`[];
	}
	async requestAccounts(): Promise<`0x${string}`[]> {
		const connected = await this.underlyingProvider.connect();
		if (connected) {
			return this.getAccounts();
		}
		throw new Error('Failed to connect to Fuel Wallet');
	}

	listenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		// TODO throw new Error('Method not implemented.');
	}
	stopListenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		// TODO throw new Error('Method not implemented.');
	}
	listenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		// TODO throw new Error('Method not implemented.');
	}
	stopListenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		// TODO throw new Error('Method not implemented.');
	}
	async switchChain(chainId: string): Promise<null | any> {
		throw new Error('Method not implemented.');
	}
	async addChain(chainInfo: ChainInfo): Promise<null | any> {
		throw new Error('Method not implemented.');
	}
}
