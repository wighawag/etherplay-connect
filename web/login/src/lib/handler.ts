import {createAlchemyConnection} from 'etherplay-alchemy';
import type {AlchemyConnectionStore, AlchemyMechanismIncludingRedirects} from 'etherplay-alchemy';

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
		// alchemyConnection.completeEmailLoginViaBundle(mechanism.bundle, mechanism.orgId);
	} else if (mechanism.type === 'mnemonic') {
		// alchemyConnection.startFakeLoginProcess();
	} else if (mechanism.type === 'email') {
		// if (mechanism.email) {
		// 	alchemyConnection.startEmailLoginProcess(mechanism.email, mechanism.mode);
		// } else {
		// 	alchemyConnection.setupEmailloginProcess(mechanism.mode);
		// }
	} else if (mechanism.type === 'oauth') {
		// if (!mechanism.usePopup) {
		// 	alchemyConnection.startSocialLoginProcess(mechanism.provider, {origin: orig, id: requestID});
		// } else {
		// 	alchemyConnection.startSocialLoginProcess(mechanism.provider);
		// }
	} else {
		throw new Error(`Unknown mechanism type: ${(mechanism as any).type}`);
	}

	return alchemyConnection;
}
