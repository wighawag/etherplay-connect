import type {EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';

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
}): CurriedRPC<Methods> & {setWalletProvider: (walletProvider: EIP1193WindowWalletProvider | undefined) => void} & {
	chainId: string;
} {
	const {endpoint, chainId, prioritizeWalletProvider, requestsPerSecond} = params;
	const jsonRPC = createCurriedJSONRPC(endpoint);

	let walletProvider: EIP1193WindowWalletProvider | undefined;

	function setWalletProvider(walletProvider: EIP1193WindowWalletProvider | undefined) {
		walletProvider = walletProvider;
	}

	const provider = {
		request(req: {method: string; params?: any[]}) {
			if (walletProvider) {
				const signingMethod =
					signerMethods.includes(req.method) ||
					connectedAccountMethods.includes(req.method) ||
					walletOnlyMethods.includes(req.method) ||
					req.method.indexOf('sign') != -1;
				if (prioritizeWalletProvider || signingMethod) {
					const currentChainIdAsHex = walletProvider.request({
						method: 'eth_chainId',
					});
					const currentChainId = Number(currentChainIdAsHex).toString();
					if (chainId !== currentChainId) {
						if (signingMethod) {
							return Promise.reject(
								new Error(
									`wallet provider is connected to a different chain, expected ${chainId} but got ${currentChainId}`,
								),
							);
						} else {
							// we fallback on jsonRPc if invalid chain and not a signing method
							return jsonRPC.request(req);
						}
					}
					return walletProvider.request(req as any);
				}
			}

			return jsonRPC.request(req);
		},
	} as unknown as EIP1193WalletProvider;

	return {...createCurriedJSONRPC<Methods>(provider as any, {requestsPerSecond}), setWalletProvider, chainId};
}
