import {createAlchemyConnection} from '@etherplay/alchemy';
import type {AlchemyConnectionStore, AlchemyMechanismIncludingRedirects} from '@etherplay/alchemy';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';
import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {
	AuthProvider,
	AuthResult,
	AuthState,
} from '@etherplay/auth-provider';
import {createOpenfortProvider} from '@etherplay/openfort';
import {
	fromEntropyKeyToMnemonic,
	fromSignatureToKey,
	originKeyMessage,
	originPublicKeyPublicationMessage,
} from '@etherplay/connect-core';

type Mechanism =
	| {type: 'email'; email?: string; mode?: 'otp'}
	| {type: 'oauth'; provider: {id: string; connection?: string}; usePopup?: boolean}
	| {type: 'oauth-redirect'; provider: {id: string; connection?: string}} & (
			| {alchemyOrgId: string; alchemyIdToken: string; alchemyBundle: string}
			| {error: string}
	  )
	| {type: 'mnemonic'; mnemonic: string; index?: number}
	| {type: 'magicLink'; bundle: string; orgId: string};

type UnifiedConnectionStore = {
	subscribe: (run: (value: UnifiedConnectionState) => void) => () => void;
	connect: (
		mechanism: Mechanism,
		redirect?: any,
	) => Promise<any>;
	provideOTP: (otp: string) => Promise<void>;
	confirmOAuth: () => Promise<void>;
	generateOriginAccount: (origin: string, account: any) => Promise<any>;
	confirmOriginAccess: () => void;
	provideEmail: (email: string) => Promise<void>;
	provideMnemonicIndex: (index: number) => Promise<void>;
};

export type UnifiedConnectionState =
	| {step: 'Idle'}
	| {step: 'Initialising'}
	| {step: 'Initialised'}
	| {step: 'MechanismToChoose'}
	| {step: 'InitialisingMechanism'; mechanism: Mechanism}
	| {step: 'MechanismChosen'; mechanism: Mechanism}
	| {step: 'EmailToProvide'}
	| {step: 'WaitingForOTP'; email: string}
	| {step: 'VerifyingOTP'; email: string}
	| {step: 'InitializingOAuthPopup'}
	| {step: 'ConfirmOAuth'; provider: string}
	| {step: 'WaitingForOAuthResponse'}
	| {step: 'MnemonicIndexToProvide'}
	| {step: 'GeneratingAccount'}
	| {step: 'SignedIn'; mechanism: Mechanism; account: any; requireOriginApproval: boolean | {windowOrigin: string; signingOrigin: string; requestingAccess: boolean}}
	| {step: 'Error'; message: string};

