import type {AccountGenerator} from '@etherplay/wallet-connector';
import {
	AuthMechanism,
	AuthProvider,
	AuthProviderSettings,
	AuthState,
	EmailMechanism,
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	OriginAccount,
	originKeyMessage,
} from '@etherplay/connect-core';
import {mnemonicToEntropy} from '@scure/bip39';
import {bytesToHex} from '@noble/hashes/utils';
import {wordlist} from '@scure/bip39/wordlists/english';
import {writable, get} from 'sveltore';

type OpenfortSettings = {
	publishableKey: string;
	shieldPublishableKey?: string;
	walletHost: string;
	accountGenerator: AccountGenerator;
	signingOrigin: string;
	windowOrigin: string;
};

let OpenfortSDK: any = null;

async function loadOpenfortSDK(): Promise<any> {
	if (OpenfortSDK) return OpenfortSDK;
	try {
		const mod = await import('@openfort/openfort-js');
		OpenfortSDK = mod;
		return OpenfortSDK;
	} catch (err) {
		console.error('Failed to load Openfort SDK:', err);
		throw err;
	}
}

export function createOpenfortProvider(settings: OpenfortSettings): AuthProvider {
	let openfortInstance: any = null;
	let currentEmail: string | undefined;

	const store = writable<AuthState>({step: 'Idle'});

	async function init(providerSettings: AuthProviderSettings): Promise<void> {
		// TODO auto
		store.set({step: 'Initialising', auto: true});
		await loadOpenfortSDK();

		const pk = (providerSettings as any).publishableKey || settings.publishableKey;
		const shield = (providerSettings as any).shieldPublishableKey || settings.shieldPublishableKey;

		openfortInstance = new OpenfortSDK.Openfort({
			baseConfiguration: {publishableKey: pk},
			shieldConfiguration: shield ? {shieldPublishableKey: shield} : undefined,
		});

		await openfortInstance.waitForInitialization();
		store.set({step: 'Initialised'});
	}

	async function connect(mechanism: AuthMechanism): Promise<void> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized. Call init() first.');
		}

		if (mechanism.type === 'email') {
			if (!mechanism.email) {
				store.set({step: 'EmailToProvide', mechanism: mechanism as EmailMechanism<undefined>});
			} else {
				store.set({step: 'WaitingForOTP', mechanism: mechanism as EmailMechanism<string>});
				await openfortInstance.auth.requestEmailOtp({email: currentEmail});
			}
		} else if (mechanism.type === 'oauth') {
			const oauthMech = mechanism;
			const providerId = oauthMech.provider.id;

			// Map provider id to Openfort OAuth provider enum
			let openfortProvider: any;
			try {
				const {OAuthProvider} = await loadOpenfortSDK();
				const providerMap: Record<string, any> = {
					google: OAuthProvider.Google,
					facebook: OAuthProvider.Facebook,
					twitter: OAuthProvider.Twitter,
					discord: OAuthProvider.Discord,
					apple: OAuthProvider.Apple,
				};
				openfortProvider = providerMap[providerId];
				if (!openfortProvider) {
					throw new Error(`Unsupported OAuth provider: ${providerId}`);
				}
			} catch (err) {
				store.update((currentState) => ({
					...currentState,
					error: {message: `Unsupported OAuth provider: ${providerId}`},
				}));
				throw err;
			}

			const isPopup = oauthMech.usePopup !== false;
			const baseUrl = settings.walletHost || window.location.origin;

			if (isPopup) {
				// For popup flow, we'll redirect the popup to the OAuth URL
				// and wait for the callback
				store.set({step: 'ConfirmOAuth', mechanism});
			} else {
				// TODO another step here while waiting for await
				// For redirect flow, initiate OAuth and redirect
				const callbackUrl = `${baseUrl}/login/?type=oauth-redirect`;
				const oauthUrl = await openfortInstance.auth.initOAuth({
					provider: openfortProvider,
					redirectTo: callbackUrl,
				});
				store.set({step: 'WaitingForOAuthResponse', mechanism});
				if (typeof window !== 'undefined') {
					window.location.href = oauthUrl;
				}
			}
		} else if (mechanism.type === 'mnemonic') {
			const mnemonicMech = mechanism;
			const mnemonic = mnemonicMech.mnemonic || settings.accountGenerator.type;
			const index = mnemonicMech.index ?? 0;

			// Mnemonic flow is custom, not through Openfort SDK
			store.set({step: 'GeneratingAccount', mechanism});

			try {
				const keyUint8Array = mnemonicToEntropy(mnemonic, wordlist);
				const key = `0x${bytesToHex(keyUint8Array)}` as `0x${string}`;
				const viemAccount = settings.accountGenerator.fromMnemonicToAccount(mnemonic, index);
				const address = viemAccount.address.toLowerCase() as `0x${string}`;

				const originKeySignature = await settings.accountGenerator.signTextMessage(
					originKeyMessage(settings.signingOrigin),
					viemAccount.privateKey,
				);

				const originKey = fromSignatureToKey(originKeySignature);
				const originMnemonic = fromEntropyKeyToMnemonic(originKey);
				const originAccount = settings.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

				const result: OriginAccount = {
					address,
					signer: {
						origin: settings.signingOrigin,
						address: originAccount.address,
						publicKey: originAccount.publicKey,
						privateKey: originAccount.privateKey,
						mnemonicKey: originKey,
					},
					metadata: {},
					mechanismUsed: mechanism,
					savedPublicKeyPublicationSignature: undefined,
					accountType: settings.accountGenerator.type,
				};

				// TODO requireOriginApproval
				store.set({step: 'SignedIn', mechanism, requireOriginApproval: false});
			} catch (err) {
				store.update((currentState) => ({...currentState, error: {message: 'failed to generate account', cause: err}}));
				throw err;
			}
		}
	}

	async function provideOTP(otp: string): Promise<void> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized');
		}

		const currentState = get(store);
		if (currentState.step !== 'WaitingForOTP') {
			throw new Error('Not in WaitingForOTP state');
		}

		const currentMechanism = currentState.mechanism;
		const email = currentMechanism.email;
		store.set({step: 'VerifyingOTP', mechanism: currentMechanism});

		try {
			await openfortInstance.auth.logInWithEmailOtp({email, otp});

			// Sign origin key message
			const originKeyMsg = originKeyMessage(settings.signingOrigin);
			const signature = await openfortInstance.embeddedWallet.signMessage(originKeyMsg);

			// Derive origin account
			const originKey = fromSignatureToKey(signature as `0x${string}`);
			const originMnemonic = fromEntropyKeyToMnemonic(originKey);
			const originAccount = settings.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

			const result: OriginAccount = {
				address: (await openfortInstance.embeddedWallet.getAddress()) as `0x${string}`,
				signer: {
					origin: settings.signingOrigin,
					address: originAccount.address,
					publicKey: originAccount.publicKey,
					privateKey: originAccount.privateKey,
					mnemonicKey: originKey,
				},
				metadata: {email},
				mechanismUsed: {type: 'email', email, mode: 'otp'},
				savedPublicKeyPublicationSignature: undefined,
				accountType: settings.accountGenerator.type,
			};

			// TODO requireOriginApproval
			store.set({step: 'SignedIn', mechanism: currentMechanism, requireOriginApproval: false});
		} catch (err) {
			store.update((currentState) => ({
				...currentState,
				error: {message: 'failed to generate account after OTP', cause: err},
			}));
			throw err;
		}
	}

	async function confirmOAuth(): Promise<void> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized');
		}

		const currentState = get(store);
		if (!('mechanism' in currentState)) {
			throw new Error(`no mechanism`);
		}

		const currentMechanism = currentState.mechanism;

		if (!(currentMechanism.type === 'oauth')) {
			throw new Error(`not oauth mechanism`);
		}

		store.set({step: 'WaitingForOAuthResponse', mechanism: currentMechanism});

		try {
			// Extract token and user_id from current URL
			const url = new URL(window.location.href);
			const token = url.searchParams.get('token');
			const userId = url.searchParams.get('user_id');

			if (!token || !userId) {
				throw new Error('Missing token or user_id in callback URL');
			}

			await openfortInstance.auth.storeCredentials({
				token,
				userId,
			});

			// Sign origin key message
			const originKeyMsg = originKeyMessage(settings.signingOrigin);
			const signature = await openfortInstance.embeddedWallet.signMessage(originKeyMsg);

			// Derive origin account
			const originKey = fromSignatureToKey(signature as `0x${string}`);
			const originMnemonic = fromEntropyKeyToMnemonic(originKey);
			const originAccount = settings.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

			const result: OriginAccount = {
				address: (await openfortInstance.embeddedWallet.getAddress()) as `0x${string}`,
				signer: {
					origin: settings.signingOrigin,
					address: originAccount.address,
					publicKey: originAccount.publicKey,
					privateKey: originAccount.privateKey,
					mnemonicKey: originKey,
				},
				metadata: {},
				mechanismUsed: {type: 'oauth', provider: {id: 'unknown'}},
				savedPublicKeyPublicationSignature: undefined,
				accountType: settings.accountGenerator.type,
			};

			// TODO requireOriginApproval
			store.set({step: 'SignedIn', mechanism: currentMechanism, requireOriginApproval: false});
		} catch (err) {
			store.update((currentState) => ({
				...currentState,
				error: {message: 'failed to generate account after oauth', cause: err},
			}));
			throw err;
		}
	}

	async function generateOriginAccount(origin: string): Promise<OriginAccount> {
		throw new Error(`TODO`);
		// if (!currentAccount) {
		// 	throw new Error('No account available');
		// }

		// const accountMnemonic = fromEntropyKeyToMnemonic(currentAccount.signer.mnemonicKey);
		// const accountObject = accountGenerator.fromMnemonicToAccount(accountMnemonic, 0);

		// const originKeySignature = await accountGenerator.signTextMessage(
		// 	originKeyMessage(origin),
		// 	accountObject.privateKey,
		// );

		// const originKey = fromSignatureToKey(originKeySignature);
		// const originMnemonic = fromEntropyKeyToMnemonic(originKey);
		// const originAccount = accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

		// return {
		// 	address: account.address,
		// 	signer: {
		// 		origin,
		// 		address: originAccount.address,
		// 		publicKey: originAccount.publicKey,
		// 		privateKey: originAccount.privateKey,
		// 		mnemonicKey: originKey,
		// 	},
		// 	metadata: account.metadata,
		// 	mechanismUsed: account.mechanismUsed,
		// 	savedPublicKeyPublicationSignature: account.savedPublicKeyPublicationSignature,
		// 	accountType: account.accountType,
		// };
	}
	async function provideEmail(email: string) {
		await connect({type: 'email', email, mode: 'otp'});
	}
	async function provideMnemonicIndex(index: number) {
		const currentState = get(store);
		if (currentState.step !== 'SignedIn') {
			throw new Error('Not signed in');
		}
		await connect({type: 'mnemonic', mnemonic: '', index});
	}

	function getState(): AuthState {
		return get(store);
	}

	return {
		subscribe: store.subscribe,
		init,
		connect,
		provideEmail,
		provideOTP,
		provideMnemonicIndex,
		confirmOAuth,
		generateOriginAccount,
		getState,
	};
}
