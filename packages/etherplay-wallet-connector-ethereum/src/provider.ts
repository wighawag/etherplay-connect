import type {EIP1193Provider, EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {withTimeout} from './utils.js';
import {AlwaysOnProviderWrapper} from '@etherplay/wallet-connector';

const signerMethods = [
	'eth_accounts',
	'eth_sign',
	'eth_signTransaction',
	'personal_sign',
	'eth_signTypedData_v4',
	'eth_signTypedData',
];

const connectedAccountMethods = ['eth_sendTransaction'];

const walletOnlyMethods = ['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];

class AlwaysOnEthereumProviderWrapper implements AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
	public readonly chainId: string;
	public readonly provider: CurriedRPC<Methods>;
	private walletProvider?: CurriedRPC<Methods>;
	private jsonRPC: CurriedRPC<Methods>;
	private status: 'connected' | 'locked' | 'disconnected' = 'disconnected';

	constructor(params: {
		endpoint: string;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}) {
		const self = this;
		this.chainId = params.chainId;
		this.jsonRPC = createCurriedJSONRPC<Methods>(params.endpoint);

		const provider = {
			async request(req: {method: string; params?: any[]}) {
				const signingMethod =
					signerMethods.includes(req.method) ||
					connectedAccountMethods.includes(req.method) ||
					walletOnlyMethods.includes(req.method) ||
					req.method.indexOf('sign') != -1;

				if (self.walletProvider) {
					if (params.prioritizeWalletProvider || signingMethod) {
						if (signingMethod) {
							if (self.status !== 'connected') {
								return Promise.reject({message: 'wallet provider is not connected', code: 4001});
							}
						}

						let currentChainIdAsHex: string;
						try {
							currentChainIdAsHex = await withTimeout(
								self.walletProvider.request({
									method: 'eth_chainId',
								}),
							);
						} catch (err) {
							if (signingMethod) {
								return Promise.reject(err);
							} else {
								// we fallback on jsonRPc if error while getting  chain and not a signing method
								return self.jsonRPC.request(req as any);
							}
						}

						const currentChainId = Number(currentChainIdAsHex).toString();
						if (self.chainId !== currentChainId) {
							if (signingMethod) {
								return Promise.reject({
									message: `wallet provider is connected to a different chain, expected ${self.chainId} but got ${currentChainId}`,
									code: 4001,
								});
							} else {
								// we fallback on jsonRPc if invalid chain and not a signing method
								return self.jsonRPC.request(req as any);
							}
						}
						return self.walletProvider.request(req as any);
					}
				}

				if (signingMethod) {
					return Promise.reject(new Error('wallet provider is not connected'));
				}

				return self.jsonRPC.request(req as any);
			},
		} as unknown as EIP1193Provider;

		this.provider = createCurriedJSONRPC<Methods>(provider, {requestsPerSecond: params.requestsPerSecond});
	}

	setWalletProvider(walletProvider: CurriedRPC<Methods> | undefined) {
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
}): AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
	return new AlwaysOnEthereumProviderWrapper(params);
}
