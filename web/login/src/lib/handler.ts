import {createAlchemyConnection} from '@etherplay/alchemy';
import type {AlchemyConnectionStore, AlchemyMechanismIncludingRedirects} from '@etherplay/alchemy';

export function handle(
	params: ({rpcURL: string} | {apiKeyNotRecommended: string}) & {
		orig: string;
		requestID: string;
		mechanism: AlchemyMechanismIncludingRedirects;
	}
) {
	const {mechanism, orig, requestID} = params;

	let alchemyConnection: AlchemyConnectionStore;
	if ('rpcURL' in params) {
		alchemyConnection = createAlchemyConnection({alchemy: {rpcURL: params.rpcURL}, autoInitialise: false});
	} else {
		alchemyConnection = createAlchemyConnection({
			alchemy: {apiKeyNotRecommended: params.apiKeyNotRecommended},
			autoInitialise: false,
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
		alchemyConnection.connect(mechanism, {origin: orig, id: requestID});
	} else {
		throw new Error(`Unknown mechanism type: ${(mechanism as any).type}`);
	}

	return alchemyConnection;
}
