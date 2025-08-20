import {AlwaysOnProviderWrapper} from '@etherplay/wallet-connector';
import type {UnderlyingFuelProvider} from './types.js';
import {FuelConnector, Provider} from 'fuels';

class AlwaysOnFuelProviderWrapper implements AlwaysOnProviderWrapper<UnderlyingFuelProvider> {
	public readonly chainId: string;
	public readonly provider: UnderlyingFuelProvider;
	private walletProvider?: FuelConnector;
	private jsonRPC: Provider;
	private status: 'connected' | 'locked' | 'disconnected' = 'disconnected';

	constructor(params: {
		endpoint: string;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}) {
		const self = this;
		this.chainId = params.chainId;
		const provider = new Provider(params.endpoint);
		const connector = new Proxy(
			{},
			{
				get(target, prop) {
					if (self.walletProvider) {
						return (self.walletProvider as any)[prop];
					} else {
						throw new Error('No wallet connected');
					}
				},
			},
		) as FuelConnector;
		this.jsonRPC = provider;

		// TODO signing methods + priority to wallet
		this.provider = connector;
	}

	setWalletProvider(walletProvider: UnderlyingFuelProvider | undefined) {
		this.walletProvider = walletProvider;
	}

	setWalletStatus(newStatus: 'connected' | 'locked' | 'disconnected') {
		this.status = newStatus;
	}
}

export function createProvider(params: {
	endpoint: string;
	chainId: string;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): AlwaysOnProviderWrapper<UnderlyingFuelProvider> {
	return new AlwaysOnFuelProviderWrapper(params);
}
