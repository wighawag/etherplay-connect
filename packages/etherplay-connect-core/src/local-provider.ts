/**
 * AN ACCOUNT WHOSE KEY COMES FROM THIS BROWSER AND NO SERVICE.
 *
 * Named `local` rather than `mnemonic` because what defines it is the ABSENCE of a service, not the
 * mechanism: a raw private key, or a key from hardware, would belong here too. Today it implements
 * exactly one mechanism.
 *
 * It used to be a branch inside `@etherplay/openfort`, where it touched `openfortInstance` nowhere
 * and needed neither a publishable key nor a network. Living there meant a vendor SDK was
 * constructed on a path that never called it, so a vendor version bump could break a sign-in that
 * does not involve the vendor, and the failure would have looked like an application bug.
 *
 * WHY IN connect-core AND NOT A PACKAGE OF ITS OWN. Everything this file needs - the derivation, the
 * mechanism types, the approval question - is already here, and a separate package would be one
 * more version to keep in lockstep with this one. When the two drift, a tree ends up with two
 * copies of the derivation resolved at two versions, which is the exact failure `@etherplay/delegation`
 * was created to end. `@etherplay/openfort` is a separate package because it drags a vendor SDK;
 * this drags nothing.
 *
 * An app that only uses `@etherplay/connect` never references it, and this package declares
 * `"sideEffects": false`, which is what lets a bundler drop it rather than merely permitting it to
 * in principle. Nothing here runs at import time.
 */
import {mnemonicToEntropy} from '@scure/bip39';
import {wordlist} from '@scure/bip39/wordlists/english';
import {bytesToHex} from '@noble/hashes/utils';
import type {AccountGenerator} from '@etherplay/wallet-connector';
import {originApprovalRequired, type OriginContext} from './access.js';
import type {
	AuthMechanism,
	AuthProvider,
	AuthProviderSettings,
	AuthState,
	EtherplayAccount,
	OauthMechanism,
	Redirection,
} from './types.js';

// The origins and the declared permissions come as ONE value, so the two same-typed origin strings
// cannot be swapped on the way in. This provider decides none of it; it carries the permissions into
// `AuthState` so the UI can ask, and the origins into the approval gate.
export type LocalProviderSettings = OriginContext & {
	accountGenerator: AccountGenerator;
};

/**
 * The smallest store that satisfies the contract `AuthProvider` extends.
 *
 * Written here rather than depended on, because it is fifteen lines and this package deliberately
 * has no store library, no framework and no browser globals in its dependency list.
 */
function createStateStore(initial: AuthState) {
	let current = initial;
	const subscribers = new Set<(state: AuthState) => void>();
	return {
		subscribe(run: (state: AuthState) => void): () => void {
			subscribers.add(run);
			// Called immediately with the current value: the store contract every Svelte consumer,
			// including `$authProvider` in the host, relies on.
			run(current);
			return () => {
				subscribers.delete(run);
			};
		},
		set(state: AuthState) {
			current = state;
			for (const run of [...subscribers]) {
				run(current);
			}
		},
		get(): AuthState {
			return current;
		},
	};
}

/** Said the same way by every method that cannot do its job here, so the reason is never a guess. */
function notLocal(what: string): Error {
	return new Error(
		`${what} is hosted authentication and the local provider has no host: it derives the account from a mnemonic in this browser. ` +
			`Route this mechanism to a hosted provider (the host does this by mechanism, not by the "provider" query parameter).`,
	);
}

export function createLocalProvider(settings: LocalProviderSettings): AuthProvider {
	const store = createStateStore({step: 'Idle'} as AuthState);

	/**
	 * Nothing to initialise, and that is the property worth keeping.
	 *
	 * No key, no SDK, no network: a mnemonic sign-in completes in a host built with no vendor
	 * credentials at all, offline, over plain http. The two steps are still emitted so the host's
	 * UI sees the same sequence it sees from a hosted provider.
	 */
	async function init(_providerSettings?: AuthProviderSettings): Promise<void> {
		store.set({step: 'Initialising', auto: true});
		store.set({step: 'Initialised'});
	}

	async function connect(mechanism: AuthMechanism, _redirection?: Redirection): Promise<void> {
		if (mechanism.type !== 'mnemonic') {
			throw notLocal(`"${mechanism.type}"`);
		}

		if (mechanism.index === undefined) {
			store.set({
				step: 'MnemonicIndexToProvide',
				mechanism: {type: 'mnemonic', mnemonic: mechanism.mnemonic, index: undefined},
			});
			return;
		}

		store.set({step: 'GeneratingAccount', mechanism});

		const mnemonic = mechanism.mnemonic;
		const index = mechanism.index ?? 0;

		const viemAccount = settings.accountGenerator.fromMnemonicToAccount(mnemonic, index);
		const keyUint8Array = mnemonicToEntropy(mnemonic, wordlist);
		const key = `0x${bytesToHex(keyUint8Array)}` as `0x${string}`;
		const address = viemAccount.address.toLowerCase() as `0x${string}`;
		const account: EtherplayAccount = {
			localAccount: {
				address,
				index,
				key,
			},
			signer: {
				mechanismUsed: mechanism,
				// A FABRICATED user, and deliberately so: there is no account at any service behind
				// this one. `orgId: 'mnemonic'` is the clearest available statement of that.
				user: {
					address,
					orgId: 'mnemonic',
					userId: `${index}@mnemonic.id`,
					email: `${index}@mnemonic.id`,
				},
			},
			accountType: settings.accountGenerator.type,
		};

		store.set({
			step: 'SignedIn',
			mechanism,
			account,
			requireOriginApproval: originApprovalRequired(settings),
		});
	}

	async function provideMnemonicIndex(index: number): Promise<void> {
		const currentState = store.get();
		if (currentState.step !== 'MnemonicIndexToProvide') {
			throw new Error('no mnemonic index to provide');
		}
		await connect({type: 'mnemonic', mnemonic: currentState.mechanism.mnemonic, index});
	}

	// The three below exist because `AuthProvider` asks for them, and they throw because this
	// provider genuinely cannot answer them. Narrowing the interface so a provider only declares the
	// mechanisms it implements is the honest fix and touches every consumer; it is parked until
	// there is a second local mechanism to justify it.
	async function provideEmail(_email: string): Promise<void> {
		throw notLocal('email sign-in');
	}
	async function provideOTP(_otp: string): Promise<void> {
		throw notLocal('an email OTP');
	}
	async function confirmOAuth(
		_mechanism: OauthMechanism,
		_searchParams: URLSearchParams,
		_redirection: Redirection,
	): Promise<void> {
		throw notLocal('an OAuth callback');
	}

	return {
		subscribe: store.subscribe,
		init,
		connect,
		provideEmail,
		provideOTP,
		provideMnemonicIndex,
		confirmOAuth,
	};
}
