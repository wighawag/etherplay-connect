import type {EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {withTimeout} from './utils.js';

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

export function createProvider(params: {
	endpoint: string;
	chainId: string;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): CurriedRPC<Methods> & {
	setWalletProvider: (walletProvider: EIP1193WindowWalletProvider | undefined) => void;
	setWalletStatus: (newStatus: 'connected' | 'locked' | 'disconnected') => void;
} & {
	chainId: string;
} {
	const {endpoint, chainId, prioritizeWalletProvider, requestsPerSecond} = params;
	const jsonRPC = createCurriedJSONRPC(endpoint);

	let walletProvider: EIP1193WindowWalletProvider | undefined;
	let status: 'connected' | 'locked' | 'disconnected' = 'disconnected';

	function setWalletProvider(newWalletProvider: EIP1193WindowWalletProvider | undefined) {
		walletProvider = newWalletProvider;
	}
	function setWalletStatus(newStatus: 'connected' | 'locked' | 'disconnected') {
		status = newStatus;
	}

	const provider = {
		async request(req: {method: string; params?: any[]}) {
			const signingMethod =
				signerMethods.includes(req.method) ||
				connectedAccountMethods.includes(req.method) ||
				walletOnlyMethods.includes(req.method) ||
				req.method.indexOf('sign') != -1;

			if (walletProvider) {
				if (prioritizeWalletProvider || signingMethod) {
					if (signingMethod) {
						if (status !== 'connected') {
							return Promise.reject({message: 'wallet provider is not connected', code: 4001});
						}
					}

					let currentChainIdAsHex: string;
					try {
						currentChainIdAsHex = await withTimeout(
							walletProvider.request({
								method: 'eth_chainId',
							}),
						);
					} catch (err) {
						if (signingMethod) {
							return Promise.reject(err);
						} else {
							// we fallback on jsonRPc if error while getting  chain and not a signing method
							return jsonRPC.request(req);
						}
					}

					const currentChainId = Number(currentChainIdAsHex).toString();
					if (chainId !== currentChainId) {
						if (signingMethod) {
							return Promise.reject({
								message: `wallet provider is connected to a different chain, expected ${chainId} but got ${currentChainId}`,
								code: 4001,
							});
						} else {
							// we fallback on jsonRPc if invalid chain and not a signing method
							return jsonRPC.request(req);
						}
					}
					return walletProvider.request(req as any);
				}
			}

			if (signingMethod) {
				return Promise.reject(new Error('wallet provider is not connected'));
			}

			return jsonRPC.request(req);
		},
	} as unknown as EIP1193WalletProvider;

	const curriedRPC = createCurriedJSONRPC<Methods>(provider as any, {requestsPerSecond});
	return {...curriedRPC, setWalletProvider, setWalletStatus, chainId};
}
