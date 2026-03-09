export type MnemonicMechanism<T extends number | undefined> = {
	type: 'mnemonic';
	mnemonic: string;
	index: T;
};

export type OauthMechanism = {
	type: 'oauth';

	provider: {id: 'google' | 'facebook'} | {id: 'auth0'; connection: string};
} & ({usePopup: true} | {usePopup: false}); // redirection: { origin: string; requestID: string }

export type EmailMechanism<T extends string | undefined> = {
	type: 'email';
	email: T;
	mode: 'otp';
};

export type AlchemyMechanism =
	| EmailMechanism<string | undefined>
	| OauthMechanism
	| MnemonicMechanism<number | undefined>;

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
