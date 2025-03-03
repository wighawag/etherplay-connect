import { writable } from 'svelte/store';
import {
	AlchemyWebSigner,
	createAlchemyOnBoarding,
	type AlchemySettings,
	type SignerUser
} from './internal-alchemy/index.js';
import { onDocumentLoaded } from './utils/web.js';

export type EmailMechanism<T extends string | undefined> = {
	type: 'email';
	email: T;
	mode: 'otp';
};

export type OauthMechanism = {
	type: 'oauth';
	usePopup: boolean;
	provider: { id: 'google' | 'facebook' } | { id: 'auth0'; connection: string };
};

export type MnemonicMechanism<T extends number | undefined> = {
	type: 'mnemonic';
	mnemonic: string;
	index: T;
};

export type Mechanism =
	| EmailMechanism<string | undefined>
	| OauthMechanism
	| MnemonicMechanism<number | undefined>;

export type Connection = { error?: { message: string; cause?: any } } & (
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
			mechanism: Mechanism;
	  }
	| {
			step: 'MechanismChosen';
			mechanism: Mechanism;
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
	| {
			step: 'MnemonicGeneratingPrivateKey';
			mechanism: MnemonicMechanism<number>;
			signer: AlchemyWebSigner;
	  }
	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// Final Success
	// --------------------------------------------------------------------------------------------
	| {
			step: 'SignedIn';
			mechanism: Mechanism;
			signer: AlchemyWebSigner;
			privateKey: string;
	  }
);
// --------------------------------------------------------------------------------------------

export function createConnection(settings: {
	alchemy: AlchemySettings;
	alwaysUsePopupForOAuth?: boolean;
}) {
	let $connection: Connection | undefined;
	const _store = writable<Connection | undefined>($connection);
	function set(connection: Connection | undefined) {
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
		set({
			step: 'Initialising',
			auto: true
		});
		const signer = await onboarding.init({ preparePopup: settings.alwaysUsePopupForOAuth });
		set({
			step: 'Initialised',
			signer
		});
	}
	onDocumentLoaded(auto);

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

		const result = await onboarding.completeEmailLoginViaOTP(otp);
		console.log({ result });

		set({
			step: 'SignedIn',
			mechanism,
			signer,
			privateKey: '' // TODO
		});
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
			const newSigner = await onboarding.loginViaOAuth(mechanism.provider);
			console.log({ newSigner });

			if (newSigner) {
				set({
					step: 'SignedIn',
					mechanism,
					signer,
					privateKey: ''
				});
			} else {
				setError({ message: 'no signer' });
			}
		} catch (err) {
			console.error(err);
			setError({ message: 'failed to initiate oauth signin', cause: err });
		}
	}

	async function connect(mechanism?: Mechanism) {
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
					const newSigner = await promise;
					console.log({ newSigner });

					if (newSigner) {
						set({
							step: 'SignedIn',
							mechanism,
							signer,
							privateKey: ''
						});
					} else {
						setError({ message: 'no signer' });
					}
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
					step: 'MnemonicGeneratingPrivateKey',
					mechanism: {
						type: 'mnemonic',
						mnemonic: mechanism.mnemonic,
						index: mechanism.index
					},
					signer
				});
				set({
					step: 'SignedIn',
					mechanism,
					signer,
					privateKey: ''
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

	return {
		subscribe: _store.subscribe,
		connect,
		provideEmail,
		provideOTP,
		provideMnemonicIndex
	};
}
