// The backend-free configuration: `targetStep: 'SignedIn'` + `walletOnly: true` + NO `walletHost`.
//
// It means: sign the user in and derive the local session signer, but offer only built-in
// (injected / EIP-6963) wallets as the owner. No hosted email/social mechanism, no popup, no
// backend of any kind. Everything happens in the page: the wallet signs `originKeyMessage(origin)`
// and the signature is stretched into the session key locally.
//
// The type surface already promises it: on the `walletOnly: true` SignedIn overloads `walletHost`
// is `walletHost?: string`, while on the `walletOnly?: false` SignedIn overloads it stays
// `walletHost: string`. That split is deliberate (see the README section "Wallet-only sign-in with
// no backend"), but until now it was ONLY expressed in the types, so nothing stopped a change to
// the runtime from quietly requiring a host again.
//
// These tests lock the configuration in end-to-end. They deliberately use the REAL default
// Ethereum connector and a REAL EIP-6963 announcement, so the session account is derived by the
// real generator: a mock connector would prove the state machine moves, not that a usable signer
// comes out the other end with no host configured.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {fromPrivateKey} from '@etherplay/wallet-connector-ethereum';
import {
	createConnection,
	originKeyMessage,
	originPublicKeyPublicationMessage,
	type Connection,
	type UnderlyingEthereumProvider,
} from '../src/index.js';

const ACCOUNT = `0x1111111111111111111111111111111111111111` as `0x${string}`;

// A deterministic, valid-hex 65-byte signature. The real `fromSignatureToKey` hashes it, so it
// only has to be hex, but it must be STABLE: the whole point of the configuration is that the
// same wallet signature always regenerates the same session account.
const SIGNATURE = `0x${'ab'.repeat(65)}` as `0x${string}`;

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

// `originToSignWith()` falls back to the bare `origin` global when no `signingOrigin` is given,
// which is exactly the path this configuration takes. Real browsers define it; happy-dom does not,
// so the tests restore it to `location.origin` to match a real page. Doing it here rather than
// passing `signingOrigin` is the point: it keeps the tests on the no-extra-settings path.
const PAGE_ORIGIN = 'http://localhost:3000';

type InstalledWallet = {
	uninstall: () => void;
	signMessageCalls: () => {message: string; account: string}[];
	setSignBehaviour: (fn: () => Promise<`0x${string}`>) => void;
	/**
	 * Make the wallet refuse to authorize accounts, as a user declining the connection prompt does.
	 * Only `eth_requestAccounts` is affected: `eth_accounts` keeps answering `[]`, which is what a
	 * real wallet reports for a site it has not authorized.
	 */
	rejectAuthorization: (error: unknown) => void;
};

/**
 * Install an EIP-6963 wallet in the page: it announces itself on every `eip6963:requestProvider`,
 * exactly as a real wallet extension does, and answers the RPC methods the connect + sign flow uses.
 */
function installWallet(options?: {uuid?: string; rdns?: string; name?: string; accounts?: `0x${string}`[]}) {
	const info = {
		uuid: options?.uuid ?? 'uuid-injected-wallet',
		name: options?.name ?? 'Injected Wallet',
		icon: '',
		rdns: options?.rdns ?? 'com.example.injected',
	};

	const signMessageCalls: {message: string; account: string}[] = [];
	let sign: () => Promise<`0x${string}`> = async () => SIGNATURE;
	const accounts = options?.accounts ?? [ACCOUNT];
	let authorizationError: unknown | undefined;

	const provider = {
		request: async ({method, params}: {method: string; params?: any[]}) => {
			switch (method) {
				case 'eth_chainId':
					return '0x1';
				case 'eth_accounts':
					return authorizationError ? [] : accounts;
				case 'eth_requestAccounts':
					if (authorizationError) {
						throw authorizationError;
					}
					return accounts;
				case 'personal_sign':
					signMessageCalls.push({message: params?.[0], account: params?.[1]});
					return sign();
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: () => {},
		removeListener: () => {},
	};

	const onRequest = () => {
		window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info, provider}}));
	};
	window.addEventListener('eip6963:requestProvider', onRequest);

	const installed: InstalledWallet = {
		uninstall: () => window.removeEventListener('eip6963:requestProvider', onRequest),
		signMessageCalls: () => signMessageCalls,
		setSignBehaviour: (fn) => {
			sign = fn;
		},
		rejectAuthorization: (error) => {
			authorizationError = error;
		},
	};
	return installed;
}

