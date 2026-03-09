import {writable} from 'svelte/store';
import {
	AlchemyWebSigner,
	createAlchemyOnBoarding,
	Redirection,
	type AlchemySettings,
	type SignerUser,
	type User,
} from './internal-alchemy/index.js';
import {onDocumentLoaded} from './utils/web.js';
import {mnemonicToEntropy} from '@scure/bip39';
import {bytesToHex} from '@noble/hashes/utils';
import {wordlist} from '@scure/bip39/wordlists/english';
import type {AccountGenerator} from '@etherplay/wallet-connector';
import {
	AlchemyMechanism,
	EmailMechanism,
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	localKeyMessage,
	MnemonicMechanism,
	OauthMechanism,
	OriginAccount,
	originKeyMessage,
	originPublicKeyPublicationMessage,
} from '@etherplay/connect-core';

export type MagicLinkReturnMechanism = {
	type: 'magicLink';
	bundle: string;
	orgId: string;
};

export type OauthRedirectMechanism = {
	type: 'oauth-redirect';
	provider: {id: 'google' | 'facebook'} | {id: 'auth0'; connection: string};
	redirection: {origin: string; requestID: string};
} & ({alchemyOrgId: string; alchemyIdToken: string; alchemyBundle: string} | {error: string});

export type AlchemyMechanismIncludingRedirects = AlchemyMechanism | MagicLinkReturnMechanism | OauthRedirectMechanism;

export type AlchemyUser = {
	email?: string;
	orgId: string;
	userId: string;
	address: `0x${string}`;
	credentialId?: string;
	idToken?: string;
	claims?: Record<string, unknown>;
};

export type EtherplayAccount = {
	localAccount: {
		address: `0x${string}`;
		index: number;
		key: `0x${string}`;
	};
	signer: {
		mechanismUsed: AlchemyMechanism;
		user: AlchemyUser;
	};
	accountType: string;
};

export type AlchemyConnection = {error?: {message: string; cause?: any}} & (
	| {
			step: 'Initialising';
			auto: boolean;
	  }
	| {
			step: 'Initialised';
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'MechanismToChoose';
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'InitialisingMechanism';
			mechanism: AlchemyMechanism;
	  }
	| {
			step: 'MechanismChosen';
			mechanism: AlchemyMechanism;
			signer: AlchemyWebSigner;
	  }

	// --------------------------------------------------------------------------------------------
	// Email
	// --------------------------------------------------------------------------------------------
	| {
			step: 'EmailToProvide';
			mechanism: EmailMechanism<undefined>;
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'WaitingForOTP';
			mechanism: EmailMechanism<string>;
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'VerifyingOTP';
			mechanism: EmailMechanism<string>;
			signer: AlchemyWebSigner;
	  }
	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// OAuth
	// --------------------------------------------------------------------------------------------
	| {
			step: 'InitializingOAuthPopup';
			mechanism: OauthMechanism;
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'ConfirmOAuth';
			mechanism: OauthMechanism;
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'WaitingForOAuthResponse';
			mechanism: OauthMechanism;
			signer: AlchemyWebSigner;
	  }
	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// Mnemonic
	// --------------------------------------------------------------------------------------------
	| {
			step: 'MnemonicIndexToProvide';
			mechanism: MnemonicMechanism<undefined>;
			signer: AlchemyWebSigner;
	  }

	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// Final Success
	// --------------------------------------------------------------------------------------------
	| {
			step: 'GeneratingAccount';
			mechanism: AlchemyMechanism;
			signer: AlchemyWebSigner;
	  }
	| {
			step: 'SignedIn';
			mechanism: AlchemyMechanism;
			signer: AlchemyWebSigner;
			account: EtherplayAccount;
			requireOriginApproval:
				| false
				| {
						windowOrigin: string;
						signingOrigin: string;
						requestingAccess: boolean;
				  };
	  }
);

// --------------------------------------------------------------------------------------------

const storageAccountKey = '__etherplay_account';

export type AlchemyConnectionStore = ReturnType<typeof createAlchemyConnection>;

