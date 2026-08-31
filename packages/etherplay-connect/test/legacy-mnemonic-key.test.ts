// Migration test for the removal of `signer.mnemonicKey` from the persisted origin account.
//
// The field used to hold `originKey`: not one derived key, but the ENTROPY the whole origin
// account is derived from (`fromEntropyKeyToMnemonic(originKey)`, index 0 of which is the session
// signer). `saveOriginAccount` writes the account to BOTH `localStorage` and `sessionStorage` at
// the app's origin, so anything that walks off with an origin's storage got the seed for every key
// that origin could ever derive rather than the single key the session actually uses.
//
// Not writing it any more does nothing for the users who already have one on disk, which is the
// half that carries the security, and it does nothing about the OTHER direction an account arrives
// from: the wallet host popup, which is deployed independently of the version an app ships and can
// still be running an older `deriveOriginAccount`. So there are three guards, and a test each:
//
//   - a construction-time cleanup that strips both storages in place, for every connection;
//   - `saveOriginAccount`, which strips whatever it is handed, so nothing carrying entropy is ever
//     persisted regardless of who produced the account;
//   - the popup result, stripped as it arrives, so the account handed to the APP is clean too,
//     whether or not it is remembered.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import type {
	WalletConnector,
	WalletHandle,
	WalletProvider,
	AlwaysOnProviderWrapper,
	AccountGenerator,
} from '@etherplay/wallet-connector';
import {createConnection, type ChainInfo} from '../src/index.js';

type MockUnderlyingProvider = {request: ReturnType<typeof vi.fn>};

const ACCOUNT = `0x05624ada${'0'.repeat(28)}37b8` as `0x${string}`;
const SIGNATURE = `0x${'ab'.repeat(32)}` as `0x${string}`;
const LEGACY_ENTROPY = `0x${'cd'.repeat(32)}` as `0x${string}`;

const WALLET_HOST = 'https://wallet.example.com';
const KEY_ACCOUNT = '__origin_account';
const KEY_LAST_WALLET = '__last_wallet';

function createMockWalletProvider(accounts: `0x${string}`[]): WalletProvider<MockUnderlyingProvider> {
	return {
		underlyingProvider: {request: vi.fn()},
		signMessage: vi.fn().mockResolvedValue(SIGNATURE),
		getChainId: vi.fn().mockResolvedValue('0x1' as `0x${string}`),
		requestAccounts: vi.fn().mockResolvedValue(accounts),
		getAccounts: vi.fn().mockResolvedValue(accounts),
		listenForAccountsChanged: vi.fn(),
		stopListenForAccountsChanged: vi.fn(),
		listenForChainChanged: vi.fn(),
		stopListenForChainChanged: vi.fn(),
		switchChain: vi.fn().mockResolvedValue(null),
		addChain: vi.fn().mockResolvedValue(null),
	};
}

function createMockWalletConnector(): WalletConnector<MockUnderlyingProvider> {
	const alwaysOnProvider: AlwaysOnProviderWrapper<MockUnderlyingProvider> = {
		chainId: '1',
		provider: {request: vi.fn()},
		setWalletProvider: vi.fn(),
		setWalletStatus: vi.fn(),
		onRequest: vi.fn(() => () => {}),
		getPendingRequests: vi.fn(() => []),
		signMessage: vi.fn(async () => '0x' as `0x${string}`),
	};
	const accountGenerator: AccountGenerator = {
		type: 'ethereum',
		fromMnemonicToAccount: vi.fn(() => ({
			address: '0xoriginaddress' as `0x${string}`,
			publicKey: '0xpublickey' as `0x${string}`,
			privateKey: '0xprivatekey' as `0x${string}`,
		})),
		signTextMessage: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
	};
	const handle: WalletHandle<MockUnderlyingProvider> = {
		info: {uuid: 'uuid-mock', name: 'MockWallet', icon: '', rdns: 'com.mock.wallet'},
		walletProvider: createMockWalletProvider([ACCOUNT]),
	};
	return {
		fetchWallets: vi.fn((callback) => callback(handle)),
		createAlwaysOnProvider: vi.fn(() => alwaysOnProvider),
		accountGenerator,
	};
}

const chainInfo: ChainInfo<MockUnderlyingProvider> = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
};

