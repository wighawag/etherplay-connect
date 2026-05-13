export type MnemonicMechanism<T extends number | undefined> = {
	type: 'mnemonic';
	mnemonic: string;
	index: T;
};

export type OauthMechanism = {
	type: 'oauth';

	provider: {id: 'google' | 'facebook'} | {id: 'auth0'; connection: string};
} & ({usePopup: true} | {usePopup: false});

export type EmailMechanism<T extends string | undefined> = {
	type: 'email';
	email: T;
	mode: 'otp';
};

export type AuthMechanism = EmailMechanism<string | undefined> | OauthMechanism | MnemonicMechanism<number | undefined>;

export type OriginAccount = {
	address: `0x${string}`;
	signer: {
		origin: string;
		address: `0x${string}`;
		publicKey: `0x${string}`;
		privateKey: `0x${string}`;
		mnemonicKey: `0x${string}`;
	};
	metadata: {
		email?: string;
	};
	mechanismUsed: AuthMechanism | {type: string};
	savedPublicKeyPublicationSignature?: `0x${string}`;
	accountType: string;
};

// --- AUTH

export type AuthProviderSettings = {
	walletHost: string;
	[key: string]: unknown;
};

export type AuthState = {error?: {message: string; cause?: any}} & (
	| {
			step: 'Initialising';
			auto: boolean;
	  }
	| {
			step: 'Initialised';
	  }
	| {
			step: 'MechanismToChoose';
	  }
	| {
			step: 'InitialisingMechanism';
			mechanism: AuthMechanism;
	  }
	| {
			step: 'MechanismChosen';
			mechanism: AuthMechanism;
	  }

	// --------------------------------------------------------------------------------------------
	// Email
	// --------------------------------------------------------------------------------------------
	| {
			step: 'EmailToProvide';
			mechanism: EmailMechanism<undefined>;
	  }
	| {
			step: 'WaitingForOTP';
			mechanism: EmailMechanism<string>;
	  }
	| {
			step: 'VerifyingOTP';
			mechanism: EmailMechanism<string>;
	  }
	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// OAuth
	// --------------------------------------------------------------------------------------------
	| {
			step: 'InitializingOAuthPopup';
			mechanism: OauthMechanism;
	  }
	| {
			step: 'ConfirmOAuth';
			mechanism: OauthMechanism;
	  }
	| {
			step: 'WaitingForOAuthResponse';
			mechanism: OauthMechanism;
	  }
	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// Mnemonic
	// --------------------------------------------------------------------------------------------
	| {
			step: 'MnemonicIndexToProvide';
			mechanism: MnemonicMechanism<undefined>;
	  }

	// --------------------------------------------------------------------------------------------

	// --------------------------------------------------------------------------------------------
	// Final Success
	// --------------------------------------------------------------------------------------------
	| {
			step: 'GeneratingAccount';
			mechanism: AuthMechanism;
	  }
	| {
			step: 'SignedIn';
			mechanism: AuthMechanism;
			// account: EtherplayAccount; // TODO ?
			// originAccount ?
			requireOriginApproval:
				| false
				| {
						windowOrigin: string;
						signingOrigin: string;
						requestingAccess: boolean;
				  };
	  }
);

export interface AuthProvider {
	init(settings: AuthProviderSettings): Promise<void>;
	connect(mechanism: AuthMechanism): Promise<void>;
	provideOTP(otp: string): Promise<void>;
	confirmOAuth(): Promise<void>;
	getState(): AuthState;
}