export function createAlchemyConnection(
	settings: {
		alchemy: AlchemySettings;
		autoInitialise?: boolean;
		alwaysUsePopupForOAuth?: boolean;
		accountGenerator: AccountGenerator;
		windowOrigin: string;
		signingOrigin: string;
	},
	// options?: {
	// 	sessionKey?: string;
	// 	orgId?: string;
	// 	oauthProviderUsed?: string;
	// }
) {
	let $connection: AlchemyConnection | undefined;
	const _store = writable<AlchemyConnection | undefined>($connection);
	function set(connection: AlchemyConnection | undefined) {
		$connection = connection;
		_store.set($connection);
		return $connection;
	}
	function setError(error: {message: string; cause?: any}) {
		if ($connection) {
			set({
				...$connection,
				error,
			});
		} else {
			throw new Error(`no connection`);
		}
	}

	const onboarding = createAlchemyOnBoarding(settings.alchemy); //, options);

	async function auto() {
		const signer = await onboarding.init({preparePopup: settings.alwaysUsePopupForOAuth});
		set({
			step: 'Initialised',
			signer,
		});
	}
	if (settings.autoInitialise) {
		set({
			step: 'Initialising',
			auto: true,
		});
		onDocumentLoaded(auto);
	}

	function provideEmail(email: string) {
		if ($connection?.step !== 'EmailToProvide') {
			throw new Error(`no email to provide`);
		}
		return connect({type: 'email', mode: $connection.mechanism.mode, email});
	}

	function provideMnemonicIndex(index: number) {
		if ($connection?.step !== 'MnemonicIndexToProvide') {
			throw new Error(`no mnemonic index to provide`);
		}
		return connect({type: 'mnemonic', mnemonic: $connection.mechanism.mnemonic, index});
	}

	async function provideOTP(otp: string) {
		if ($connection?.step !== 'WaitingForOTP') {
			throw new Error(`no email to provide`);
		}

		const mechanism = $connection.mechanism;
		const signer = $connection.signer;
		set({
			step: 'VerifyingOTP',
			mechanism,
			signer,
		});

		let result:
			| {
					user: User;
					signer: AlchemyWebSigner;
			  }
			| null
			| undefined;
		try {
			result = await onboarding.completeEmailLoginViaOTP(otp);
		} catch (err) {
			console.error(`failed to complete email via otp`, err);
			set({
				step: 'WaitingForOTP',
				mechanism,
				signer,
				error: {message: 'Failed to Verify OTP', cause: err},
			});
		}
		if (!result) {
			set({
				step: 'WaitingForOTP',
				mechanism,
				signer,
				error: {message: 'failed to  login via oauth', cause: 'not result'},
			});
			throw new Error(`failed to verify otp`);
		}

		set({
			step: 'GeneratingAccount',
			mechanism,
			signer,
		});
		try {
			const account = await generateAccount({mechanism, signerUser: result});
			set({
				step: 'SignedIn',
				mechanism,
				signer,
				account,
				requireOriginApproval:
					settings.windowOrigin != settings.signingOrigin
						? {windowOrigin: settings.windowOrigin, signingOrigin: settings.signingOrigin, requestingAccess: true}
						: false,
			});
			if (emailPromise) {
				emailPromise.resolve(account);
				emailPromise = null;
			} else {
				console.error(`no promise set`);
			}
			return account;
		} catch (err) {
			if (emailPromise) {
				emailPromise.reject(err);
				emailPromise = null;
			} else {
				console.error(`no promise set`);
			}

			console.error(err);
			// TODO
			// allow to regenerate one
			set({
				step: 'EmailToProvide',
				mechanism: {
					type: 'email',
					mode: 'otp',
					email: undefined, // TODO default to previous
				},
				signer,
				error: {message: 'Failed to Verify OTP', cause: err},
			});
		}
	}

	async function confirmOAuth(data?: {signer: AlchemyWebSigner; mechanism: OauthMechanism; redirection?: Redirection}) {
		let mechanism: OauthMechanism;
		let signer: AlchemyWebSigner;
		if (!data) {
			if ($connection?.step !== 'ConfirmOAuth') {
				throw new Error(`not in confirm oauth step`);
			}
			mechanism = $connection.mechanism;
			signer = $connection.signer;
		} else {
			mechanism = data.mechanism;
			signer = data.signer;
		}

		set({
			step: 'WaitingForOAuthResponse',
			mechanism,
			signer,
		});

		let redirection;
		if (!mechanism.usePopup) {
			redirection = data?.redirection;
			if (!redirection) {
				// TODO error set
				throw new Error(`no redirection provided`);
			}
		}

		try {
			const result = await onboarding.loginViaOAuth(mechanism.provider, redirection);

			if (!result) {
				set({
					step: 'MechanismChosen',
					mechanism,
					signer,
					error: {message: 'failed to  login via oauth', cause: 'not result'},
				});
				throw new Error(`failed to verify otp`);
			}

			set({
				step: 'GeneratingAccount',
				mechanism,
				signer,
			});
			const account = await generateAccount({mechanism, signerUser: result});

			set({
				step: 'SignedIn',
				mechanism,
				signer,
				account,
				requireOriginApproval:
					settings.windowOrigin != settings.signingOrigin
						? {windowOrigin: settings.windowOrigin, signingOrigin: settings.signingOrigin, requestingAccess: true}
						: false,
			});
			return account;
		} catch (err) {
			console.error(err);
			setError({message: 'failed to initiate oauth signin', cause: err});
		}
	}

	let emailPromise: {
		resolve(account: EtherplayAccount): void;
		reject(err: unknown): void;
	} | null = null;
	async function connect(
		mechanism?: AlchemyMechanism,
		redirection?: Redirection,
	): Promise<EtherplayAccount | undefined> {
		if (mechanism) {
			let signer: AlchemyWebSigner;
			if ($connection && 'signer' in $connection && $connection.signer) {
				signer = $connection.signer;
			} else {
				set({step: 'InitialisingMechanism', mechanism});

				const popupRequirePreparation = mechanism.type === 'oauth' && mechanism.usePopup;

				signer = await onboarding.init({
					preparePopup: popupRequirePreparation,
				});
				if (popupRequirePreparation) {
					set({
						step: 'ConfirmOAuth',
						mechanism,
						signer,
					});
					return;
				}
			}
			set({step: 'MechanismChosen', mechanism, signer});

			if (mechanism.type === 'email') {
				if (mechanism.email === undefined) {
					set({
						step: 'EmailToProvide',
						mechanism: {type: 'email', mode: 'otp', email: undefined},
						signer,
					});
					return;
				}

				// console.log({ existingSIgner: signer });

				onboarding.loginViaEmail(mechanism.email, mechanism.mode);

				set({
					step: 'WaitingForOTP',
					mechanism: {
						type: 'email',
						mode: 'otp',
						email: mechanism.email,
					},
					signer,
				});

				const promise = new Promise<EtherplayAccount>((resolve, reject) => {
					emailPromise = {
						resolve,
						reject,
					};
				});

				return promise;

				// try {
				// 	const result = await promise;
				// 	if (!result) {
				// 		set({
				// 			step: 'MechanismChosen',
				// 			mechanism,
				// 			signer,
				// 			error: { message: 'failed to  verifyotp', cause: 'not result' }
				// 		});
				// 		throw new Error(`failed to verify otp`);
				// 	}

				// 	set({
				// 		step: 'GeneratingAccount',
				// 		mechanism,
				// 		signer
				// 	});
				// 	const account = await generateAccount({ mechanism, signerUser: result });

				// 	set({
				// 		step: 'SignedIn',
				// 		mechanism,
				// 		signer,
				// 		account
				// 	});
				// 	return account;
				// } catch (err) {
				// 	console.error(err);
				// 	setError({ message: 'failed to initiate email signin', cause: err });
				// }
			} else if (mechanism.type === 'oauth') {
				// console.log({ existingSIgner: signer });

				if (mechanism.usePopup) {
					set({
						step: 'InitializingOAuthPopup',
						mechanism,
						signer,
					});
					if (!onboarding.popupIsPrepared) {
						await onboarding.preparePopup();
						set({
							step: 'ConfirmOAuth',
							mechanism,
							signer,
						});
						return;
					}
				} else if (settings.alwaysUsePopupForOAuth) {
					throw new Error(`configured to always use popup for oauth`);
				}

				await confirmOAuth({signer, mechanism, redirection});
			} else if (mechanism.type === 'mnemonic') {
				if (mechanism.index === undefined) {
					set({
						step: 'MnemonicIndexToProvide',
						mechanism: {type: 'mnemonic', mnemonic: mechanism.mnemonic, index: undefined},
						signer,
					});
					return;
				}

				set({
					step: 'GeneratingAccount',
					mechanism,
					signer,
				});
				const mnemonic = mechanism.mnemonic;
				const index = mechanism.index;

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

				set({
					step: 'SignedIn',
					mechanism,
					signer,
					account,
					requireOriginApproval:
						settings.windowOrigin != settings.signingOrigin
							? {windowOrigin: settings.windowOrigin, signingOrigin: settings.signingOrigin, requestingAccess: true}
							: false,
				});
				return account;
			}
		} else {
			set({
				step: 'Initialising',
				auto: false,
			});
			const signer = await onboarding.init();
			set({step: 'MechanismToChoose', signer});
		}
	}

	async function generateAccount({
		mechanism,
		signerUser,
	}: {
		mechanism: AlchemyMechanism;
		signerUser: SignerUser;
	}): Promise<EtherplayAccount> {
		const key = await onboarding.signToGenerateEntropyKey(localKeyMessage());
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
				user: signerUser.user,
			},
			accountType: settings.accountGenerator.type,
		};

		// TODO option ?
		// saveEtherplayAccount(etherplayAccount);

		return etherplayAccount;
	}

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
			metadata: {
				email: account.signer.user.email,
			},
			mechanismUsed: account.signer.mechanismUsed,
			savedPublicKeyPublicationSignature,
			accountType: settings.accountGenerator.type,
		};
	}

	function getEtherplayAccount(): EtherplayAccount | undefined {
		const fromStorage = localStorage.getItem(storageAccountKey);
		if (fromStorage) {
			return JSON.parse(fromStorage) as EtherplayAccount;
		}
	}

	function saveEtherplayAccount(account: EtherplayAccount) {
		const accountSTR = JSON.stringify(account);
		sessionStorage.setItem(storageAccountKey, accountSTR);
		localStorage.setItem(storageAccountKey, accountSTR);
	}

	async function completeOAuthWithBundle(
		redirectMechanism: OauthRedirectMechanism,
		alchemyBundle: string,
		alchemyOrgId: string,
		alchemyIdToken: string,
	): Promise<EtherplayAccount> {
		const mechanism: OauthMechanism = {
			type: 'oauth',
			provider: redirectMechanism.provider,
			usePopup: false,
		};
		set({
			step: 'InitialisingMechanism',
			mechanism,
		});

		const signer = await onboarding.init();

		set({
			step: 'MechanismChosen', // TODO VerifyingOauthBundle ?
			mechanism,
			signer,
		});

		const result = await onboarding.completeOAuthWithBundle(alchemyBundle, alchemyOrgId, alchemyIdToken);
		if (!result) {
			set({
				step: 'MechanismChosen',
				signer,
				mechanism,
				error: {message: 'failed to  login via oauth', cause: 'not result'},
			});
			throw new Error(`failed to verify otp`);
		}

		set({
			step: 'GeneratingAccount',
			mechanism,
			signer,
		});
		const account = await generateAccount({mechanism, signerUser: result});

		set({
			step: 'SignedIn',
			mechanism,
			signer,
			account,
			requireOriginApproval:
				settings.windowOrigin != settings.signingOrigin
					? {windowOrigin: settings.windowOrigin, signingOrigin: settings.signingOrigin, requestingAccess: true}
					: false,
		});

		return account;
	}

	function confirmOriginAccess() {
		if ($connection?.step !== 'SignedIn') {
			throw new Error(`not signed in`);
		}
		if (!$connection.requireOriginApproval) {
			throw new Error(`already confirmed`);
		}
		set({
			...$connection,
			requireOriginApproval: {...$connection.requireOriginApproval, requestingAccess: false},
		});
	}

	return {
		subscribe: _store.subscribe,
		connect,
		confirmOAuth,
		provideEmail,
		provideOTP,
		provideMnemonicIndex,
		generateOriginAccount,
		completeOAuthWithBundle,
		confirmOriginAccess,
	};
}