/** Exactly what an older version of the library left behind, entropy field included. */
function legacyStoredAccount() {
	return {
		address: ACCOUNT,
		signer: {
			origin: 'https://app.example.com',
			address: '0xoriginaddress' as `0x${string}`,
			publicKey: '0xpublickey' as `0x${string}`,
			privateKey: '0xprivatekey' as `0x${string}`,
			mnemonicKey: LEGACY_ENTROPY,
		},
		metadata: {},
		mechanismUsed: {type: 'wallet', name: 'MockWallet', address: ACCOUNT},
		savedPublicKeyPublicationSignature: undefined,
		savedDelegations: [],
		accountType: 'ethereum',
	};
}

function seedBothStorages(account: unknown) {
	const asString = JSON.stringify(account);
	localStorage.setItem(KEY_ACCOUNT, asString);
	sessionStorage.setItem(KEY_ACCOUNT, asString);
	// So auto-connect finds the wallet it is meant to restore through.
	const hint = JSON.stringify({type: 'wallet', name: 'MockWallet', address: ACCOUNT});
	localStorage.setItem(KEY_LAST_WALLET, hint);
	sessionStorage.setItem(KEY_LAST_WALLET, hint);
}

function createRestoringConnection() {
	return createConnection({
		walletHost: 'https://wallet.example.com',
		walletOnly: true,
		signingOrigin: 'https://app.example.com',
		chainInfo,
		walletConnector: createMockWalletConnector(),
		autoConnect: true,
		requestSignatureAutomaticallyIfPossible: true,
	});
}