function createAlchemyConnectionStore(
	mechanism: Mechanism,
	params: {
		rpcURL?: string;
		apiKeyNotRecommended?: string;
		windowOrigin: string;
		signingOrigin: string;
		requestID: string;
		accountType: string;
		accountGenerator: AccountGenerator;
	},
): UnifiedConnectionStore {
	const {mechanism: mech, windowOrigin, signingOrigin, requestID, accountType} = {
		mechanism,
		...params,
	};

	let accountGenerator: AccountGenerator | undefined = undefined;
	if (accountType === 'ethereum') {
		accountGenerator = new EthereumAccountGenerator();
	}

	let alchemyConnection: AlchemyConnectionStore;
	if ('rpcURL' in params && params.rpcURL) {
		alchemyConnection = createAlchemyConnection({
			alchemy: {rpcURL: params.rpcURL},
			autoInitialise: false,
			accountGenerator,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	} else if ('apiKeyNotRecommended' in params && params.apiKeyNotRecommended) {
		alchemyConnection = createAlchemyConnection({
			alchemy: {apiKeyNotRecommended: params.apiKeyNotRecommended},
			autoInitialise: false,
			accountGenerator,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	} else {
		alchemyConnection = createAlchemyConnection({
			alchemy: {rpcURL: params.rpcURL || ''},
			autoInitialise: false,
			accountGenerator,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	}

	let currentMechanism: Mechanism | undefined;
	let currentAccount: any = null;
	let currentRequireOriginApproval: boolean | {windowOrigin: string; signingOrigin: string; requestingAccess: boolean} = false;

	// Subscribe to alchemy connection and map to unified state
	let currentState: UnifiedConnectionState = {step: 'Idle'};

	alchemyConnection.subscribe((v) => {
		if (!v) return;

		if (v.step === 'Initialising') {
			currentState = {step: 'Initialising'};
		} else if (v.step === 'Initialised') {
			currentState = {step: 'Initialised'};
		} else if (v.step === 'MechanismToChoose') {
			currentState = {step: 'MechanismToChoose'};
		} else if (v.step === 'InitialisingMechanism') {
			currentState = {step: 'InitialisingMechanism', mechanism: v.mechanism as any};
		} else if (v.step === 'MechanismChosen') {
			currentState = {step: 'MechanismChosen', mechanism: v.mechanism as any};
		} else if (v.step === 'EmailToProvide') {
			currentState = {step: 'EmailToProvide'};
		} else if (v.step === 'WaitingForOTP') {
			currentState = {step: 'WaitingForOTP', email: v.mechanism.email || ''};
		} else if (v.step === 'VerifyingOTP') {
			currentState = {step: 'VerifyingOTP', email: v.mechanism.email || ''};
		} else if (v.step === 'InitializingOAuthPopup') {
			currentState = {step: 'InitializingOAuthPopup'};
		} else if (v.step === 'ConfirmOAuth') {
			const providerId = 'provider' in v.mechanism ? (v.mechanism.provider as any).id : 'unknown';
			currentState = {step: 'ConfirmOAuth', provider: providerId};
		} else if (v.step === 'WaitingForOAuthResponse') {
			currentState = {step: 'WaitingForOAuthResponse'};
		} else if (v.step === 'MnemonicIndexToProvide') {
			currentState = {step: 'MnemonicIndexToProvide'};
		} else if (v.step === 'GeneratingAccount') {
			currentState = {step: 'GeneratingAccount'};
		} else if (v.step === 'SignedIn') {
			currentAccount = v.account;
			currentRequireOriginApproval = v.requireOriginApproval;
			const mechanismUsed = v.mechanism as any;
			const unifiedMech: Mechanism = {
				type: mechanismUsed.type,
				email: 'email' in mechanismUsed ? mechanismUsed.email : undefined,
				mode: 'mode' in mechanismUsed ? mechanismUsed.mode : undefined,
				provider: 'provider' in mechanismUsed ? mechanismUsed.provider : undefined,
				usePopup: 'usePopup' in mechanismUsed ? mechanismUsed.usePopup : undefined,
				mnemonic: 'mnemonic' in mechanismUsed ? mechanismUsed.mnemonic : undefined,
				index: 'index' in mechanismUsed ? mechanismUsed.index : undefined,
			};
			currentState = {
				step: 'SignedIn',
				mechanism: unifiedMech,
				account: v.account,
				requireOriginApproval: v.requireOriginApproval,
			};
		}
	});

	return {
		subscribe: alchemyConnection.subscribe,
		connect: async (mech: Mechanism, redir?: any) => {
			currentMechanism = mech;
			const alchemyMech: AlchemyMechanismIncludingRedirects = mapMechanismToAlchemy(mech);
			return alchemyConnection.connect(alchemyMech, redir);
		},
		provideOTP: async (otp: string) => {
			return alchemyConnection.provideOTP(otp);
		},
		confirmOAuth: async () => {
			return alchemyConnection.confirmOAuth();
		},
		generateOriginAccount: async (origin: string, account: any) => {
			return alchemyConnection.generateOriginAccount(origin, account);
		},
		confirmOriginAccess: () => {
			alchemyConnection.confirmOriginAccess();
		},
		provideEmail: async (email: string) => {
			return alchemyConnection.provideEmail(email);
		},
		provideMnemonicIndex: async (index: number) => {
			return alchemyConnection.provideMnemonicIndex(index);
		},
	};
}

function createOpenfortConnectionStore(
	mechanism: Mechanism,
	params: {
		windowOrigin: string;
		signingOrigin: string;
		requestID: string;
		accountType: string;
		accountGenerator: AccountGenerator;
	},
): UnifiedConnectionStore {
	const {windowOrigin, signingOrigin, accountType, accountGenerator} = params;

	const openfortProvider = createOpenfortProvider({
		publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
		shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
		walletHost: window.location.origin,
		accountGenerator,
		signingOrigin,
		windowOrigin,
	});

	let currentState: UnifiedConnectionState = {step: 'Idle'};
	let currentAccount: any = null;
	let currentMechanism: Mechanism | undefined;

	async function initProvider() {
		await openfortProvider.init({
			walletHost: window.location.origin,
			publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
			shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
		});
	}

	initProvider().catch(console.error);

	const providerState = openfortProvider.getState();
	if (providerState.step !== 'Idle') {
		currentState = mapOpenfortStateToUnified(providerState);
	}

	return {
		subscribe: (run: (value: UnifiedConnectionState) => void) => {
			const unsubscribe = () => {};
			const checkState = () => {
				const state = openfortProvider.getState();
				const mapped = mapOpenfortStateToUnified(state);
				run(mapped);
			};
			checkState();
			const interval = setInterval(checkState, 100);
			return () => clearInterval(interval);
		},
		connect: async (mech: Mechanism) => {
			currentMechanism = mech;
			const providerMech = mapMechanismToProvider(mech);
			await openfortProvider.connect(providerMech);

			const state = openfortProvider.getState();
			const mapped = mapOpenfortStateToUnified(state);
			if (mapped.step === 'SignedIn' && 'result' in mapped) {
				currentAccount = mapped.result;
			}
		},
		provideOTP: async (otp: string) => {
			await openfortProvider.provideOTP(otp);
			const state = openfortProvider.getState();
			const mapped = mapOpenfortStateToUnified(state);
			if (mapped.step === 'SignedIn' && 'result' in mapped) {
				currentAccount = mapped.result;
			}
		},
		confirmOAuth: async () => {
			await openfortProvider.confirmOAuth();
			const state = openfortProvider.getState();
			const mapped = mapOpenfortStateToUnified(state);
			if (mapped.step === 'SignedIn' && 'result' in mapped) {
				currentAccount = mapped.result;
			}
		},
		generateOriginAccount: async (origin: string, account: any) => {
			if (!currentAccount) {
				throw new Error('No account available');
			}
			const authResult = currentAccount as AuthResult;
			const originAccount = {
				address: authResult.address,
				signer: authResult.signer,
				metadata: authResult.metadata,
				mechanismUsed: authResult.mechanismUsed,
				savedPublicKeyPublicationSignature: authResult.savedPublicKeyPublicationSignature,
				accountType: authResult.accountType,
			};
			return originAccount;
		},
		confirmOriginAccess: () => {},
		provideEmail: async (email: string) => {
			if (!currentMechanism) {
				currentMechanism = {type: 'email', email};
			}
			const providerMech = mapMechanismToProvider({type: 'email', email, mode: 'otp'});
			await openfortProvider.connect(providerMech);
		},
		provideMnemonicIndex: async (index: number) => {
			if (!currentMechanism || currentMechanism.type !== 'mnemonic') {
				throw new Error('No mnemonic mechanism configured');
			}
			const providerMech = mapMechanismToProvider({
				type: 'mnemonic',
				mnemonic: currentMechanism.mnemonic,
				index,
			});
			await openfortProvider.connect(providerMech);
		},
	};
}

function mapOpenfortStateToUnified(state: AuthState): UnifiedConnectionState {
	switch (state.step) {
		case 'Idle':
			return {step: 'Idle'};
		case 'EmailToProvide':
			return {step: 'EmailToProvide'};
		case 'WaitingForOTP':
			return {step: 'WaitingForOTP', email: state.email};
		case 'VerifyingOTP':
			return {step: 'VerifyingOTP', email: state.email};
		case 'ConfirmOAuth':
			return {step: 'ConfirmOAuth', provider: state.provider};
		case 'WaitingForOAuthResponse':
			return {step: 'WaitingForOAuthResponse'};
		case 'GeneratingAccount':
			return {step: 'GeneratingAccount'};
		case 'SignedIn':
			return {
				step: 'SignedIn',
				mechanism: state.result.mechanismUsed as any,
				account: state.result,
				requireOriginApproval: false,
			};
		case 'Error':
			return {step: 'Error', message: state.message};
	}
}

function mapMechanismToProvider(mech: Mechanism): any {
	switch (mech.type) {
		case 'email':
			return {type: 'email', email: mech.email, mode: mech.mode};
		case 'oauth':
			return {type: 'oauth', provider: mech.provider, usePopup: mech.usePopup};
		case 'mnemonic':
			return {type: 'mnemonic', mnemonic: mech.mnemonic, index: mech.index};
		default:
			throw new Error(`Unsupported mechanism: ${(mech as any).type}`);
	}
}

function mapMechanismToAlchemy(mech: Mechanism): any {
	switch (mech.type) {
		case 'email':
			return {type: 'email', email: mech.email || '', mode: mech.mode || 'otp'};
		case 'oauth':
			if (mech.provider.id === 'auth0') {
				return {
					type: 'oauth',
					provider: {id: 'auth0', connection: mech.provider.connection || ''},
					usePopup: mech.usePopup ?? true,
				};
			}
			return {
				type: 'oauth',
				provider: {id: mech.provider.id as 'google' | 'facebook'},
				usePopup: mech.usePopup ?? true,
			};
		case 'mnemonic':
			return {type: 'mnemonic', mnemonic: mech.mnemonic || '', index: mech.index};
		default:
			throw new Error(`Unsupported mechanism: ${(mech as any).type}`);
	}
}

export function handle(
	params: ({rpcURL: string} | {apiKeyNotRecommended: string}) & {
		windowOrigin: string;
		signingOrigin: string;
		requestID: string;
		mechanism: Mechanism;
		accountType: string;
		provider: 'openfort' | 'alchemy';
		accountGenerator: AccountGenerator;
	},
): UnifiedConnectionStore {
	const {mechanism, provider, accountGenerator} = params;

	if (provider === 'openfort') {
		const store = createOpenfortConnectionStore(mechanism, {
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
			requestID: params.requestID,
			accountType: params.accountType,
			accountGenerator,
		});

		if (mechanism.type === 'oauth-redirect') {
			if ('error' in mechanism) {
				window.close();
			} else {
				// For Openfort, we'd need to handle the OAuth redirect callback
				// For now, just close the window
				window.close();
			}
		} else if (mechanism.type === 'mnemonic' || mechanism.type === 'email' || mechanism.type === 'oauth') {
			store.connect(mechanism).catch(console.error);
		}

		return store;
	}

	// Alchemy provider (existing behavior)
	const {mechanism: mech, windowOrigin, signingOrigin, requestID, accountType} = params;

	let accountGeneratorLocal: AccountGenerator | undefined = undefined;
	if (accountType === 'ethereum') {
		accountGeneratorLocal = new EthereumAccountGenerator();
	}

	let alchemyConnection: AlchemyConnectionStore;
	if ('rpcURL' in params && params.rpcURL) {
		alchemyConnection = createAlchemyConnection({
			alchemy: {rpcURL: params.rpcURL},
			autoInitialise: false,
			accountGenerator: accountGeneratorLocal,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	} else {
		alchemyConnection = createAlchemyConnection({
			alchemy: {apiKeyNotRecommended: params.apiKeyNotRecommended!},
			autoInitialise: false,
			accountGenerator: accountGeneratorLocal,
			windowOrigin: params.windowOrigin,
			signingOrigin: params.signingOrigin,
		});
	}

	alchemyConnection.subscribe((v) => console.log(v?.step));

	if (mechanism.type === 'oauth-redirect') {
		if ('error' in mechanism) {
			window.close();
		} else {
			alchemyConnection.completeOAuthWithBundle(
				mechanism as any,
				mechanism.alchemyBundle,
				mechanism.alchemyOrgId,
				mechanism.alchemyIdToken,
			);
		}
	} else if (mechanism.type === 'magicLink') {
	} else if (mechanism.type === 'mnemonic' || mechanism.type === 'email' || mechanism.type === 'oauth') {
		alchemyConnection.connect(mech, {windowOrigin, signingOrigin, id: requestID});
	} else {
		throw new Error(`Unknown mechanism type: ${(mechanism as any).type}`);
	}

	// Wrap Alchemy connection in unified interface
	const wrappedStore: UnifiedConnectionStore = {
		subscribe: alchemyConnection.subscribe,
		connect: async (mech: Mechanism, redir?: any) => {
			const alchemyMech = mapMechanismToAlchemy(mech);
			return alchemyConnection.connect(alchemyMech, redir);
		},
		provideOTP: async (otp: string) => alchemyConnection.provideOTP(otp),
		confirmOAuth: async () => alchemyConnection.confirmOAuth(),
		generateOriginAccount: async (origin: string, account: any) =>
			alchemyConnection.generateOriginAccount(origin, account),
		confirmOriginAccess: () => alchemyConnection.confirmOriginAccess(),
		provideEmail: async (email: string) => alchemyConnection.provideEmail(email),
		provideMnemonicIndex: async (index: number) => alchemyConnection.provideMnemonicIndex(index),
	};

	return wrappedStore;
}
