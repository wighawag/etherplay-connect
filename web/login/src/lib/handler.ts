import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {AuthProvider, AuthState, OriginAccount} from '@etherplay/connect-core';
import {createOpenfortProvider} from '@etherplay/openfort';
import {fromEntropyKeyToMnemonic, fromSignatureToKey, originKeyMessage} from '@etherplay/connect-core';
import {writable} from 'svelte/store';
import type {Readable} from 'svelte/store';

export interface ConnectionStore extends AuthProvider, Readable<AuthState> {
	generateOriginAccount: (origin: string) => Promise<OriginAccount>;
	provideEmail: (email: string) => Promise<void>;
	provideMnemonicIndex: (index: number) => Promise<void>;
}

function createOpenfortConnection(
	accountGenerator: AccountGenerator,
	windowOrigin: string,
	signingOrigin: string,
): ConnectionStore {
	const provider = createOpenfortProvider({
		publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
		shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
		walletHost: window.location.origin,
		accountGenerator,
		signingOrigin,
		windowOrigin,
	});

	let initPromise: Promise<void>;
	let currentAccount: OriginAccount | null = null;

	async function initProvider() {
		await provider.init({
			walletHost: window.location.origin,
			publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
			shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
		});
	}

	initPromise = initProvider().catch(console.error);

	const stateStore = writable<AuthState>(provider.getState());
	const interval = setInterval(() => stateStore.set(provider.getState()), 100);

	return {
		init: async (settings) => {
			await initPromise;
			await provider.init(settings);
			stateStore.set(provider.getState());
		},
		connect: async (mechanism) => {
			await initPromise;
			await provider.connect(mechanism);
			const state = provider.getState();
			stateStore.set(state);
			if (state.step === 'SignedIn') {
				currentAccount = state.result;
			}
		},
		provideOTP: async (otp) => {
			await initPromise;
			await provider.provideOTP(otp);
			const state = provider.getState();
			stateStore.set(state);
			if (state.step === 'SignedIn') {
				currentAccount = state.result;
			}
		},
		confirmOAuth: async () => {
			await initPromise;
			await provider.confirmOAuth();
			const state = provider.getState();
			stateStore.set(state);
			if (state.step === 'SignedIn') {
				currentAccount = state.result;
			}
		},
		getState: () => provider.getState(),
		subscribe: stateStore.subscribe,
		generateOriginAccount: async (origin: string): Promise<OriginAccount> => {
			if (!currentAccount) {
				throw new Error('No account available');
			}

			const accountMnemonic = fromEntropyKeyToMnemonic(currentAccount.signer.mnemonicKey);
			const accountObject = accountGenerator.fromMnemonicToAccount(accountMnemonic, 0);

			const originKeySignature = await accountGenerator.signTextMessage(
				originKeyMessage(origin),
				accountObject.privateKey,
			);

			const originKey = fromSignatureToKey(originKeySignature);
			const originMnemonic = fromEntropyKeyToMnemonic(originKey);
			const originAccount = accountGenerator.fromMnemonicToAccount(originMnemonic, 0);

			return {
				address: account.address,
				signer: {
					origin,
					address: originAccount.address,
					publicKey: originAccount.publicKey,
					privateKey: originAccount.privateKey,
					mnemonicKey: originKey,
				},
				metadata: account.metadata,
				mechanismUsed: account.mechanismUsed,
				savedPublicKeyPublicationSignature: account.savedPublicKeyPublicationSignature,
				accountType: account.accountType,
			};
		},
		provideEmail: async (email: string) => {
			await provider.connect({type: 'email', email, mode: 'otp'});
			stateStore.set(provider.getState());
		},
		provideMnemonicIndex: async (index: number) => {
			const state = provider.getState();
			if (state.step !== 'SignedIn') {
				throw new Error('Not signed in');
			}
			await provider.connect({type: 'mnemonic', mnemonic: '', index});
			stateStore.set(provider.getState());
		},
	};
}

export function createConnection(
	accountGenerator: AccountGenerator,
	windowOrigin: string,
	signingOrigin: string,
): ConnectionStore {
	return createOpenfortConnection(accountGenerator, windowOrigin, signingOrigin);
}