function readJSON(storage: Storage, key: string): any {
	const raw = storage.getItem(key);
	return raw === null ? undefined : JSON.parse(raw);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('legacy mnemonicKey in stored accounts', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is stripped on load, from the restored session AND from both storages', async () => {
		seedBothStorages(legacyStoredAccount());
		// Precondition: the seed really is sitting there before anything runs.
		expect(readJSON(localStorage, KEY_ACCOUNT).signer.mnemonicKey).toBe(LEGACY_ENTROPY);
		expect(readJSON(sessionStorage, KEY_ACCOUNT).signer.mnemonicKey).toBe(LEGACY_ENTROPY);

		const connection = createRestoringConnection();
		await vi.advanceTimersByTimeAsync(1500);

		// A session restored from storage comes out with no seed anywhere: not in memory...
		let state: any;
		connection.subscribe((s) => {
			state = s;
		})();
		expect(state.step).toBe('SignedIn');
		expect(state.account.signer).not.toHaveProperty('mnemonicKey');

		// ...and not at rest, in EITHER storage. sessionStorage matters as much as localStorage:
		// cleaning one and leaving the other would leave the seed exfiltratable all the same.
		expect(readJSON(localStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
		expect(readJSON(sessionStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');

		// The rest of the stored account survives the rewrite: this is a field removal, not a
		// re-authentication. The session keeps signing with the same derived key it always had.
		expect(readJSON(localStorage, KEY_ACCOUNT)).toMatchObject({
			address: ACCOUNT,
			signer: {
				origin: 'https://app.example.com',
				address: '0xoriginaddress',
				publicKey: '0xpublickey',
				privateKey: '0xprivatekey',
			},
		});
		expect(state.account.signer.privateKey).toBe('0xprivatekey');
	});

	it('is stripped even when the app never auto-connects', async () => {
		// An `autoConnect: false` app never reads its stored account, so a cleanup that lived in
		// `getOriginAccount` would never run for it and the seed would sit there for as long as the app
		// is installed. The cleanup is at construction precisely so this case is covered.
		seedBothStorages(legacyStoredAccount());

		createConnection({
			walletHost: 'https://wallet.example.com',
			walletOnly: true,
			signingOrigin: 'https://app.example.com',
			chainInfo,
			walletConnector: createMockWalletConnector(),
			autoConnect: false,
		});

		expect(readJSON(localStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
		expect(readJSON(sessionStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
	});

	it('cleans a sessionStorage-only copy without resurrecting it into localStorage', async () => {
		// The two storages do not expire together: Safari's ITP evicts `localStorage` after seven days
		// of no interaction while an open tab keeps its `sessionStorage`. A cleanup driven by reading
		// `localStorage` and re-saving BOTH would either miss this copy or, worse, write the account
		// back into a `localStorage` it had already left. Each slot is cleaned where it lies.
		sessionStorage.setItem(KEY_ACCOUNT, JSON.stringify(legacyStoredAccount()));

		createConnection({
			walletHost: 'https://wallet.example.com',
			walletOnly: true,
			signingOrigin: 'https://app.example.com',
			chainInfo,
			walletConnector: createMockWalletConnector(),
			autoConnect: false,
		});

		expect(readJSON(sessionStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
		// Still signed out as far as localStorage is concerned: cleaning is not restoring.
		expect(localStorage.getItem(KEY_ACCOUNT)).toBeNull();
	});

	it('leaves an unrelated, unparseable value in the slot alone', async () => {
		// Whatever this is, it is not an account this library wrote, and a migration that throws or
		// overwrites on unexpected data is worse than one that walks past it.
		localStorage.setItem(KEY_ACCOUNT, 'not json at all');

		expect(() =>
			createConnection({
				walletHost: 'https://wallet.example.com',
				walletOnly: true,
				signingOrigin: 'https://app.example.com',
				chainInfo,
				walletConnector: createMockWalletConnector(),
				autoConnect: false,
			}),
		).not.toThrow();
		expect(localStorage.getItem(KEY_ACCOUNT)).toBe('not json at all');
	});

	it('leaves an already-clean stored account exactly as it is', async () => {
		const {signer, ...rest} = legacyStoredAccount();
		const {mnemonicKey, ...cleanSigner} = signer;
		const clean = {...rest, signer: cleanSigner};
		seedBothStorages(clean);
		const before = localStorage.getItem(KEY_ACCOUNT);

		const connection = createRestoringConnection();
		await vi.advanceTimersByTimeAsync(1500);

		let state: any;
		connection.subscribe((s) => {
			state = s;
		})();
		expect(state.step).toBe('SignedIn');
		expect(localStorage.getItem(KEY_ACCOUNT)).toBe(before);
		expect(state.account.signer).not.toHaveProperty('mnemonicKey');
	});
});

// The direction that removing the writes does NOT cover. The account handed back by the wallet host
// popup is built by `deriveOriginAccount` running in `web/login`, which is DEPLOYED SEPARATELY from
// the `@etherplay/connect` version an app ships. An app on a current build talking to a host that
// has not been redeployed receives an account still carrying the entropy key, and used to write it
// straight into both storages: a fresh seed at rest, put there by the version that removed it.
describe('a legacy account arriving from the wallet host popup', () => {
	let originalOpen: typeof window.open;
	let openedURLs: string[];

	beforeEach(() => {
		originalOpen = window.open;
		openedURLs = [];
		(window as any).open = vi.fn((url?: string | URL) => {
			openedURLs.push(String(url));
			return {closed: false, close: vi.fn()} as unknown as Window;
		});
	});

	afterEach(() => {
		(window as any).open = originalOpen;
	});

	/** Sign in through the popup, with the host answering exactly as an older deployment would. */
	async function signInThroughPopup(options?: {doNotStoreLocally?: boolean}) {
		const connection = createConnection({
			walletHost: WALLET_HOST,
			chainInfo,
			walletConnector: createMockWalletConnector(),
			autoConnect: false,
		});

		const signedIn = connection.connect({type: 'email', email: 'user@example.com', mode: 'otp'}, options);
		await vi.waitFor(() => expect(openedURLs.length).toBe(1));

		// The id the launcher put on the popup URL is the one it will accept an answer for.
		const id = new URL(openedURLs[0]).searchParams.get('id');
		window.dispatchEvent(
			new MessageEvent('message', {
				data: {id, result: legacyStoredAccount()},
				origin: WALLET_HOST,
			}),
		);
		await signedIn;

		let state: any;
		connection.subscribe((s) => {
			state = s;
		})();
		return state;
	}

	it('is stripped before it is handed to the app or written to storage', async () => {
		const state = await signInThroughPopup();

		expect(state.step).toBe('SignedIn');
		// The app never sees the seed...
		expect(state.account.signer).not.toHaveProperty('mnemonicKey');
		// ...and the version that removed the field does not go on to persist one.
		expect(readJSON(localStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
		expect(readJSON(sessionStorage, KEY_ACCOUNT).signer).not.toHaveProperty('mnemonicKey');
		// The session is otherwise exactly what the host sent.
		expect(state.account.signer.privateKey).toBe('0xprivatekey');
		expect(state.account.address).toBe(ACCOUNT);
	});

	it('is stripped from the in-memory account even when nothing is persisted', async () => {
		// `doNotStoreLocally` means `saveOriginAccount` is never called, so the write-side invariant
		// never runs. The account the app holds must still be clean.
		const state = await signInThroughPopup({doNotStoreLocally: true});

		expect(state.step).toBe('SignedIn');
		expect(state.account.signer).not.toHaveProperty('mnemonicKey');
		expect(localStorage.getItem(KEY_ACCOUNT)).toBeNull();
		expect(sessionStorage.getItem(KEY_ACCOUNT)).toBeNull();
	});
});
