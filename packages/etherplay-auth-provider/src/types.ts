import type {OriginAccount} from '@etherplay/connect-core';

export type AuthProviderSettings = {
	walletHost: string;
	[key: string]: unknown;
};

export type AuthResult = {
	address: `0x${string}`;
	signer: {
		origin: string;
		address: `0x${string}`;
		publicKey: `0x${string}`;
		privateKey: `0x${string}`;
		mnemonicKey: `0x${string}`;
	};
	metadata: Record<string, unknown>;
	mechanismUsed: AuthMechanism;
	savedPublicKeyPublicationSignature: `0x${string}` | undefined;
	accountType: string;
};

export type AuthMechanism = EmailMechanism | OauthMechanism | MnemonicMechanism;

export type EmailMechanism = {
	type: 'email';
	email?: string;
	mode?: 'otp';
};

export type OauthMechanism = {
	type: 'oauth';
	provider: {id: string; connection?: string};
	usePopup?: boolean;
};

export type MnemonicMechanism = {
	type: 'mnemonic';
	mnemonic?: string;
	index?: number;
};

export type AuthState =
	| {step: 'Idle'}
	| {step: 'EmailToProvide'}
	| {step: 'WaitingForOTP'; email: string}
	| {step: 'VerifyingOTP'; email: string}
	| {step: 'ConfirmOAuth'; provider: string}
	| {step: 'WaitingForOAuthResponse'}
	| {step: 'GeneratingAccount'}
	| {step: 'SignedIn'; result: AuthResult}
	| {step: 'Error'; message: string};

export interface AuthProvider {
	init(settings: AuthProviderSettings): Promise<void>;
	connect(mechanism: AuthMechanism): Promise<void>;
	provideOTP(otp: string): Promise<void>;
	confirmOAuth(): Promise<void>;
	getState(): AuthState;
}
