export type MnemonicMechanism<T extends number | undefined> = {
	type: 'mnemonic';
	mnemonic: string;
	index: T;
};

export type OauthMechanism = {
	type: 'oauth';

	provider: {id: string} & ({} | {connection: string});
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
	[key: string]: unknown;
};

export type EtherplayAccount = {
	localAccount: {
		address: `0x${string}`;
		index: number;
		key: `0x${string}`;
	};
	signer: {
		mechanismUsed: AuthMechanism;
		[key: string]: unknown;
	};
	accountType: string;
};

export type AuthState = {error?: {message: string; cause?: any}} & (
	| {
			step: 'Idle';
	  }
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

type Readable<T> = {
	subscribe(func: (state: T) => void): () => void;
};

export type Redirection = {windowOrigin: string; signingOrigin: string; id: string};

export interface AuthProvider extends Readable<AuthState> {
	init(settings?: AuthProviderSettings): Promise<void>;
	connect(mechanism: AuthMechanism, redirection?: Redirection): Promise<void>;
	provideEmail: (email: string) => Promise<void>;
	provideOTP(otp: string): Promise<void>;
	provideMnemonicIndex: (index: number) => Promise<void>;
	confirmOAuth(mechanism: OauthMechanism, searchParams: URLSearchParams, redirection: Redirection): Promise<void>;
	generateOriginAccount: (origin: string, account: EtherplayAccount) => Promise<OriginAccount>;
	getState(): AuthState;
}
