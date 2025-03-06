import type {AlchemyConnectionStore, AlchemyMechanismIncludingRedirects} from '@etherplay/alchemy';
import {handle} from './handler';

const errors: {message: string; canClose: boolean}[] = [];

export let source: MessageEventSource | undefined;
if (window.opener) {
	source = window.opener;
	if (!window.opener.closed) {
		errors.push({
			message: 'Your browser does not seem to support popup, required for authentication.',
			canClose: false,
		});
	} else if (navigator.userAgent.includes('MetaMaskMobile')) {
		errors.push({
			message: 'MetaMask Mobile does not seem to support popup, required for authentication.',
			canClose: false,
		});
	}
} else if (window.parent != window) {
	// TODO delete
	// we should not reach there, this is to be used in a popup
	// source = window.parent;
}

export const url = new URL(location.href);
export const searchParams = url.searchParams;
export const orig = searchParams.get('origin');
export const requestID = searchParams.get('id');
export const type = searchParams.get('type');

export const debug = searchParams.get('debug');
export const emailStr = searchParams.get('email');
export const emailModeStr = searchParams.get('emailMode');
export const emailMode: 'otp' | 'magicLink' | undefined =
	emailModeStr === 'otp' ? 'otp' : emailModeStr === 'magicLink' ? 'magicLink' : undefined;
export const email = emailStr ? decodeURIComponent(emailStr) : undefined;
export const oauth = searchParams.get('oauth-provider') || undefined;
export const oauthConnection = searchParams.get('oauth-connection') || undefined;
export const oauthRedirection = searchParams.get('oauth-redirection') === 'true';
const bundle = searchParams.get('bundle') || undefined;
const orgId = searchParams.get('orgId') || undefined;
const alchemyOrgId = searchParams.get('alchemy-org-id');
const alchemyIdToken = searchParams.get('alchemy-id-token');
const alchemyBundle = searchParams.get('alchemy-bundle');
const alchemyError = searchParams.get('alchemy-error');
const domainRedirectPublicKey = searchParams.get('domain-redirect-public-key') || undefined;

const rpcURL: string | null = searchParams.get('alchemy-api') || import.meta.env.VITE_ALCHEMY_RPC_URL;
const apiKeyNotRecommended: string | null =
	searchParams.get('api-key') || import.meta.env.VITE_ALCHEMY_API_KEY_NOT_RECOMMENDED;

let alchemy:
	| {
			connection: AlchemyConnectionStore;
			from: {
				source?: MessageEventSource;
				origin: string;
				requestID: string;
				domainRedirectPublicKey?: string;
				canCloseAutomatically: boolean;
			};
	  }
	| undefined;

let mechanism: AlchemyMechanismIncludingRedirects | undefined;

