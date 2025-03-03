import { writable } from 'svelte/store';
import {
	AlchemyWebSigner,
	createAlchemyOnBoarding,
	fromEntropyKeyToMnemonic,
	fromMnemonicSignToGenerateEntropyKey,
	fromMnemonicToAccount,
	fromMnemonicToFirstAccount,
	type AlchemySettings,
	type SignerUser
} from './internal-alchemy/index.js';
import { onDocumentLoaded } from './utils/web.js';
import { mnemonicToEntropy } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils';
import { wordlist } from '@scure/bip39/wordlists/english';

export type EmailMechanism<T extends string | undefined> = {
	type: 'email';
	email: T;
	mode: 'otp';
};

export type MagicLinkReturnMechanism = {
	type: 'magicLink';
	bundle: string;
	orgId: string;
};

export type OauthMechanism = {
	type: 'oauth';

	provider: { id: 'google' | 'facebook' } | { id: 'auth0'; connection: string };
} & ({ usePopup: true } | { usePopup: false; redirection: { origin: string; requestID: string } });

export type OauthRedirectMechanism = {
	type: 'oauth-redirect';
	provider: { id: 'google' | 'facebook' } | { id: 'auth0'; connection: string };
	redirection: { origin: string; requestID: string };
} & ({ alchemyOrgId: string; alchemyIdToken: string; alchemyBundle: string } | { error: string });

export type MnemonicMechanism<T extends number | undefined> = {
	type: 'mnemonic';
	mnemonic: string;
	index: T;
};

export type AlchemyMechanism =
	| EmailMechanism<string | undefined>
	| OauthMechanism
	| MnemonicMechanism<number | undefined>;

export type AlchemyMechanismIncludingRedirects =
	| AlchemyMechanism
	| MagicLinkReturnMechanism
	| OauthRedirectMechanism;

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
};

export type OriginAccount = {
	user: AlchemyUser;
	localAccount: {
		address: `0x${string}`;
	};
	originAccount: {
		origin: string;
		address: `0x${string}`;
		privateKey: `0x${string}`;
		mnemonicKey: `0x${string}`;
		mnemonic: string;
		index: number;
	};
	mechanismUsed: AlchemyMechanism;
};

export type AlchemyConnection = { error?: { message: string; cause?: any } } & (
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
	  }
);

// --------------------------------------------------------------------------------------------

const storageAccountKey = '__etherplay_account';

export function originKeyMessage(orig: string): string {
	return `Signing Request for ${orig}:\n Please sign this message only on ${orig} or other trusted frontend.\n\n This gives access to your session account that you need to keep secret`;
}
export function localKeyMessage(): string {
	return 'DO NOT ACCEPT THIS SIGNATURE REQUEST! This used by Etherplay Wallet to generate your seed phrase.';
}

export type AlchemyConnectionStore = ReturnType<typeof createAlchemyConnection>;

