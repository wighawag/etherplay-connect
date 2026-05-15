import type {AccountGenerator} from '@etherplay/wallet-connector';
import {
	AuthMechanism,
	AuthProvider,
	AuthProviderSettings,
	AuthState,
	EmailMechanism,
	EtherplayAccount,
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	localKeyMessage,
	OriginAccount,
	originKeyMessage,
	originPublicKeyPublicationMessage,
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

	async function connect(mechanism: AuthMechanism): Promise<void> {
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
				// For redirect flow, initiate OAuth and redirect
				const callbackUrl = `${baseUrl}/login/?type=oauth-redirect`;
				console.log({callbackUrl});

				try {
					const oauthUrl = await openfortInstance.auth.initOAuth({
						provider: openfortProvider,
						redirectTo: callbackUrl,
					});

					console.log({oauthUrl});

					if (typeof window !== 'undefined') {
						window.location.href = oauthUrl;
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

			await setupOpenfortAccount();
			const key = await generateKey(localKeyMessage());
			const account = await generateAccount({key, mechanism: currentMechanism});

			// TODO requireOriginApproval
			store.set({step: 'SignedIn', mechanism: currentMechanism, account, requireOriginApproval: false});
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

	// TODO extract it from hhere, not openfort specific, except for signer metadata, which we do not provide for now
	async function generateAccount({key, mechanism}: {key: `0x${string}`; mechanism: AuthMechanism}) {
		const mnemonic = fromEntropyKeyToMnemonic(key);
		const etherplayAccount: EtherplayAccount = {
			localAccount: {
				// TODO should use the connector so it create an account matching the connector chain type (ethereum, fuel, starknet...)
				// this way a user can leave Etherplay account and come back to the same account by providing the same mnemonic
				address: settings.accountGenerator.fromMnemonicToAccount(mnemonic, 0).address,
				index: 0,
				key,
			},
			signer: {
				mechanismUsed: mechanism,
				// TODO user: signerUser.user,
			},
			accountType: settings.accountGenerator.type,
		};

		// TODO option ?
		// again should not be handled in openfort specific provider
		// saveEtherplayAccount(etherplayAccount);

		return etherplayAccount;
	}

	// TODO extract it from hhere, not openfort specific, except for signer metadata, which we do not provide for now
	async function generateOriginAccount(origin: string, account: EtherplayAccount): Promise<OriginAccount> {
		const accountMnemonic = fromEntropyKeyToMnemonic(account.localAccount.key);

		const accountObject = settings.accountGenerator.fromMnemonicToAccount(accountMnemonic, account.localAccount.index);
		const originKeySignature = await settings.accountGenerator.signTextMessage(
			originKeyMessage(origin),
			accountObject.privateKey,
		);

		const originKey = fromSignatureToKey(originKeySignature);
		const originMnemonic = fromEntropyKeyToMnemonic(originKey);

		const originAccount = settings.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

		const savedPublicKeyPublicationSignature = await settings.accountGenerator.signTextMessage(
			originPublicKeyPublicationMessage(origin, originAccount.publicKey),
			accountObject.privateKey,
		);
		return {
			address: account.localAccount.address,
			signer: {
				origin,
				publicKey: originAccount.publicKey,
				address: originAccount.address,
				privateKey: originAccount.privateKey,
				mnemonicKey: originKey,
			},
			metadata: {},
			mechanismUsed: account.signer.mechanismUsed,
			savedPublicKeyPublicationSignature,
			accountType: settings.accountGenerator.type,
		};
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
