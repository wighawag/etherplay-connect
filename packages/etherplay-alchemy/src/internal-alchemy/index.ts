import type {User} from '@account-kit/signer';
import {AlchemyWebSigner} from '@account-kit/signer';
import {retry} from '../utils/execution.js';
import {fromSignatureToKey} from '@etherplay/connect-core';

const TURNKEY_IFRAME_CONTAINER_ID = 'turnkey-iframe-container';

export {AlchemyWebSigner};

export type {User};

export type Redirection = {windowOrigin: string; signingOrigin: string; id: string};

export function concatUint8Arrays(values: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const arr of values) {
		length += arr.length;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const arr of values) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

export type SignerUser = {
	user: User;
	signer: AlchemyWebSigner;
};

export type AlchemySettings = {rpcURL: string} | {apiKeyNotRecommended: string};

export function createAlchemyOnBoarding(settings: AlchemySettings, options?: {sessionKey?: string; orgId?: string}) {
	const sessionKey = options?.sessionKey || 'alchemy-signer-session';

	let popupIsPrepared: boolean = false;
	let signer: AlchemyWebSigner | undefined;

	async function init(params?: {preparePopup?: boolean}): Promise<AlchemyWebSigner> {
		if (!signer) {
			localStorage.removeItem(sessionKey);
			// console.log(`Alchemy: setting up iframe container...`);
			const existingContainer = document.getElementById(TURNKEY_IFRAME_CONTAINER_ID);
			if (!existingContainer) {
				const container = document.createElement('div');
				container.id = TURNKEY_IFRAME_CONTAINER_ID;
				container.style.display = 'none';
				document.body.appendChild(container);
			}

			// console.log(`Alchemy: creating signer using orgId: ${options?.orgId}...`);
			signer = new AlchemyWebSigner({
				client: {
					// This is created in your dashboard under `https://dashboard.alchemy.com/settings/access-keys`
					// NOTE: it is not recommended to expose your API key on the client, instead proxy requests to your backend and set the `rpcUrl`
					// here to point to your backend.
					connection:
						'apiKeyNotRecommended' in settings ? {apiKey: settings.apiKeyNotRecommended} : {rpcUrl: settings.rpcURL},
					iframeConfig: {
						// you will need to render a container with this id in your DOM
						iframeContainerId: TURNKEY_IFRAME_CONTAINER_ID,
					},
					rootOrgId: options?.orgId,
				},
				sessionConfig: {
					expirationTimeMs: 1 * 60 * 60 * 1000,
					sessionKey,
				},
			});

			if (params?.preparePopup) {
				// console.log('Alchemy: preparePopupOauth...');
				await signer.preparePopupOauth();
				popupIsPrepared = true;
			}
		}

		// // ----------------------------------------------------------------------------------------
		// // is this necessary ?
		// // ----------------------------------------------------------------------------------------
		// console.log(`Alchemy: signer.getAuthDetails()....`);
		// let user = null;
		// try {
		// 	user = await signer.getAuthDetails();
		// } catch (err) {
		// 	console.warn(`no user at this point`, err);
		// }
		// // ----------------------------------------------------------------------------------------

		return signer;
	}

	async function preparePopup() {
		if (!signer) {
			throw new Error(`no signer initialised`);
		}
		// console.log('Alchemy: preparePopupOauth...');
		await signer.preparePopupOauth();
		popupIsPrepared = true;
	}

	async function loginViaEmail(email: string, emailMode: 'otp' | 'magicLink'): Promise<SignerUser | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}

		// TODO we don't do that untile we can determine if this is the same account
		// email are not the right wa to that on its own since google account can share same email as email account
		//  and yet have a different signer
		// console.log(`initial signer.getAuthDetails...`);
		// const user = await signer.getAuthDetails().catch(() => null);
		// // TODO and same auth method
		// if (user && user.email == email) {
		// 	console.log({user});
		// 	console.log(`same email , we are already logged in.`);
		// 	return {user, signer};
		// }

		// console.log(`Alchemy: signer.authenticate with email ...`);
		let newUser: User;
		try {
			newUser = await signer.authenticate({
				type: 'email',
				emailMode,
				email,
			});
		} catch (err) {
			console.error(`email, failed to: signer.authenticate(...) `, err);
			throw err;
		}

		// console.log({ newUser });

		if (newUser) {
			// console.log(`Alchemy: signer.getAuthDetails...`);
			let user: User;
			try {
				user = await signer.getAuthDetails();
			} catch (err) {
				console.error(`email, failed to: signer.getAuthDetails() `, err);
				throw err;
			}
			return {user, signer};
		} else {
			console.log(`no user`);
			return null;
		}
	}

	async function loginViaOAuth(
		provider: {id: 'google'} | {id: 'facebook'} | {id: 'auth0'; connection: string},
		redirection?: Redirection,
	): Promise<SignerUser | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}

		// const user = await signer.getAuthDetails().catch(() => null);

		// console.log({user});

		// console.log('authenticating...');

		const authProviderId = provider.id;
		const auth0Connection = typeof provider === 'object' && provider.id === 'auth0' ? provider.connection : undefined;

		let newUser: User | undefined;

		if (redirection) {
			const currentURL = new URL(location.href);

			let accountTypeStr = '';
			if (currentURL.searchParams.has('account-type')) {
				const value = currentURL.searchParams.get('account-type');
				accountTypeStr = value ? `&account-type=${value}` : '&account-type';
			}

			let erudaStr = '';
			if (currentURL.searchParams.has('eruda')) {
				const value = currentURL.searchParams.get('eruda');
				erudaStr = value ? `&eruda=${value}` : '&eruda';
			}

			let debugStr = '';
			if (currentURL.searchParams.has('debug')) {
				const value = currentURL.searchParams.get('debug');
				debugStr = value ? `&debug=${value}` : '&debug';
			}

			let logStr = '';
			if (currentURL.searchParams.has('log')) {
				const value = currentURL.searchParams.get('log');
				logStr = value ? `&log=${value}` : '&log';
			}

			const redirectUrl = `/login/?type=oauth-redirect&origin=${redirection.windowOrigin}&signingOrigin=${redirection.signingOrigin}&id=${redirection.id}&oauth-provider=${authProviderId}${auth0Connection ? `&oauth-connection=${auth0Connection}` : ''}${options?.orgId ? `&orgId=${options.orgId}` : ''}${accountTypeStr}${erudaStr}${debugStr}${logStr}`;
			// console.log(`Alchemy: signer.authenticate(...) redirect &{ redirectUrl }`);
			if (authProviderId === 'auth0') {
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					auth0Connection,
					mode: 'redirect',
					redirectUrl,
				});
			} else {
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					mode: 'redirect',
					redirectUrl,
				});
			}
		} else {
			// console.log(`Alchemy: signer.authenticate(...) popup`);
			if (authProviderId === 'auth0') {
				// console.log(`auth0:${auth0Connection}`);
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					auth0Connection,
					mode: 'popup',
				});
			} else {
				// console.log(`oauth:${authProviderId}`);
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					mode: 'popup',
				});
			}
		}

		// console.log({ newUser });

		if (newUser) {
			let user: User;
			try {
				// console.log(`Alchemy: signer.getAuthDetails() loginViaOauth`);
				user = await signer.getAuthDetails();
			} catch (err) {
				console.error(`oauth, failed to: signer.getAuthDetails() `, err);
				throw err;
			}
			return {user, signer};
		} else {
			return null;
		}
	}

	async function completeEmailLoginViaBundle(
		bundle: string,
		orgId?: string,
	): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			// console.log(`Alchemy: signer.authenticate(...) completeEmailLoginViaBundle`);
			await signer.authenticate({type: 'email', bundle, orgId});

			// console.log(`Alchemy: signer.getAuthDetails() completeEmailLoginViaBundle`);
			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return {user, signer};
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with bundle`, err);
			return null;
		}
	}

	async function completeOAuthWithBundle(
		alchemyBundle: string,
		alchemyOrgId: string,
		alchemyIdToken: string,
	): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			// console.log(`Alchemy: signer.authenticate(...) completeOAuthWithBundle`);
			await signer.authenticate({
				type: 'oauthReturn',
				bundle: alchemyBundle,
				orgId: alchemyOrgId,
				idToken: alchemyIdToken,
			});

			// console.log(`Alchemy: signer.getAuthDetails() completeOAuthWithBundle`);
			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return {user, signer};
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with bundle`, err);
			return null;
		}
	}

	async function completeEmailLoginViaOTP(otpCode: string): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			// console.log(`Alchemy: signer.authenticate(...) completeEmailLoginViaOTP`);
			await signer.authenticate({type: 'otp', otpCode});

			// console.log(`Alchemy: signer.getAuthDetails() completeEmailLoginViaOTP`);
			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return {user, signer};
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with otp`, err);
			throw new Error(`failed to authenticate with otp`, {cause: err});
		}
	}

	async function getUserSigner(): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		// console.log(`Alchemy: signer.getAuthDetails() getUserSigner`);
		const user = await signer.getAuthDetails().catch(() => null);
		if (user) {
			return {user, signer};
		} else {
			return null;
		}
	}

	async function sign(msg: string): Promise<`0x${string}`> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		const localSigner = signer;

		// console.log(`Alchemy: signer.signMessage(msg) sign`);

		const signature: `0x${string}` = await retry<`0x${string}`>(() => localSigner.signMessage(msg), {
			maxRetries: 5,
			delay: 300,
		});
		return signature;
	}

	async function signToGenerateEntropyKey(msg: string): Promise<`0x${string}`> {
		const signature = await sign(msg);

		return fromSignatureToKey(signature);
	}

	// function getSession(): AlchemySessionInStorage | undefined {
	// 	const fromStorage = localStorage.getItem(sessionKey);
	// 	if (fromStorage) {
	// 		const session = JSON.parse(fromStorage);
	// 		return session as AlchemySessionInStorage;
	// 	}
	// }

	return {
		init,
		loginViaEmail,
		loginViaOAuth,
		sign,
		getUserSigner,
		preparePopup,
		get signer() {
			return signer;
		},
		get popupIsPrepared() {
			return popupIsPrepared;
		},
		completeEmailLoginViaBundle,
		completeOAuthWithBundle,
		completeEmailLoginViaOTP,
		signToGenerateEntropyKey,
		// getSession,
	};
}
