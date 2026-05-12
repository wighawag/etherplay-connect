import {handle} from './handler';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';
import type {UnifiedConnectionStore} from './handler';

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
export const providerType = searchParams.get('provider');

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
export const domainRedirectPublicKey = searchParams.get('domain-redirect-public-key') || undefined;
export const accountType = searchParams.get('account-type') || 'ethereum';

const rpcURL: string | null = searchParams.get('alchemy-api') || import.meta.env.VITE_ALCHEMY_RPC_URL;
const apiKeyNotRecommended: string | null =
	searchParams.get('api-key') || import.meta.env.VITE_ALCHEMY_API_KEY_NOT_RECOMMENDED;

const authProvider = import.meta.env.VITE_AUTH_PROVIDER || 'openfort';
const usePopupProvider = providerType || authProvider;

let mechanism:
	| {type: 'email'; email?: string; mode?: 'otp'}
	| {type: 'oauth'; provider: {id: string; connection?: string}; usePopup?: boolean}
	| {type: 'oauth-redirect'; provider: {id: string; connection?: string}}
		& (
			| {alchemyOrgId: string; alchemyIdToken: string; alchemyBundle: string}
			| {error: string}
		)
	| {type: 'mnemonic'; mnemonic: string; index?: number}
	| {type: 'magicLink'; bundle: string; orgId: string}
	| undefined;

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
} else {
	if (type === 'oauth') {
		if (oauth) {
			if (oauthRedirection) {
				if (!windowOrigin || !requestID) {
					throw new Error(`no origin or requestID`);
				}
				mechanism = {
					type: 'oauth',
					provider: {id: oauth, connection: oauthConnection || undefined},
					usePopup: false,
				};
			} else {
				mechanism = {
					type: 'oauth',
					provider: {id: oauth, connection: oauthConnection || undefined},
					usePopup: true,
				};
			}
		} else {
			errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
		}
	} else if (type === 'oauth-redirect') {
		if (alchemyError) {
			if (!windowOrigin || !requestID) {
				throw new Error(`no origin or requestID`);
			}
			if (oauth) {
				mechanism = {
					type: 'oauth-redirect',
					provider: {id: oauth, connection: oauthConnection || undefined},
					error: alchemyError,
				};
			} else {
				errors.push({message: `invalid oauthProviderUsed: ${oauth}`, canClose: true});
			}
		} else if (alchemyBundle && alchemyIdToken && alchemyOrgId && oauth) {
			if (!windowOrigin || !requestID) {
				throw new Error(`no origin or requestID`);
			}
			if (oauth) {
				mechanism = {
					type: 'oauth-redirect',
					provider: {id: oauth, connection: oauthConnection || undefined},
					alchemyOrgId,
					alchemyIdToken,
					alchemyBundle,
				};
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
			mnemonic: import.meta.env.VITE_DEV_MNEMONIC || 'test test test test test test test test test test test junk',
			index: undefined,
		};
	}
}

let connectionStore: UnifiedConnectionStore | undefined;
let fromProps: {
	source?: MessageEventSource;
	windowOrigin: string;
	signingOrigin: string;
	requestID: string;
	domainRedirectPublicKey?: string;
	canCloseAutomatically: boolean;
} | undefined;

if (!usePopupProvider) {
	errors.push({message: `no auth provider configured`, canClose: true});
}

if (errors.length == 0 && windowOrigin && (rpcURL || apiKeyNotRecommended) && requestID && mechanism && accountType) {
	console.log(`mechanism`, mechanism, `provider`, usePopupProvider);
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
	const accountGenerator: any =
		accountType === 'ethereum' ? new EthereumAccountGenerator() : undefined;

	connectionStore = handle({
		mechanism,
		rpcURL,
		apiKeyNotRecommended,
		windowOrigin,
		signingOrigin: signingOriginToUse,
		requestID,
		accountType,
		provider: usePopupProvider as 'openfort' | 'alchemy',
		accountGenerator,
	});

	fromProps = {
		source,
		windowOrigin,
		signingOrigin: signingOriginToUse,
		requestID: requestID,
		domainRedirectPublicKey,
		canCloseAutomatically,
	};

	if (typeof window !== 'undefined') {
		(window as any).connection = connectionStore;
	}
} else {
	if (!accountType) {
		errors.push({message: `account-type not provided`, canClose: true});
	}
	if (!type) {
		errors.push({message: `type of flow not provided`, canClose: true});
	}
	if (bundle) {
		errors.push({message: `Magic Link Not Supported For now`, canClose: true});
	}
	if (!requestID) {
		errors.push({message: `no requestID provided`, canClose: true});
	}
	if (!windowOrigin) {
		errors.push({message: `no origin provided`, canClose: true});
	}
	if (!rpcURL && !apiKeyNotRecommended) {
		errors.push({message: `no rpcURL or apiKey provided`, canClose: true});
	}
}

export {connectionStore, errors, usePopupProvider, fromProps};
