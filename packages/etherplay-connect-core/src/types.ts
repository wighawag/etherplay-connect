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

// --- PERMISSIONS

/**
 * Authority to act for this account onchain, at ONE contract on ONE chain.
 *
 * The pair is the whole of it: the contract's own address is inside the signed bytes, so a
 * credential granted here is worth nothing anywhere else. See @etherplay/delegation.
 */
export type DelegationPermissionRequest = {
	type: 'delegation';
	required: boolean;
	chainId: number;
	contract: `0x${string}`;
};

/**
 * Something the app asked for that this wallet cannot describe, let alone grant.
 *
 * It exists as a case rather than as a gap because the alternative is dropping it, and a dropped
 * request is how an old host and a new app end up disagreeing about what was granted. It is always
 * denied, and always shown and reported as "this site asked for something this wallet does not
 * understand".
 */
export type UnrecognizedPermissionRequest = {
	type: 'unrecognized';
	required: boolean;
	/** what the app called it, kept so the UI and the app can both name it */
	requestedType: string;
};

/** Declared by the app at connect time. `required` denied fails sign-in; optional does not. */
export type PermissionRequest = DelegationPermissionRequest | UnrecognizedPermissionRequest;

/**
 * Everything that must be settled before a signed-in result may be handed to the opener.
 *
 * Approval is enforced by WITHHOLDING THE RESULT, not by asking the app to behave: the app does not
 * receive the thing, rather than receiving it with a flag it is trusted to respect.
 */
export type OriginApprovalRequest = {
	windowOrigin: string;
	signingOrigin: string;
	/** the account-access gate: this window is not the origin being signed for */
	requestingAccess: boolean;
	/** what the app declared at connect time; empty when it asked for nothing */
	permissions: PermissionRequest[];
};

/**
 * The answer to one request, and it is an ANSWER rather than an absence.
 *
 * A denial has to be reported, not merely reflected in a missing credential, because an app cannot
 * tell "you declined" from "nobody asked" without being told, and the two call for different
 * remedies: one is a re-prompt, the other is a misconfiguration the app should say so about.
 */
export type PermissionOutcome =
	| {
			request: PermissionRequest;
			granted: true;
			/** unix seconds the credential stops being registrable; 0 means no expiry */
			deadline: number;
	  }
	| {
			request: PermissionRequest;
			granted: false;
			/**
			 * `denied`: a human said no.
			 * `unsupported`: this wallet does not understand the request, so nobody was asked.
			 */
			reason: 'denied' | 'unsupported';
	  };

/**
 * A delegation credential, cached from the bytes that were signed.
 *
 * EVERY FIELD HERE IS ALSO INSIDE THE SIGNATURE. They are a cache of it, not metadata beside it, so
 * a stored copy that disagrees with the signed copy cannot be detected locally: the signature
 * simply fails to recover. A failure on the signature path must therefore invalidate this record
 * and ask for a fresh one rather than being reported as a contract error, which makes any
 * disagreement self-healing.
 *
 * `delegate` is redundant today, always being the origin signer, but it makes the record
 * self-describing and catches a mismatch locally instead of onchain.
 */
export type SavedDelegation = {
	chainId: number;
	contract: `0x${string}`;
	delegate: `0x${string}`;
	/** unix seconds; 0 means no expiry */
	deadline: number;
	signature: `0x${string}`;
};

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
	// Credentials authorizing `signer.address` to act onchain for this account, one per
	// (chainId, contract) the app asked for and the user (or the host's allowlist) granted.
	//
	// A LIST, not a field, because authority is per contract: there is no such thing as "the"
	// delegation. Empty when nothing was asked for or nothing was granted, which is why the
	// outcomes below are the thing to read when an app wants to know WHY it has nothing.
	savedDelegations: SavedDelegation[];
	// The answer to every permission the app requested, granted or not. Present whenever the app
	// asked for anything.
	permissions?: PermissionOutcome[];
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
			// What must be settled before the result may be handed to the opener, or `false` when
			// there is nothing to settle. `permissions` extends the existing access gate per entry
			// rather than replacing it.
			requireOriginApproval: false | OriginApprovalRequest;
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
}
