import type {AccountGenerator} from '@etherplay/wallet-connector';
import {
	AuthMechanism,
	AuthProvider,
	AuthProviderSettings,
	AuthState,
	buildOAuthCallbackUrl,
	deriveEtherplayAccount,
	EmailMechanism,
	fromSignatureToKey,
	localKeyMessage,
	OauthMechanism,
	originApprovalRequired,
	type OriginContext,
	Redirection,
} from '@etherplay/connect-core';
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

// The two origins and the declared permissions arrive as ONE value (`OriginContext`), so the two
// same-typed origin strings cannot be swapped on the way in. This provider decides none of it; it
// carries the permissions into `AuthState` so the UI can ask, and the origins into the approval
// gate.
type OpenfortSettings = OriginContext & {
	publishableKey: string;
	shieldPublishableKey?: string;
	walletHost: string;
	accountGenerator: AccountGenerator;
	encryptionSessionEndpoint: string;
};

/**
 * Said the same way wherever the mnemonic mechanism reaches this provider, so nobody has to guess
 * why a provider that used to answer it no longer does.
 *
 * A host that reaches this has routed by a deployment-wide setting instead of by mechanism.
 */
function mnemonicIsLocal(): Error {
	return new Error(
		'the mnemonic mechanism is not hosted authentication and is no longer implemented here: it derives the account ' +
			'in the browser and touches no Openfort account, key or endpoint. Use `createLocalProvider` from ' +
			'@etherplay/connect-core, which the host selects by MECHANISM rather than by the "provider" query parameter.',
	);
}

export function createOpenfortProvider(settings: OpenfortSettings): AuthProvider {
	let openfortInstance: Openfort | null = null;

	const store = writable<AuthState>({step: 'Idle'});

	// WHAT HAS TO BE SETTLED BEFORE THE RESULT MAY BE HANDED OVER is `originApprovalRequired`, from
	// @etherplay/connect-core, called directly at every path below that reaches `SignedIn`. Not
	// wrapped in a local name: it is not a property of this vendor, and a wrapper here is one more
	// place a provider could quietly answer the question differently. A gate that only some doors
	// have is not a gate.

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

		store.set({step: 'SignedIn', mechanism, account, requireOriginApproval: originApprovalRequired(settings)});
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

				// The URL the provider sends the user back to, built in @etherplay/connect-core.
				//
				// Not here, because what it encodes is the popup URL CONTRACT rather than anything about
				// Openfort: this round trip is a full page load, so every parameter the app set and this
				// URL omits is silently gone, and only on the OAuth path. `permissions` was omitted for as
				// long as the feature existed. In core it is one list with a test on it.
				const redirectUrl = buildOAuthCallbackUrl({
					baseUrl,
					redirection,
					provider: authProviderId,
					connection: auth0Connection,
					current: currentURL.searchParams,
				});

				// Presence, not value: `?debug` and `?debug=1` both mean debug, as they always did here.
				const pauseBeforeRedirect = currentURL.searchParams.has('debug');

				try {
					const oauthUrl = await openfortInstance.auth.initOAuth({
						provider: openfortProvider,
						redirectTo: redirectUrl,
					});

					console.log({oauthUrl});

					if (typeof window !== 'undefined') {
						if (pauseBeforeRedirect) {
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
			// MOVED OUT, not delegated to. A mnemonic account is derived in the browser from a phrase
			// and touches no Openfort account, no publishable key and no network, so it is not hosted
			// authentication and it is not this vendor's to answer for. It lives in
			// `createLocalProvider` (@etherplay/connect-core), and the HOST routes to it by mechanism.
			throw mnemonicIsLocal();
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

			store.set({step: 'SignedIn', mechanism, account, requireOriginApproval: originApprovalRequired(settings)});
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
	async function provideMnemonicIndex(_index: number) {
		throw mnemonicIsLocal();
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
