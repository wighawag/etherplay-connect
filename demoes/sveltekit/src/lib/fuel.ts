import { PUBLIC_WALLET_HOST } from '$env/static/public';
import { createConnection } from '@etherplay/connect';
import { get } from 'svelte/store';
import { FuelWalletConnectorFactory } from '@etherplay/wallet-connector-fuel';

export const connection = createConnection({
	walletHost: PUBLIC_WALLET_HOST,
	walletConnectorFactory: FuelWalletConnectorFactory,
	node: {
		chainId: '1', // TODO
		url: 'https://mainnet.fuel.network/v1/graphql',
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