/**
 * THE configuration under test. Note what is NOT here: no `walletHost`, no `signingOrigin`,
 * no `walletConnector`. Just "sign me in, with an injected wallet, on this origin".
 */
function createBackendFreeConnection(overrides?: {autoConnect?: boolean; storagePrefix?: string}) {
	return createConnection({
		targetStep: 'SignedIn',
		walletOnly: true,
		chainInfo,
		autoConnect: overrides?.autoConnect ?? false,
		storagePrefix: overrides?.storagePrefix,
	});
}

function currentState(store: {
	subscribe: (run: (v: Connection<UnderlyingEthereumProvider>) => void) => () => void;
}): Connection<UnderlyingEthereumProvider> {
	let value!: Connection<UnderlyingEthereumProvider>;
	store.subscribe((v) => {
		value = v;
	})();
	return value;
}

/** Record every step the connection passes through, so "never entered X" is checkable. */
function recordSteps(store: {subscribe: (run: (v: Connection<UnderlyingEthereumProvider>) => void) => () => void}) {
	const steps: string[] = [];
	const unsubscribe = store.subscribe((v) => {
		if (steps[steps.length - 1] !== v.step) {
			steps.push(v.step);
		}
	});
	return {steps, unsubscribe};
}

/**
 * Derive the Ethereum address of a private key, to check the session signer is internally
 * consistent. This goes private key -> public key -> address, which is a different route from the
 * one that produced the signer (signature -> entropy -> mnemonic -> HD derivation), so agreement
 * between the two really does say the key and the address belong together.
 */
function addressOfPrivateKey(privateKey: `0x${string}`): string {
	return fromPrivateKey(privateKey).toLowerCase();
}

let wallet: InstalledWallet | undefined;
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
	// Nothing in this configuration may reach for a popup. `window.open` is the single choke point
	// every popup path goes through, so spying on it catches any of them.
	openSpy = vi.spyOn(window, 'open').mockImplementation(() => {
		throw new Error('window.open must never be called in the wallet-only, no-host configuration');
	});
	vi.useFakeTimers();
});

