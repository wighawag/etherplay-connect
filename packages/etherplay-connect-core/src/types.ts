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

export type AlchemyMechanism =
	| EmailMechanism<string | undefined>
	| OauthMechanism
	| MnemonicMechanism<number | undefined>;

export type ProviderOauthMechanism = {
	type: 'oauth';
	provider: {id: string; connection?: string};
	usePopup?: boolean;
};

export type ProviderEmailMechanism = {
	type: 'email';
	email?: string;
	mode?: 'otp';
};

export type ProviderMnemonicMechanism = {
	type: 'mnemonic';
	mnemonic?: string;
	index?: number;
};

export type ProviderMechanism = ProviderEmailMechanism | ProviderOauthMechanism | ProviderMnemonicMechanism;

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
	mechanismUsed: AlchemyMechanism | {type: string};
	savedPublicKeyPublicationSignature?: `0x${string}`;
	accountType: string;
};
