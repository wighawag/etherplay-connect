import { PUBLIC_WALLET_HOST } from '$env/static/public';
import { createConnection } from '@etherplay/connect';
import { EthereumWalletConnector } from '@etherplay/wallet-connector-ethereum';
import { get } from 'svelte/store';

export const chainInfos = {
	1: {
		rpcUrls: ['https://eth.drpc.org'],

		chainName: 'Ethereum',
		nativeCurrency: {
			name: 'Ether',
			symbol: 'ETH',
			decimals: 18
		},
		blockExplorerUrls: ['https://etherscan.io']
	},
	8453: {
		rpcUrls: ['https://mainnet.base.org'],
		chainName: 'Base',
		nativeCurrency: {
			name: 'Ether',
			symbol: 'ETH',
			decimals: 18
		},
		blockExplorerUrls: ['https://basescan.org']
	}
};

export const chainId = '1';
export const chainInfo = chainInfos[chainId];
export const connection = createConnection({
	walletHost: PUBLIC_WALLET_HOST,
	walletConnector: new EthereumWalletConnector(),
	node: {
		chainId,
		url: chainInfo.rpcUrls[0],
		prioritizeWalletProvider: true
	},
	requestSignatureAutomaticallyIfPossible: true,
	autoConnect: true
});

connection.subscribe((c) =>
	console.log(c.step, (c as any).loading, (c as any).walletAccountChanged)
);

(globalThis as any).connection = connection;
(globalThis as any).get = get;
