import {createAlchemyConnection} from '@etherplay/alchemy';
import type {AlchemyConnectionStore, AlchemyMechanismIncludingRedirects} from '@etherplay/alchemy';
import type {AccountGenerator} from '@etherplay/wallet-connector';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';

export function handle(
	params: ({rpcURL: string} | {apiKeyNotRecommended: string}) & {
		windowOrigin: string;
		signingOrigin: string;
		requestID: string;
		mechanism: AlchemyMechanismIncludingRedirects;
		accountType: string;
	}
) {
	const {mechanism, windowOrigin, signingOrigin, requestID, accountType} = params;

	// TODO option to pass custom accountGenerator ?
	let accountGenerator: AccountGenerator | undefined = undefined;
	if (accountType === 'ethereum') {
		accountGenerator = new EthereumAccountGenerator();
	} else {
		throw new Error(`Unsupported account type: ${accountType}`);
	}

	let alchemyConnection: AlchemyConnectionStore;
	if ('rpcURL' in params) {
		alchemyConnection = createAlchemyConnection({
			alchemy: {rpcURL: params.rpcURL},
			autoInitialise: false,
			accountGenerator,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	} else {
		alchemyConnection = createAlchemyConnection({
			alchemy: {apiKeyNotRecommended: params.apiKeyNotRecommended},
			autoInitialise: false,
			accountGenerator,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	}

	alchemyConnection.subscribe((v) => console.log(v?.step));

	if (mechanism.type === 'oauth-redirect') {
		if ('error' in mechanism) {
			window.close();
		} else {
			alchemyConnection.completeOAuthWithBundle(
				mechanism,
				mechanism.alchemyBundle,
				mechanism.alchemyOrgId,
				mechanism.alchemyIdToken
			);
		}
	} else if (mechanism.type === 'magicLink') {
		// TODO ?
		// alchemyConnection.completeEmailLoginViaBundle(mechanism.bundle, mechanism.orgId);
	} else if (mechanism.type === 'mnemonic' || mechanism.type === 'email' || mechanism.type === 'oauth') {
		alchemyConnection.connect(mechanism, {windowOrigin, signingOrigin, id: requestID});
	} else {
		throw new Error(`Unknown mechanism type: ${(mechanism as any).type}`);
	}

	return alchemyConnection;
}
