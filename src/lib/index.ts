import { writable } from 'svelte/store';
import {
	createAlchemyOnBoarding,
	type AlchemySettings,
	type SignerUser
} from './internal-alchemy/index.js';

export type EmailMechanism<T extends string | undefined> = {
	type: 'email';
	email: T;
	mode: 'otp';
};

export type OauthMechanism = {
	type: 'oauth';
	provider: 'google' | 'facebook';
};

export type Mechanism = EmailMechanism<string | undefined> | OauthMechanism;

export type Connection = { error?: { message: string; cause?: any } } & (
	| {
			step: 'MechanismChosen';
			mechanism: Mechanism;
	  }
	| {
			step: 'EmailToProvide';
			mechanism: EmailMechanism<undefined>;
	  }
	| {
			step: 'MechanismToChoose';
	  }
	| {
			step: 'WaitingForOTPVerification';
			mechanism: EmailMechanism<string>;
	  }
	| {
			step: 'WaitingForOAuthResponse';
			mechanism: OauthMechanism;
	  }
	| {
			step: 'SignedIn';
			mechanism: Mechanism;
			privateKey: string;
	  }
);

export function createConnection(settings: { alchemy: AlchemySettings }) {
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

	function setupAlchemySigner(newSigner: SignerUser) {
		console.log({ newSigner });
	}

	function provideEmail(email: string) {
		if ($connection?.step !== 'EmailToProvide') {
			throw new Error(`no email to provide`);
		}
		return connect({ type: 'email', mode: 'otp', email });
	}

	async function provideOTP(otp: string) {
		if ($connection?.step !== 'WaitingForOTPVerification') {
			throw new Error(`no email to provide`);
		}

		const result = await onboarding.completeEmailLoginViaOTP(otp);
		console.log({ result });
	}

	async function connect(mechanism?: Mechanism) {
		if (mechanism) {
			set({ step: 'MechanismChosen', mechanism });

			if (mechanism.type === 'email') {
				if (mechanism.email === undefined) {
					set({
						step: 'EmailToProvide',
						mechanism: { type: 'email', mode: 'otp', email: undefined }
					});
					return;
				}

				const signer = await onboarding.init();
				console.log({ existingSIgner: signer });

				const promise = onboarding.loginViaEmail(mechanism.email, mechanism.mode);

				set({
					step: 'WaitingForOTPVerification',
					mechanism: {
						type: 'email',
						mode: 'otp',
						email: mechanism.email
					}
				});

				try {
					const newSigner = await promise;
					console.log({ newSigner });

					if (newSigner) {
						set({
							step: 'SignedIn',
							mechanism,
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
				const signer = await onboarding.init();
				console.log({ existingSIgner: signer });

				set({
					step: 'WaitingForOAuthResponse',
					mechanism
				});

				try {
					const newSigner = await onboarding.loginViaOAuth(mechanism.provider);
					console.log({ newSigner });

					if (newSigner) {
						set({
							step: 'SignedIn',
							mechanism,
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
		} else {
			set({ step: 'MechanismToChoose' });
		}
	}

	return {
		subscribe: _store.subscribe,
		connect,
		provideEmail,
		provideOTP
	};
}
