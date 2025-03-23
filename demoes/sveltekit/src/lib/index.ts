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

import { PUBLIC_WALLET_HOST } from '$env/static/public';
import { createConnection } from '@etherplay/connect';

export const chainId = '8453';
export const chainInfo = chainInfos[chainId];
export const connection = createConnection({
	walletHost: PUBLIC_WALLET_HOST,
	node: {
		chainId,
		url: chainInfo.rpcUrls[0],
		prioritizeWalletProvider: true
	}
});

connection.subscribe((c) =>
	console.log(c.step, (c as any).loading, (c as any).walletAccountChanged)
);