afterEach(() => {
	wallet?.uninstall();
	wallet = undefined;
	openSpy.mockRestore();
	delete (globalThis as {origin?: string}).origin;
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe('createConnection with walletOnly and no walletHost', () => {
	it('constructs successfully', () => {
		wallet = installWallet();

		const connection = createBackendFreeConnection();

		expect(connection.targetStep).toBe('SignedIn');
		expect(connection.walletOnly).toBe(true);
		// Construction never validates a host, and never launches anything.
		expect(openSpy).not.toHaveBeenCalled();
	});

	it('constructs even with no wallet installed at all', () => {
		// No host AND no wallet is a legitimate cold start: the page renders, the user is simply
		// not connectable yet. It must not throw at construction time.
		const connection = createBackendFreeConnection();

		const state = currentState(connection);
		expect(state.step).toBe('Idle');
		expect(state.wallets).toHaveLength(0);
	});

	it('discovers the announcing EIP-6963 wallet', () => {
		wallet = installWallet();

		const connection = createBackendFreeConnection();

		const wallets = currentState(connection).wallets;
		expect(wallets).toHaveLength(1);
		expect(wallets[0].info.rdns).toBe('com.example.injected');
	});
});

describe('connecting reaches WalletConnected without the mechanism picker', () => {
	it('goes straight to WalletConnected, never through MechanismToChoose or PopupLaunched', async () => {
		wallet = installWallet();
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(currentState(connection).step).toBe('WalletConnected');
		expect(recorder.steps).not.toContain('MechanismToChoose');
		expect(recorder.steps).not.toContain('PopupLaunched');
		expect(openSpy).not.toHaveBeenCalled();
		recorder.unsubscribe();
	});

	it('defaults the mechanism to wallet, so connect() with no argument never reaches the picker', async () => {
		// This is the property that makes the mechanism picker unreachable: `connect()` with no
		// mechanism defaults to `{type: 'wallet'}` under `walletOnly`. Without it, a no-argument
		// call would rest on `MechanismToChoose`, a step this app has no host to serve.
		wallet = installWallet();
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const connecting = connection.connect();
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(currentState(connection).step).toBe('WalletConnected');
		expect(recorder.steps).not.toContain('MechanismToChoose');
		recorder.unsubscribe();
	});

	it('rests on a renderable step when the wallet rejects, never on MechanismToChoose', async () => {
		// A wallet-only app renders no mechanism picker, so resting there would be a dead end.
		wallet = installWallet();
		wallet.rejectAuthorization(Object.assign(new Error('User rejected the request.'), {code: 4001}));
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// One wallet installed, so the rest step is `Idle`: there is no other wallet to offer.
		expect(currentState(connection).step).toBe('Idle');
		expect(currentState(connection).error).toBeDefined();
		expect(recorder.steps).not.toContain('MechanismToChoose');
		recorder.unsubscribe();
	});
});

describe('signing reaches SignedIn with a usable local signer', () => {
	async function signIn() {
		wallet = installWallet();
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		return {connection, recorder};
	}

	it('reaches SignedIn', async () => {
		const {connection, recorder} = await signIn();

		const state = currentState(connection);
		expect(state.step).toBe('SignedIn');
		expect(recorder.steps).toContain('WaitingForSignature');
		expect(recorder.steps).not.toContain('MechanismToChoose');
		expect(recorder.steps).not.toContain('PopupLaunched');
		recorder.unsubscribe();
	});

	it('yields a session signer with a real address and private key', async () => {
		const {connection} = await signIn();
		const state = currentState(connection);

		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}

		const signer = state.account.signer;
		expect(signer.address).toMatch(/^0x[0-9a-f]{40}$/);
		expect(signer.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
		expect(signer.publicKey).toMatch(/^0x[0-9a-f]+$/);

		// And NOT the entropy it was all derived from. This assertion is the guard that keeps the
		// field from coming back: `mnemonicKey` used to be the origin entropy key, persisted to both
		// storages, from which every key this origin can derive is reconstructible. The session needs
		// the derived private key above and nothing more.
		expect(signer).not.toHaveProperty('mnemonicKey');

		// The signer is not a placeholder: the address really is this private key's address,
		// so the app can sign with it.
		expect(addressOfPrivateKey(signer.privateKey)).toBe(signer.address.toLowerCase());

		// The owner is the wallet account, and it is distinct from the derived session account.
		expect(state.account.address).toBe(ACCOUNT);
		expect(signer.address.toLowerCase()).not.toBe(ACCOUNT.toLowerCase());
	});

	it('signs over the page own origin, since no signingOrigin and no host are configured', async () => {
		const {connection} = await signIn();
		const state = currentState(connection);

		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}

		// `originToSignWith()` is `settings.signingOrigin || origin`. With neither a host nor a
		// signingOrigin, the identity is bound to the page itself: that is what makes the
		// configuration backend-free rather than merely host-less.
		expect(state.account.signer.origin).toBe(PAGE_ORIGIN);
		expect(originKeyMessage(PAGE_ORIGIN)).toContain(PAGE_ORIGIN);
	});

	it('derives the session account from the wallet signature alone', async () => {
		const {connection} = await signIn();
		const state = currentState(connection);

		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}

		// Exactly one wallet interaction produced the identity: the origin-key signature.
		// Anything else would mean a second party had a say in the derivation.
		const calls = wallet!.signMessageCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].account).toBe(ACCOUNT);

		// And it is reproducible: the same wallet signature yields the same session account,
		// which is what lets a returning user recover their signer with no server to ask.
		localStorage.clear();
		sessionStorage.clear();
		wallet!.uninstall();

		const second = installWallet();
		const secondConnection = createBackendFreeConnection();
		const connecting = secondConnection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = secondConnection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		second.uninstall();

		const secondState = currentState(secondConnection);
		if (secondState.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${secondState.step}`);
		}
		expect(secondState.account.signer.address).toBe(state.account.signer.address);
		expect(secondState.account.signer.privateKey).toBe(state.account.signer.privateKey);
	});

	it('falls back to WalletConnected, not to a popup, when the user declines the signature', async () => {
		// The signature is the only thing standing between WalletConnected and SignedIn here. If the
		// user declines it there is no hosted mechanism to fall back to, so the flow must stay on the
		// wallet step where the app can simply ask again.
		wallet = installWallet();
		wallet.setSignBehaviour(async () => {
			throw Object.assign(new Error('User rejected the request.'), {code: 4001});
		});
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		const state = currentState(connection);
		expect(state.step).toBe('WalletConnected');
		expect(state.error).toBeDefined();
		expect(recorder.steps).not.toContain('MechanismToChoose');
		expect(recorder.steps).not.toContain('PopupLaunched');
		expect(openSpy).not.toHaveBeenCalled();
		recorder.unsubscribe();
	});

	it('ensureConnected() resolves at SignedIn', async () => {
		wallet = installWallet();
		const connection = createBackendFreeConnection();
		const recorder = recordSteps(connection);

		const ensuring = connection.ensureConnected({requestSignatureRightAway: true});
		await vi.advanceTimersByTimeAsync(500);
		const state = await ensuring;

		// The default `ensureConnected()` overload for this configuration is typed
		// `Promise<SignedInWithWallet>`, i.e. `account.signer` and `wallet` are both non-optional.
		expect(state.step).toBe('SignedIn');
		expect(state.account.signer.address).toMatch(/^0x[0-9a-f]{40}$/);
		expect(state.wallet.status).toBe('connected');
		expect(recorder.steps).not.toContain('MechanismToChoose');
		expect(openSpy).not.toHaveBeenCalled();
		recorder.unsubscribe();
	});
});

describe('no popup path is ever entered', () => {
	it('window.open is never called across a full connect + sign + publish cycle', async () => {
		wallet = installWallet();
		const connection = createBackendFreeConnection();

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		await connection.getSignatureForPublicKeyPublication();

		expect(openSpy).not.toHaveBeenCalled();
	});

	it('a popup mechanism is still refused outright rather than building a URL from an undefined host', async () => {
		// `walletOnly` makes the popup mechanisms unreachable through the normal flow, and the type
		// surface does not offer them. If one is forced through anyway, the guard must reject it
		// BEFORE `new URL(`${undefined}/login/`)` is ever attempted, so the failure names the real
		// cause instead of surfacing as a bogus URL parse error.
		wallet = installWallet();
		const connection = createBackendFreeConnection();

		await expect(
			(connection as {connect: (m: unknown) => Promise<void>}).connect({
				type: 'email',
				mode: 'otp',
				email: 'user@example.com',
			}),
		).rejects.toThrow(/walletHost is required/);

		expect(openSpy).not.toHaveBeenCalled();
	});
});

describe('getSignatureForPublicKeyPublication needs no host in this configuration', () => {
	// Flagged as the one method that sounded host-adjacent: publishing the public key. It is not.
	// On a wallet mechanism it asks the connected wallet to sign the publication message locally,
	// exactly like the origin-key signature. It is fully available here, and this test says so, so
	// nobody has to re-derive it from the source or document it as unavailable.
	it('returns a wallet signature over the publication message', async () => {
		wallet = installWallet();
		const connection = createBackendFreeConnection();

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		const before = wallet.signMessageCalls().length;
		const signature = await connection.getSignatureForPublicKeyPublication();

		expect(signature).toBe(SIGNATURE);

		// It went to the wallet, on the owner account, and to nothing else.
		const calls = wallet.signMessageCalls();
		expect(calls).toHaveLength(before + 1);
		expect(calls[before].account).toBe(ACCOUNT);
		expect(openSpy).not.toHaveBeenCalled();

		// The message is the origin publication message for the derived public key, over the
		// page's own origin: no host takes part in deciding what gets published.
		const state = currentState(connection);
		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}
		expect(originPublicKeyPublicationMessage(PAGE_ORIGIN, state.account.signer.publicKey)).toContain(
			state.account.signer.publicKey,
		);
	});
});

describe('auto-connect works with no host', () => {
	it('restores the session on reload, from local storage alone', async () => {
		wallet = installWallet();

		// First visit: connect and sign in, which persists the session.
		const first = createBackendFreeConnection();
		const connecting = first.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = first.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		const firstState = currentState(first);
		if (firstState.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${firstState.step}`);
		}

		// Second visit: a fresh connection with autoConnect, no user gesture, no host to ask.
		const second = createBackendFreeConnection({autoConnect: true});
		await vi.advanceTimersByTimeAsync(1500);

		const secondState = currentState(second);
		expect(secondState.step).toBe('SignedIn');
		if (secondState.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${secondState.step}`);
		}
		expect(secondState.account.signer.address).toBe(firstState.account.signer.address);
		expect(openSpy).not.toHaveBeenCalled();
	});
});

describe('the wallet-only, no-host connection coexists with other connections', () => {
	it('runs alongside a WalletConnected payment connection given its own storagePrefix', async () => {
		// The documented multi-connection shape must remain available to backend-free apps too.
		wallet = installWallet({accounts: [ACCOUNT]});

		const player = createBackendFreeConnection({storagePrefix: 'player:'});
		const payment = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'payment:',
		});

		expect(currentState(player).wallets).toHaveLength(1);
		expect(currentState(payment).wallets).toHaveLength(1);

		const connecting = player.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signing = player.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(currentState(player).step).toBe('SignedIn');
		expect(localStorage.getItem('player:__origin_account')).not.toBeNull();
		expect(localStorage.getItem('payment:__origin_account')).toBeNull();
	});
});
