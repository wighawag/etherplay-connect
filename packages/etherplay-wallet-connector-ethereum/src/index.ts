import type {
	WalletConnector,
	ChainInfo,
	WalletInfo,
	WalletProvider,
	WalletHandle,
	AlwaysOnProviderWrapper,
} from '@etherplay/wallet-connector';
import type {EIP1193ChainId, EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {hashMessage} from './utils.js';
import {createProvider} from './provider.js';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';

export type UnderlyingEthereumProvider = CurriedRPC<Methods>;

interface EIP6963ProviderInfo {
	uuid: string;
	name: string;
	icon: string;
	rdns: string;
}

interface EIP6963ProviderDetail {
	info: EIP6963ProviderInfo;
	provider: EIP1193WindowWalletProvider;
}

export interface EIP6963AnnounceProviderEvent extends CustomEvent {
	type: 'eip6963:announceProvider';
	detail: EIP6963ProviderDetail;
}

export class EthereumWalletConnector implements WalletConnector<CurriedRPC<Methods>> {
	fetchWallets(walletAnnounced: (walletInfo: WalletHandle<CurriedRPC<Methods>>) => void): void {
		if (typeof window !== 'undefined') {
			// const defaultProvider = (window as any).ethereum;
			// console.log(defaultProvider);
			// TODO ?
			(window as any).addEventListener('eip6963:announceProvider', (event: EIP6963AnnounceProviderEvent) => {
				const {detail} = event;
				// const { info, provider } = detail;
				// const { uuid, name, icon, rdns } = info;
				// console.log('provider', provider);
				// console.log(`isDefault: ${provider === defaultProvider}`);
				// console.log('info', info);
				walletAnnounced({
					walletProvider: new EthereumWalletProvider(detail.provider),
					info: detail.info,
				});
			});
			window.dispatchEvent(new Event('eip6963:requestProvider'));
		}
	}

	createAlwaysOnProvider(params: {
		endpoint: string;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
		return createProvider(params);
	}
}

export class EthereumWalletProvider implements WalletProvider<CurriedRPC<Methods>> {
	public readonly underlyingProvider: CurriedRPC<Methods>;
	constructor(protected windowProvider: EIP1193WindowWalletProvider) {
		this.underlyingProvider = createCurriedJSONRPC<Methods>(windowProvider as any);
	}
	async signMessage(message: string, account: `0x${string}`): Promise<`0x${string}`> {
		return this.underlyingProvider.request({
			method: 'personal_sign',
			params: [hashMessage(message), account],
		}) as Promise<`0x${string}`>;
	}

	async getChainId(): Promise<`0x${string}`> {
		return this.underlyingProvider.request({
			method: 'eth_chainId',
		});
	}

	async getAccounts(): Promise<`0x${string}`[]> {
		return this.underlyingProvider.request({
			method: 'eth_accounts',
		});
	}
	async requestAccounts(): Promise<`0x${string}`[]> {
		return this.underlyingProvider.request({
			method: 'eth_requestAccounts',
		});
	}

	listenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		this.windowProvider.on('accountsChanged', handler);
	}
	stopListenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		this.windowProvider.removeListener('accountsChanged', handler);
	}
	listenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		this.windowProvider.on('chainChanged', handler);
	}
	stopListenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		this.windowProvider.removeListener('chainChanged', handler);
	}
	async switchChain(chainId: string): Promise<null | any> {
		const result = await this.underlyingProvider.request({
			method: 'wallet_switchEthereumChain',
			params: [
				{
					chainId: ('0x' + parseInt(chainId).toString(16)) as EIP1193ChainId,
				},
			],
		});
		return result;
	}
	async addChain(chainInfo: ChainInfo): Promise<null | any> {
		const result = await this.underlyingProvider.request({
			method: 'wallet_addEthereumChain',
			params: [
				{
					chainId: chainInfo.chainId,
					rpcUrls: chainInfo.rpcUrls,
					chainName: chainInfo.chainName,
					blockExplorerUrls: chainInfo.blockExplorerUrls,
					iconUrls: chainInfo.iconUrls,
					nativeCurrency: chainInfo.nativeCurrency,
				},
			],
		});
		return result;
	}
}
