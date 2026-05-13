import type {AuthMechanism, AuthProvider} from '@etherplay/connect-core';
import {createAuthProvider} from './handler';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';

const errors: {message: string; canClose: boolean}[] = [];

export const source: MessageEventSource | undefined = window.opener || undefined;

if ((!source || window.opener.closed) && navigator.userAgent.includes('MetaMaskMobile')) {
	errors.push({
		message: 'MetaMask Mobile does not seem to support popup, required for authentication.',
		canClose: false,
	});
} else if (window.opener) {
	if (window.opener.closed) {
		errors.push({
			message: 'Your browser does not seem to support popup, required for authentication.',
			canClose: false,
		});
	}
} else if (window.parent != window) {
}

export const url = new URL(location.href);
export const searchParams = url.searchParams;
export const windowOrigin = searchParams.get('origin');
export const signingOrigin = searchParams.get('signingOrigin');
export const requestID = searchParams.get('id');
export const type = searchParams.get('type');

export const debug = searchParams.get('debug');
export const emailStr = searchParams.get('email');
export const emailModeStr = searchParams.get('emailMode');
export const emailMode: 'otp' | undefined = emailModeStr === 'otp' ? 'otp' : undefined;
export const email = emailStr ? decodeURIComponent(emailStr) : undefined;
export const oauth = searchParams.get('oauth-provider') || undefined;
export const oauthConnection = searchParams.get('oauth-connection') || undefined;
export const oauthRedirection = searchParams.get('oauth-redirection') === 'true';
const domainRedirectPublicKey = searchParams.get('domain-redirect-public-key') || undefined;
const accountType = searchParams.get('account-type') || 'ethereum';

const authProviderType = searchParams.get('provider') || import.meta.env.VITE_AUTH_PROVIDER || 'openfort';

let mechanism: AuthMechanism | undefined;

if (!type) {
	errors.push({message: `no auth type provided`, canClose: true});
} else {
	if (type === 'oauth') {
		if (oauth === 'google' || oauth === 'facebook') {
			if (oauthRedirection) {
				if (!windowOrigin || !requestID) {
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
					if (!windowOrigin || !requestID) {
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
		errors.push({message: `oauth-redirect to be implemented`, canClose: true});
	} else if (type === 'email') {
		if (emailMode == 'otp') {
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
			mnemonic: import.meta.env.VITE_DEV_MNEMONIC || 'test test test test test test test test test test test junk',
			index: undefined,
		};
	}
}

let authProvider: AuthProvider | undefined;
let fromProps:
	| {
			source?: MessageEventSource;
			windowOrigin: string;
			signingOrigin: string;
			requestID: string;
			domainRedirectPublicKey?: string;
			canCloseAutomatically: boolean;
	  }
	| undefined;

if (!authProviderType) {
	errors.push({message: `no auth provider configured`, canClose: true});
}

if (!mechanism) {
	errors.push({message: `sm not provided`, canClose: true});
}

const accountGenerator = accountType === 'ethereum' ? new EthereumAccountGenerator() : undefined;
if (!accountGenerator) {
	errors.push({message: `unsupported account type: ${accountType}`, canClose: true});
}

if (errors.length == 0 && windowOrigin && requestID && mechanism && accountType && accountGenerator) {
	console.log(`mechanism`, mechanism, `provider`, authProviderType);
	let canCloseAutomatically = false;
	if (type === 'mnemonic') {
		canCloseAutomatically = true;
	} else if (type === 'email') {
		canCloseAutomatically = true;
	} else if (oauth && !oauthRedirection) {
		canCloseAutomatically = true;
	}

	if (debug) {
		canCloseAutomatically = false;
	}

	const signingOriginToUse = signingOrigin || windowOrigin;

	authProvider = createAuthProvider(accountGenerator, windowOrigin, signingOriginToUse);

	// Trigger the auth flow
	// if (mechanism.type === 'oauth-redirect') {
	// 	authProvider.confirmOAuth().catch(console.error);
	// } else
	// if (mechanism.type === 'email' || mechanism.type === 'oauth' || mechanism.type === 'mnemonic') {
	authProvider.connect(mechanism).catch(console.error);
	// }

	fromProps = {
		source,
		windowOrigin,
		signingOrigin: signingOriginToUse,
		requestID: requestID,
		domainRedirectPublicKey,
		canCloseAutomatically,
	};

	if (typeof window !== 'undefined') {
		(window as any).authProvider = authProvider;
	}
} else {
	if (!accountType) {
		errors.push({message: `account-type not provided`, canClose: true});
	}
	if (!type) {
		errors.push({message: `type of flow not provided`, canClose: true});
	}

	if (!requestID) {
		errors.push({message: `no requestID provided`, canClose: true});
	}
	if (!windowOrigin) {
		errors.push({message: `no origin provided`, canClose: true});
	}
}

export {authProvider, errors, authProviderType, fromProps};
