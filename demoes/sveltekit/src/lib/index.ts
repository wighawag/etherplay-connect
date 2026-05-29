import { PUBLIC_WALLET_HOST } from '$env/static/public';
import { createConnection } from '@etherplay/connect';
import { EthereumWalletConnector } from '@etherplay/wallet-connector-ethereum';
import { get } from 'svelte/store';

export const chainInfos = {
	1: {
		id: 1,
		rpcUrls: { default: { http: ['https://eth.drpc.org'] } },
		chainName: 'Ethereum',
		nativeCurrency: {
			name: 'Ether',
			symbol: 'ETH',
			decimals: 18
		},
		blockExplorerUrls: { default: { url: 'https://etherscan.io' } }
	},
	8453: {
		id: 8453,
		rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
		chainName: 'Base',
		nativeCurrency: {
			name: 'Ether',
			symbol: 'ETH',
			decimals: 18
		},
		blockExplorerUrls: { default: { url: 'https://basescan.org' } }
	}
};

export const chainId = '1';
export const chainInfo = chainInfos[chainId];

// Enable the Same-Origin Callback Bridge (domain-redirect fallback) for the
// oauth-redirection flow only when the page is loaded with `?domainRedirectBridge=true`.
// Requires hosting `/_etherplay_accounts.html`.
const domainRedirectBridge =
	typeof window !== 'undefined' &&
	new URLSearchParams(window.location.search).get('domainRedirectBridge') === 'true';

export const connection = createConnection({
	walletHost: PUBLIC_WALLET_HOST,
	chainInfo,
	prioritizeWalletProvider: true,
	requestSignatureAutomaticallyIfPossible: true,
	autoConnect: true,
	domainRedirectBridge
});

connection.subscribe((c) =>
	console.log(c.step, (c as any).loading, (c as any).walletAccountChanged)
);

(globalThis as any).connection = connection;
(globalThis as any).get = get;