export function createAlchemyConnection(settings: {
	alchemy: AlchemySettings;
	autoInitialise?: boolean;
	alwaysUsePopupForOAuth?: boolean;
}) {
	let $connection: AlchemyConnection | undefined;
	const _store = writable<AlchemyConnection | undefined>($connection);
	function set(connection: AlchemyConnection | undefined) {
		$connection = connection;
		_store.set($connection);
		return $connection;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($connection) {
			set({
				...$connection,
				error
			});
		} else {
			throw new Error(`no connection`);
		}
	}

	const onboarding = createAlchemyOnBoarding(settings.alchemy);

	async function auto() {
		const signer = await onboarding.init({ preparePopup: settings.alwaysUsePopupForOAuth });
		set({
			step: 'Initialised',
			signer
		});
	}
	if (settings.autoInitialise) {
		set({
			step: 'Initialising',
			auto: true
		});
		onDocumentLoaded(auto);
	}

	function setupAlchemySigner(newSigner: SignerUser) {
		console.log({ newSigner });
	}

	function provideEmail(email: string) {
		if ($connection?.step !== 'EmailToProvide') {
			throw new Error(`no email to provide`);
		}
		return connect({ type: 'email', mode: $connection.mechanism.mode, email });
	}

	function provideMnemonicIndex(index: number) {
		if ($connection?.step !== 'MnemonicIndexToProvide') {
			throw new Error(`no mnemonic index to provide`);
		}
		return connect({ type: 'mnemonic', mnemonic: $connection.mechanism.mnemonic, index });
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
			signer
		});

		try {
			await onboarding.completeEmailLoginViaOTP(otp);
		} catch (err) {
			set({
				step: 'WaitingForOTP',
				mechanism,
				signer,
				error: { message: 'Failed to Verify OTP', cause: err }
			});
		}
	}

	async function confirmOAuth(data?: { signer: AlchemyWebSigner; mechanism: OauthMechanism }) {
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
			signer
		});

		try {
			const result = await onboarding.loginViaOAuth(mechanism.provider);

			if (!result) {
				set({
					step: 'Initialised',
					signer,
					error: { message: 'failed to  login via oauth', cause: 'not result' }
				});
				throw new Error(`failed to verify otp`);
			}

			set({
				step: 'GeneratingAccount',
				mechanism,
				signer
			});
			const account = await generateAccount({ mechanism, signerUser: result });

			set({
				step: 'SignedIn',
				mechanism,
				signer,
				account
			});
		} catch (err) {
			console.error(err);
			setError({ message: 'failed to initiate oauth signin', cause: err });
		}
	}

	async function connect(mechanism?: AlchemyMechanism) {
		if (mechanism) {
			let signer: AlchemyWebSigner;
			if ($connection && 'signer' in $connection && $connection.signer) {
				signer = $connection.signer;
			} else {
				set({ step: 'InitialisingMechanism', mechanism });

				const popupRequirePreparation = mechanism.type === 'oauth' && mechanism.usePopup;

				signer = await onboarding.init({
					preparePopup: popupRequirePreparation
				});
				if (popupRequirePreparation) {
					set({
						step: 'ConfirmOAuth',
						mechanism,
						signer
					});
					return;
				}
			}
			set({ step: 'MechanismChosen', mechanism, signer });

			if (mechanism.type === 'email') {
				if (mechanism.email === undefined) {
					set({
						step: 'EmailToProvide',
						mechanism: { type: 'email', mode: 'otp', email: undefined },
						signer
					});
					return;
				}

				console.log({ existingSIgner: signer });

				const promise = onboarding.loginViaEmail(mechanism.email, mechanism.mode);

				set({
					step: 'WaitingForOTP',
					mechanism: {
						type: 'email',
						mode: 'otp',
						email: mechanism.email
					},
					signer
				});

				try {
					const result = await promise;
					if (!result) {
						set({
							step: 'Initialised',
							signer,
							error: { message: 'failed to  verifyotp', cause: 'not result' }
						});
						throw new Error(`failed to verify otp`);
					}

					set({
						step: 'GeneratingAccount',
						mechanism,
						signer
					});
					const account = await generateAccount({ mechanism, signerUser: result });

					set({
						step: 'SignedIn',
						mechanism,
						signer,
						account
					});
				} catch (err) {
					console.error(err);
					setError({ message: 'failed to initiate email signin', cause: err });
				}
			} else if (mechanism.type === 'oauth') {
				console.log({ existingSIgner: signer });

				if (mechanism.usePopup) {
					set({
						step: 'InitializingOAuthPopup',
						mechanism,
						signer
					});
					if (!onboarding.popupIsPrepared) {
						await onboarding.preparePopup();
						set({
							step: 'ConfirmOAuth',
							mechanism,
							signer
						});
						return;
					}
				} else if (settings.alwaysUsePopupForOAuth) {
					throw new Error(`configured to always use popup for oauth`);
				}

				await confirmOAuth({ signer, mechanism });
			} else if (mechanism.type === 'mnemonic') {
				if (mechanism.index === undefined) {
					set({
						step: 'MnemonicIndexToProvide',
						mechanism: { type: 'mnemonic', mnemonic: mechanism.mnemonic, index: undefined },
						signer
					});
					return;
				}

				set({
					step: 'GeneratingAccount',
					mechanism,
					signer
				});
				const mnemonic = mechanism.mnemonic;
				const index = mechanism.index;

				const viemAccount = fromMnemonicToAccount(mnemonic, index);
				const keyUint8Array = mnemonicToEntropy(mnemonic, wordlist);
				const key = `0x${bytesToHex(keyUint8Array)}` as `0x${string}`;
				const account: EtherplayAccount = {
					localAccount: {
						address: viemAccount.address,
						index,
						key
					},
					signer: {
						mechanismUsed: mechanism,
						user: {
							address: viemAccount.address,
							orgId: 'mnemonic',
							userId: `${index}@mnemonic.id`,
							email: `${index}@mnemonic.id`
						}
					}
				};

				set({
					step: 'SignedIn',
					mechanism,
					signer,
					account
				});
			}
		} else {
			set({
				step: 'Initialising',
				auto: false
			});
			const signer = await onboarding.init();
			set({ step: 'MechanismToChoose', signer });
		}
	}

	async function generateAccount({
		mechanism,
		signerUser
	}: {
		mechanism: AlchemyMechanism;
		signerUser: SignerUser;
	}): Promise<EtherplayAccount> {
		const key = await onboarding.signToGenerateEntropyKey(localKeyMessage());
		const mnemonic = fromEntropyKeyToMnemonic(key);
		const etherplayAccount: EtherplayAccount = {
			localAccount: {
				address: fromMnemonicToFirstAccount(mnemonic).address,
				index: 0,
				key
			},
			signer: {
				mechanismUsed: mechanism,
				user: signerUser.user
			}
		};

		// TODO option ?
		// saveEtherplayAccount(etherplayAccount);

		return etherplayAccount;
	}

	function generateOriginAccount(origin: string, account: EtherplayAccount): OriginAccount {
		const originKey = fromMnemonicSignToGenerateEntropyKey(
			fromEntropyKeyToMnemonic(account.localAccount.key),
			account.localAccount.index,
			originKeyMessage(origin)
		);
		const originMnemonic = fromEntropyKeyToMnemonic(originKey);
		const originAccount = fromMnemonicToFirstAccount(originMnemonic);
		return {
			user: account.signer.user,
			localAccount: {
				address: account.localAccount.address
			},
			originAccount: {
				index: 0,
				address: originAccount.address,
				privateKey: originAccount.privateKey,
				mnemonicKey: originKey,
				mnemonic: originMnemonic,
				origin: origin
			},

			mechanismUsed: account.signer.mechanismUsed
		};
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
		alchemyIdToken: string
	): Promise<EtherplayAccount> {
		const signer = await onboarding.init();

		const result = await onboarding.completeOAuthWithBundle(
			alchemyBundle,
			alchemyOrgId,
			alchemyIdToken
		);
		if (!result) {
			set({
				step: 'Initialised',
				signer,
				error: { message: 'failed to  login via oauth', cause: 'not result' }
			});
			throw new Error(`failed to verify otp`);
		}

		const mechanism: OauthMechanism = {
			type: 'oauth',
			provider: redirectMechanism.provider,
			usePopup: false,
			redirection: redirectMechanism.redirection
		};
		set({
			step: 'GeneratingAccount',
			mechanism,
			signer
		});
		const account = await generateAccount({ mechanism, signerUser: result });

		set({
			step: 'SignedIn',
			mechanism,
			signer,
			account
		});

		return account;
	}

	return {
		subscribe: _store.subscribe,
		connect,
		confirmOAuth,
		provideEmail,
		provideOTP,
		provideMnemonicIndex,
		generateOriginAccount,
		completeOAuthWithBundle
	};
}
