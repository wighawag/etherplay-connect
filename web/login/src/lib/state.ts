import type {AuthMechanism, AuthProvider, OauthMechanism} from '@etherplay/connect-core';
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

// origin that created the popup
export const windowOrigin = searchParams.get('origin');
// the requested origin for signing, so if a new frontend want to interact with conquest.game data, we need to specifiy conquest.game here
// this will ask the user to confirm
export const signingOrigin = searchParams.get('signingOrigin');
// Id for tracking
export const requestID = searchParams.get('id');

// -- AUTH TYPE ------------------------------------------------------------------
// type of auth used (email, oauth, mnemonic, etc...)
export const type = searchParams.get('type');
// email for email auth
export const emailStr = searchParams.get('email');
// emailMode, only otp supported for now
export const emailModeStr = searchParams.get('emailMode');
export const emailMode: 'otp' | undefined = emailModeStr === 'otp' ? 'otp' : undefined;
export const email = emailStr ? decodeURIComponent(emailStr) : undefined;
// for oauth, specifiy the provider (google, facbook, ...)
export const oauth = searchParams.get('oauth-provider') || undefined;
// for multi oauth like auth0, can specify connection like google, facebook ,etc...
export const oauthConnection = searchParams.get('oauth-connection') || undefined;
// this indicate we are requesting oauth flow in the same popup, no extra popup, only one supported for now
export const oauthRedirection = searchParams.get('oauth-redirection') === 'true';
// -------------------------------------------------------------------------------

// this indicate we are back into the popup through a redirection
export const isCallback = searchParams.get('oauth-callback') === 'true';
// this allow for encryption to allow the game domain to be intermediary in the popup flow so it can talk to the game
const domainRedirectPublicKey = searchParams.get('domain-redirect-public-key') || undefined;

// account type, for now ethereum is the only one well supported
const accountType = searchParams.get('account-type') || 'ethereum';
// for now we use openfort
const authProviderType = searchParams.get('provider') || import.meta.env.VITE_AUTH_PROVIDER || 'openfort';

// debug flag that for example stop the popup for auto closing so we can inspect the console logs
export const debug = searchParams.get('debug');

console.log({
	source,
	opener: window.opener,
	openerClosed: window.opener?.closed,
});

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
				throw new Error(`popup oauth flow not supported`);
			}
		} else {
			errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
		}
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
	} else {
		errors.push({message: `invalid auth type: ${type}`, canClose: true});
	}
}

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
	errors.push({message: `mechanism not provided`, canClose: true});
}

const accountGenerator = accountType === 'ethereum' ? new EthereumAccountGenerator() : undefined;
if (!accountGenerator) {
	errors.push({message: `unsupported account type: ${accountType}`, canClose: true});
}

let authProvider: AuthProvider | undefined;
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

	const authProviderToUse = createAuthProvider(authProviderType, accountGenerator, windowOrigin, signingOriginToUse);

	const initialisingAuthProvider = authProviderToUse.init();

	const authProviderConnecting = isCallback
		? initialisingAuthProvider.then(() =>
				authProviderToUse.confirmOAuth(mechanism as OauthMechanism, searchParams, {
					windowOrigin,
					signingOrigin: signingOriginToUse,
					id: requestID,
				}),
			)
		: initialisingAuthProvider.then(() =>
				authProviderToUse.connect(mechanism, {windowOrigin, signingOrigin: signingOriginToUse, id: requestID}),
			);

	authProviderConnecting.catch(console.error);

	authProvider = authProviderToUse;

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

export {authProvider, errors, authProviderType, fromProps, accountGenerator};
