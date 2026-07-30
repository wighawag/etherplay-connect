import type {AccountGenerator} from '@etherplay/wallet-connector';
import {
	AuthMechanism,
	AuthProvider,
	AuthProviderSettings,
	AuthState,
	deriveEtherplayAccount,
	EmailMechanism,
	EtherplayAccount,
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	localKeyMessage,
	OauthMechanism,
	OriginAccount,
	originKeyMessage,
	originPublicKeyPublicationMessage,
	Redirection,
} from '@etherplay/connect-core';
import {mnemonicToEntropy} from '@scure/bip39';
import {bytesToHex} from '@noble/hashes/utils';
import {wordlist} from '@scure/bip39/wordlists/english';
import {writable, get} from 'sveltore';
import {
	AccountTypeEnum,
	ChainTypeEnum,
	EmbeddedState,
	OAuthProvider,
	Openfort,
	RecoveryMethod,
	SessionError,
	OPENFORT_AUTH_ERROR_CODES,
} from '@openfort/openfort-js';

type OpenfortSettings = {
	publishableKey: string;
	shieldPublishableKey?: string;
	walletHost: string;
	accountGenerator: AccountGenerator;
	signingOrigin: string;
	windowOrigin: string;
	encryptionSessionEndpoint: string;
};

export function createOpenfortProvider(settings: OpenfortSettings): AuthProvider {
	let openfortInstance: Openfort | null = null;

	const store = writable<AuthState>({step: 'Idle'});

	async function tryGetCurrentUser() {
		if (!openfortInstance) return null;
		try {
			return await openfortInstance.user.get();
		} catch (error) {
			if (error instanceof SessionError) {
				console.log(`SessionError`, error);
				return null;
			}
			throw error;
		}
	}

	async function completeLogin(
		mechanism: EmailMechanism<string>,
		currentUser?: {email?: string; id: string},
	): Promise<void> {
		await setupOpenfortAccount();
		const key = await generateKey(localKeyMessage());

		const email = currentUser?.email || mechanism.email;
		const account = await generateAccount({
			key,
			mechanism: {...mechanism, email} as EmailMechanism<string>,
		});

		store.set({step: 'SignedIn', mechanism, account, requireOriginApproval: false});
	}

	async function init(providerSettings?: AuthProviderSettings): Promise<void> {
		// TODO auto
		store.set({step: 'Initialising', auto: true});

		const pk = (providerSettings?.publishableKey as string) || settings.publishableKey;
		const shield = (providerSettings?.shieldPublishableKey as string) || settings.shieldPublishableKey;

		openfortInstance = new Openfort({
			baseConfiguration: {publishableKey: pk},
			shieldConfiguration: shield ? {shieldPublishableKey: shield} : undefined,
		});

		await openfortInstance!.waitForInitialization();
		store.set({step: 'Initialised'});
	}

	async function connect(mechanism: AuthMechanism, redirection?: Redirection): Promise<void> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized. Call init() first.');
		}

		if (mechanism.type === 'email') {
			if (!mechanism.email) {
				store.set({step: 'EmailToProvide', mechanism: mechanism as EmailMechanism<undefined>});
				return;
			}

			const currentUser = await tryGetCurrentUser();
			if (currentUser && currentUser.email === mechanism.email) {
				await completeLogin(mechanism as EmailMechanism<string>, currentUser);
				return;
			}

			if (currentUser) {
				await openfortInstance.auth.logout();
			}

			store.set({step: 'WaitingForOTP', mechanism: mechanism as EmailMechanism<string>});
			await openfortInstance.auth.requestEmailOtp({email: mechanism.email});
		} else if (mechanism.type === 'oauth') {
			if (!redirection) {
				throw new Error(`no redirection data provided`);
			}

			await openfortInstance.auth.logout();

			const oauthMech = mechanism;
			const providerId = oauthMech.provider.id;

			// Map provider id to Openfort OAuth provider enum
			let openfortProvider: any;
			try {
				const providerMap: Record<string, any> = {
					google: OAuthProvider.GOOGLE,
					facebook: OAuthProvider.FACEBOOK,
					twitter: OAuthProvider.TWITTER,
					discord: OAuthProvider.DISCORD,
					apple: OAuthProvider.APPLE,
					epic: OAuthProvider.EPIC_GAMES,
					line: OAuthProvider.LINE,
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

			const currentState = get(store);
			if (isPopup && currentState.step !== 'ConfirmOAuth') {
				// For popup flow, we'll redirect the popup to the OAuth URL
				// and wait for the callback
				store.set({step: 'ConfirmOAuth', mechanism});
			} else {
				store.set({step: 'WaitingForOAuthResponse', mechanism});
				// TODO another step here while waiting for await

				const authProviderId = mechanism.provider.id;
				const auth0Connection = 'connection' in mechanism.provider ? mechanism.provider.connection : undefined;

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

				// Same-Origin Callback Bridge: carry the parent's public key through the
				// full-page Google -> Openfort -> popup round-trip so it survives the
				// in-memory state reset on the callback load.
				const domainRedirectPublicKey = currentURL.searchParams.get('domain-redirect-public-key');
				const drpkStr = domainRedirectPublicKey
					? `&domain-redirect-public-key=${encodeURIComponent(domainRedirectPublicKey)}`
					: '';

				// Testing aid: forces the BroadcastChannel delivery path on the bridge page.
				const forceBroadcastChannel = currentURL.searchParams.get('forceBroadcastChannel');
				const fbcStr =
					forceBroadcastChannel !== null ? `&forceBroadcastChannel=${encodeURIComponent(forceBroadcastChannel)}` : '';

				const redirectUrl = `${baseUrl}/login/?oauth-callback=true&oauth-redirection=true&type=oauth&origin=${redirection.windowOrigin}&signingOrigin=${redirection.signingOrigin}&id=${redirection.id}&oauth-provider=${authProviderId}${auth0Connection ? `&oauth-connection=${auth0Connection}` : ''}${accountTypeStr}${erudaStr}${debugStr}${logStr}${drpkStr}${fbcStr}`;

				try {
					const oauthUrl = await openfortInstance.auth.initOAuth({
						provider: openfortProvider,
						redirectTo: redirectUrl,
					});

					console.log({oauthUrl});

					if (typeof window !== 'undefined') {
						if (debugStr) {
							// Debug mode: do not auto-redirect. Expose a console function so the
							// developer can inspect the page first, then proceed manually.
							(window as any).proceedOAuth = () => {
								window.location.href = oauthUrl;
							};
							console.log(
								'%c[etherplay-openfort] debug mode: OAuth redirect paused. Run `proceedOAuth()` in the console to continue.',
								'color: orange; font-weight: bold;',
							);
						} else {
							window.location.href = oauthUrl;
						}
					}
				} catch (err) {
					store.update((currentState) => ({
						...currentState,
						error: {message: `failed to redirect`, cause: err},
					}));
					throw err;
				}
			}
		} else if (mechanism.type === 'mnemonic') {
			if (mechanism.index === undefined) {
				store.set({
					step: 'MnemonicIndexToProvide',
					mechanism: {type: 'mnemonic', mnemonic: mechanism.mnemonic, index: undefined},
				});
				return;
			}

			store.set({step: 'GeneratingAccount', mechanism});

			const mnemonicMech = mechanism;
			const mnemonic = mnemonicMech.mnemonic;
			const index = mnemonicMech.index ?? 0;

			const viemAccount = settings.accountGenerator.fromMnemonicToAccount(mnemonic, index);
			const keyUint8Array = mnemonicToEntropy(mnemonic, wordlist);
			const key = `0x${bytesToHex(keyUint8Array)}` as `0x${string}`;
			const address = viemAccount.address.toLowerCase() as `0x${string}`;
			const account: EtherplayAccount = {
				localAccount: {
					address,
					index,
					key,
				},
				signer: {
					mechanismUsed: mechanism,
					user: {
						address,
						orgId: 'mnemonic',
						userId: `${index}@mnemonic.id`,
						email: `${index}@mnemonic.id`,
					},
				},
				accountType: settings.accountGenerator.type,
			};

			store.set({
				step: 'SignedIn',
				mechanism,
				account,
				requireOriginApproval:
					settings.windowOrigin != settings.signingOrigin
						? {windowOrigin: settings.windowOrigin, signingOrigin: settings.signingOrigin, requestingAccess: true}
						: false,
			});
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
			const resultFromLoginWithOTP = await openfortInstance.auth.logInWithEmailOtp({email, otp});

			console.log({resultFromLoginWithOTP});

			await completeLogin(currentMechanism);
		} catch (err) {
			const message = 'failed to generate account after OTP';
			store.update((currentState) => ({
				...currentState,
				error: {message, cause: err},
			}));
			console.error(message, err);
			// throw err;
		}
	}

	async function confirmOAuth(
		mechanism: OauthMechanism,
		searchParams: URLSearchParams,
		redirection: Redirection,
	): Promise<void> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized');
		}

		const access_token = searchParams.get('access_token');
		const user_id = searchParams.get('user_id');

		store.set({step: 'WaitingForOAuthResponse', mechanism});

		try {
			// Extract token and user_id from current URL
			const url = new URL(window.location.href);

			if (!access_token || !user_id) {
				throw new Error('Missing token or user_id in callback URL');
			}

			await openfortInstance.auth.storeCredentials({
				token: access_token,
				userId: user_id,
			});

			await setupOpenfortAccount();
			const key = await generateKey(localKeyMessage());
			const account = await generateAccount({key, mechanism});

			// TODO requireOriginApproval
			store.set({step: 'SignedIn', mechanism, account, requireOriginApproval: false});
		} catch (err) {
			store.update((currentState) => ({
				...currentState,
				error: {message: 'failed to generate account after oauth', cause: err},
			}));
			throw err;
		}
	}

	async function setupOpenfortAccount() {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized');
		}
		// TODO options:
		const chainType = ChainTypeEnum.EVM;

		const embeddedWalletState = await openfortInstance.embeddedWallet.getEmbeddedState();
		if (embeddedWalletState === EmbeddedState.UNAUTHENTICATED) {
			throw new Error(`not authenticated, cannot setup embedded wallet`);
		} else if (embeddedWalletState === EmbeddedState.EMBEDDED_SIGNER_NOT_CONFIGURED) {
			const res = await fetch(`${settings.encryptionSessionEndpoint}/protected-create-encryption-session`, {
				method: 'POST',
			});
			const {session: encryptionSession} = await res.json();

			const accounts = await openfortInstance.embeddedWallet.list({chainType});

			if (accounts.length > 0) {
				// Wallet exists — recover the first one
				const account = await openfortInstance.embeddedWallet.recover({
					account: accounts[0].id,
					recoveryParams: {
						recoveryMethod: RecoveryMethod.AUTOMATIC,
						encryptionSession,
					},
				});
				console.log({accountRecovered: account});
			} else {
				// No wallet — create one
				const account = await openfortInstance.embeddedWallet.create({
					chainType,
					accountType: AccountTypeEnum.EOA,
					recoveryParams: {
						recoveryMethod: RecoveryMethod.AUTOMATIC,
						encryptionSession,
					},
				});
				console.log({accountCreated: account});
			}
		} else if (embeddedWalletState === EmbeddedState.READY) {
			console.log(`embedded wallet ready, we can continue`);
		} else {
			throw new Error(`embedded wallet state: ${embeddedWalletState}`);
		}
	}

	async function generateKey(message: string): Promise<`0x${string}`> {
		if (!openfortInstance) {
			throw new Error('Openfort not initialized');
		}
		const signature = await openfortInstance.embeddedWallet.signMessage(message);
		const signatureUsingMessageHash = await openfortInstance.embeddedWallet.signMessage(message, {hashMessage: true});
		console.log({
			signature,
			signatureUsingMessageHash,
			privateKey: await openfortInstance.embeddedWallet.exportPrivateKey(),
		});
		return fromSignatureToKey(signature as `0x${string}`);
	}

	async function generateAccount({key, mechanism}: {key: `0x${string}`; mechanism: AuthMechanism}) {
		return deriveEtherplayAccount(key, mechanism, settings.accountGenerator);
	}

	async function provideEmail(email: string) {
		await connect({type: 'email', email, mode: 'otp'});
	}
	async function provideMnemonicIndex(index: number) {
		const currentState = get(store);
		if (currentState.step !== 'MnemonicIndexToProvide') {
			throw new Error('no mnemonic index to provide');
		}
		await connect({type: 'mnemonic', mnemonic: currentState.mechanism.mnemonic, index});
	}

	return {
		subscribe: store.subscribe,
		init,
		connect,
		provideEmail,
		provideOTP,
		provideMnemonicIndex,
		confirmOAuth,
	};
}