if (!type) {
	if (bundle && orgId) {
		mechanism = {
			type: 'magicLink',
			bundle,
			orgId,
		};
	} else {
		errors.push({message: `invalid magic link url`, canClose: true});
	}
	// errors.push({message: `do not support magic links for now`});
} else {
	if (type === 'oauth') {
		if (oauth === 'google' || oauth === 'facebook') {
			if (oauthRedirection) {
				if (!orig || !requestID) {
					// TODO errors.push
					throw new Error(`no origin or requestID`);
				}
				mechanism = {
					type: 'oauth',
					provider: {id: oauth},
					usePopup: false,
				};
			} else {
				mechanism = {
					type: 'oauth',
					provider: {id: oauth},
					usePopup: true,
				};
			}
		} else if (oauth === 'auth0') {
			if (!oauthConnection) {
				errors.push({message: `invalid oauthConnection: ${oauthConnection}`, canClose: true});
			} else {
				if (oauthRedirection) {
					if (!orig || !requestID) {
						// TODO errors.push
						throw new Error(`no origin or requestID`);
					}
					mechanism = {
						type: 'oauth',
						provider: {id: oauth, connection: oauthConnection},
						usePopup: false,
					};
				} else {
					mechanism = {
						type: 'oauth',
						provider: {id: oauth, connection: oauthConnection},
						usePopup: true,
					};
				}
			}
		} else {
			errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
		}
	} else if (type === 'oauth-redirect') {
		if (alchemyError) {
			if (!orig || !requestID) {
				// TODO errors.push
				throw new Error(`no origin or requestID`);
			}
			if (oauth === 'google' || oauth === 'facebook') {
				mechanism = {
					type: 'oauth-redirect',
					provider: {id: oauth},
					error: alchemyError,
					redirection: {
						origin: orig,
						requestID,
					},
				};
			} else if (oauth === 'auth0') {
				if (!oauthConnection) {
					errors.push({message: `invalid oauthConnection: ${oauthConnection}`, canClose: true});
				} else {
					mechanism = {
						type: 'oauth-redirect',
						provider: {id: oauth, connection: oauthConnection},
						error: alchemyError,
						redirection: {
							origin: orig,
							requestID,
						},
					};
				}
			} else {
				errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
			}
		} else if (alchemyBundle && alchemyIdToken && alchemyOrgId && oauth) {
			if (!orig || !requestID) {
				// TODO errors.push
				throw new Error(`no origin or requestID`);
			}
			if (oauth === 'google' || oauth === 'facebook') {
				mechanism = {
					type: 'oauth-redirect',
					provider: {id: oauth},
					redirection: {origin: orig, requestID},
					alchemyOrgId,
					alchemyIdToken,
					alchemyBundle,
				};
			} else if (oauth === 'auth0') {
				if (!oauthConnection) {
					errors.push({message: `invalid oauthConnection: ${oauthConnection}`, canClose: true});
				} else {
					mechanism = {
						type: 'oauth-redirect',
						provider: {id: oauth, connection: oauthConnection},
						redirection: {origin: orig, requestID},
						alchemyOrgId,
						alchemyIdToken,
						alchemyBundle,
					};
				}
			} else {
				errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
			}
		} else {
			errors.push({message: `invalid oauth-redirect`, canClose: true});
		}
	} else if (type === 'email') {
		if (emailMode == 'magicLink') {
			errors.push({message: `magic links are not supported`, canClose: true});
		} else if (emailMode == 'otp') {
			mechanism = {
				type: 'email',
				email,
				mode: emailMode,
			};
		} else {
			errors.push({message: `invalid email mode`, canClose: true});
		}
	} else if (type === 'mnemonic') {
		mechanism = {
			type: 'mnemonic',
			mnemonic: 'test test test test test test test test test test test junk',
			index: undefined,
		};
	}
}

if (errors.length == 0 && orig && (rpcURL || apiKeyNotRecommended) && requestID && mechanism) {
	console.log(`mechanism`, mechanism);
	let canCloseAutomatically = false;
	if (type === 'mnemonic') {
		canCloseAutomatically = true;
	} else if (type === 'email') {
		canCloseAutomatically = true;
	} else if (oauth && !oauthRedirection) {
		canCloseAutomatically = true;
	}

	alchemy = {
		connection: handle({
			mechanism,
			rpcURL,
			apiKeyNotRecommended,
			orig,
			requestID,
		}),
		from: {source, origin: orig, requestID: requestID, domainRedirectPublicKey, canCloseAutomatically},
	};

	if (typeof window !== 'undefined') {
		(window as any).alchemy = alchemy;
	}
} else {
	if (!type) {
		errors.push({message: `type of flow not provided`, canClose: true});
	}
	if (bundle) {
		errors.push({message: `Magic Link Not Supported For now`, canClose: true});
	}
	if (!source) {
		errors.push({message: `launched from an incompatible web-browser.`, canClose: true});

		window.addEventListener('message', (event: MessageEvent) => {
			try {
				console.log('ping?', event.origin, event.source, event.data);
			} catch (err) {
				console.log(`error getting event`);
			}

			if (!source && event.origin === orig) {
				console.log('source:', event.source);
				source = event.source || undefined;
			}
		});
	}
	if (!requestID) {
		errors.push({message: `no requestID provided`, canClose: true});
	}
	if (!orig) {
		errors.push({message: `no origin provided`, canClose: true});
	}
	if (!rpcURL && !apiKeyNotRecommended) {
		errors.push({message: `no rpcURL or apiKey provided`, canClose: true});
	}
}

export {alchemy, errors};
