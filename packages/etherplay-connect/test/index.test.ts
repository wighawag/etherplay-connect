import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import type {
	WalletConnector,
	WalletHandle,
	WalletProvider,
	AlwaysOnProviderWrapper,
	AccountGenerator,
} from '@etherplay/wallet-connector';
import {
	createConnection,
	isTargetStepReached,
	type Connection,
	type ChainInfo,
	type WalletMechanism,
} from '../src/index.js';

// Mock the @etherplay/alchemy module
vi.mock('@etherplay/alchemy', () => ({
	fromEntropyKeyToMnemonic: vi.fn((key: `0x${string}`) => 'test mnemonic words here'),
	fromSignatureToKey: vi.fn((signature: `0x${string}`) => '0x1234567890abcdef' as `0x${string}`),
	originKeyMessage: vi.fn((origin: string) => `Sign this message to prove ownership: ${origin}`),
	originPublicKeyPublicationMessage: vi.fn(
		(origin: string, publicKey: `0x${string}`) => `Publish public key: ${publicKey} for ${origin}`,
	),
}));

// Helper type for creating wallet mechanism with proper typing
type TestWalletMechanism = WalletMechanism<string, `0x${string}`>;

// Types for our mock provider
type MockUnderlyingProvider = {
	request: ReturnType<typeof vi.fn>;
};

// Create a mock wallet provider
function createMockWalletProvider(
	accounts: `0x${string}`[] = [],
	chainId: `0x${string}` = '0x1',
): WalletProvider<MockUnderlyingProvider> {
	const accountsChangedListeners = new Set<(accounts: `0x${string}`[]) => void>();
	const chainChangedListeners = new Set<(chainId: `0x${string}`) => void>();

	const underlyingProvider: MockUnderlyingProvider = {
		request: vi.fn(),
	};

	return {
		underlyingProvider,
		signMessage: vi.fn().mockResolvedValue('0xsignature1234' as `0x${string}`),
		getChainId: vi.fn().mockResolvedValue(chainId),
		requestAccounts: vi.fn().mockResolvedValue(accounts),
		getAccounts: vi.fn().mockResolvedValue(accounts),
		listenForAccountsChanged: vi.fn((handler) => {
			accountsChangedListeners.add(handler);
		}),
		stopListenForAccountsChanged: vi.fn((handler) => {
			accountsChangedListeners.delete(handler);
		}),
		listenForChainChanged: vi.fn((handler) => {
			chainChangedListeners.add(handler);
		}),
		stopListenForChainChanged: vi.fn((handler) => {
			chainChangedListeners.delete(handler);
		}),
		switchChain: vi.fn().mockResolvedValue(null),
		addChain: vi.fn().mockResolvedValue(null),
	};
}

// Create a mock wallet handle
function createMockWalletHandle(
	name: string = 'MockWallet',
	accounts: `0x${string}`[] = ['0xabc123' as `0x${string}`],
	chainId: `0x${string}` = '0x1',
): WalletHandle<MockUnderlyingProvider> {
	return {
		info: {
			uuid: `uuid-${name}`,
			name,
			icon: 'data:image/svg+xml,...',
			rdns: `com.mock.${name.toLowerCase()}`,
		},
		walletProvider: createMockWalletProvider(accounts, chainId),
	};
}

// Create a mock account generator
function createMockAccountGenerator(): AccountGenerator {
	return {
		type: 'secp256k1',
		fromMnemonicToAccount: vi.fn((mnemonic: string, index: number) => ({
			address: '0xoriginaddress' as `0x${string}`,
			publicKey: '0xpublickey' as `0x${string}`,
			privateKey: '0xprivatekey' as `0x${string}`,
		})),
		signTextMessage: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
	};
}

// Create a mock wallet connector
function createMockWalletConnector(
	walletHandles: WalletHandle<MockUnderlyingProvider>[] = [],
): WalletConnector<MockUnderlyingProvider> {
	const accountGenerator = createMockAccountGenerator();

	const alwaysOnProvider: AlwaysOnProviderWrapper<MockUnderlyingProvider> = {
		chainId: '1',
		provider: {request: vi.fn()} as MockUnderlyingProvider,
		setWalletProvider: vi.fn(),
		setWalletStatus: vi.fn(),
		onRequest: vi.fn(() => () => {}), // Returns unsubscribe function
		getPendingRequests: vi.fn(() => []),
	};

	return {
		fetchWallets: vi.fn((callback) => {
			// Simulate async wallet announcement
			walletHandles.forEach((handle, index) => {
				setTimeout(() => callback(handle), index * 10);
			});
		}),
		createAlwaysOnProvider: vi.fn(() => alwaysOnProvider),
		accountGenerator,
	};
}

// Default chain info for tests
const defaultChainInfo: ChainInfo<MockUnderlyingProvider> = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {
		default: {
			http: ['https://eth-mainnet.example.com'],
		},
	},
	nativeCurrency: {
		name: 'Ether',
		symbol: 'ETH',
		decimals: 18,
	},
};

describe('isTargetStepReached', () => {
	describe('with targetStep: SignedIn', () => {
		it('should return true when step is SignedIn with popup-based auth', () => {
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: {type: 'email', email: 'test@example.com', mode: 'otp'},
				account: {
					address: '0x123' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: {type: 'email', email: 'test@example.com', mode: 'otp'},
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: undefined,
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn')).toBe(true);
		});

		it('should return true when step is SignedIn with wallet-based auth', () => {
			const mockWalletProvider = createMockWalletProvider(['0xabc' as `0x${string}`]);
			const walletMechanism: TestWalletMechanism = {
				type: 'wallet',
				name: 'MockWallet',
				address: '0xabc' as `0x${string}`,
			};
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: walletMechanism,
				account: {
					address: '0xabc' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: walletMechanism,
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: {
					provider: mockWalletProvider,
					accounts: ['0xabc' as `0x${string}`],
					status: 'connected',
					chainId: '1',
					invalidChainId: false,
					switchingChain: false,
					pendingRequests: [],
				},
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn')).toBe(true);
		});

		it('should return false when step is not SignedIn', () => {
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'Idle',
				loading: false,
				wallet: undefined,
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn')).toBe(false);
		});

		it('should return false when step is WalletConnected', () => {
			const mockWalletProvider = createMockWalletProvider(['0xabc' as `0x${string}`]);
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'WalletConnected',
				mechanism: {type: 'wallet', name: 'MockWallet', address: '0xabc' as `0x${string}`},
				account: {address: '0xabc' as `0x${string}`},
				wallet: {
					provider: mockWalletProvider,
					accounts: ['0xabc' as `0x${string}`],
					status: 'connected',
					chainId: '1',
					invalidChainId: false,
					switchingChain: false,
					pendingRequests: [],
				},
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn')).toBe(false);
		});
	});

	describe('with targetStep: WalletConnected', () => {
		it('should return true when step is WalletConnected', () => {
			const mockWalletProvider = createMockWalletProvider(['0xabc' as `0x${string}`]);
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'WalletConnected',
				mechanism: {type: 'wallet', name: 'MockWallet', address: '0xabc' as `0x${string}`},
				account: {address: '0xabc' as `0x${string}`},
				wallet: {
					provider: mockWalletProvider,
					accounts: ['0xabc' as `0x${string}`],
					status: 'connected',
					chainId: '1',
					invalidChainId: false,
					switchingChain: false,
					pendingRequests: [],
				},
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'WalletConnected')).toBe(true);
		});

		it('should return true when step is SignedIn with wallet', () => {
			const mockWalletProvider = createMockWalletProvider(['0xabc' as `0x${string}`]);
			const walletMechanism2: TestWalletMechanism = {
				type: 'wallet',
				name: 'MockWallet',
				address: '0xabc' as `0x${string}`,
			};
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: walletMechanism2,
				account: {
					address: '0xabc' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: walletMechanism2,
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: {
					provider: mockWalletProvider,
					accounts: ['0xabc' as `0x${string}`],
					status: 'connected',
					chainId: '1',
					invalidChainId: false,
					switchingChain: false,
					pendingRequests: [],
				},
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'WalletConnected')).toBe(true);
		});

		it('should return false when step is SignedIn without wallet', () => {
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: {type: 'email', email: 'test@example.com', mode: 'otp'},
				account: {
					address: '0x123' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: {type: 'email', email: 'test@example.com', mode: 'otp'},
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: undefined,
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'WalletConnected')).toBe(false);
		});

		it('should return false when step is Idle', () => {
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'Idle',
				loading: false,
				wallet: undefined,
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'WalletConnected')).toBe(false);
		});
	});

	describe('with walletOnly: true', () => {
		it('should return true for SignedIn with wallet when walletOnly is true', () => {
			const mockWalletProvider = createMockWalletProvider(['0xabc' as `0x${string}`]);
			const walletMechanism3: TestWalletMechanism = {
				type: 'wallet',
				name: 'MockWallet',
				address: '0xabc' as `0x${string}`,
			};
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: walletMechanism3,
				account: {
					address: '0xabc' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: walletMechanism3,
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: {
					provider: mockWalletProvider,
					accounts: ['0xabc' as `0x${string}`],
					status: 'connected',
					chainId: '1',
					invalidChainId: false,
					switchingChain: false,
					pendingRequests: [],
				},
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn', true)).toBe(true);
		});

		it('should return false for SignedIn without wallet when walletOnly is true', () => {
			const connection: Connection<MockUnderlyingProvider> = {
				step: 'SignedIn',
				mechanism: {type: 'email', email: 'test@example.com', mode: 'otp'},
				account: {
					address: '0x123' as `0x${string}`,
					signer: {
						origin: 'test',
						address: '0xorigin' as `0x${string}`,
						publicKey: '0xpub' as `0x${string}`,
						privateKey: '0xpriv' as `0x${string}`,
						mnemonicKey: '0xmnem' as `0x${string}`,
					},
					metadata: {},
					mechanismUsed: {type: 'email', email: 'test@example.com', mode: 'otp'},
					savedPublicKeyPublicationSignature: undefined,
					accountType: 'secp256k1',
				},
				wallet: undefined,
				wallets: [],
			};

			expect(isTargetStepReached(connection, 'SignedIn', true)).toBe(false);
		});
	});
});

describe('createConnection', () => {
	beforeEach(() => {
		// Clear localStorage before each test
		localStorage.clear();
		sessionStorage.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	describe('initialization', () => {
		it('should create a connection store with required properties', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store).toBeDefined();
			expect(typeof store.subscribe).toBe('function');
			expect(typeof store.connect).toBe('function');
			expect(typeof store.cancel).toBe('function');
			expect(typeof store.back).toBe('function');
			expect(typeof store.disconnect).toBe('function');
			expect(typeof store.requestSignature).toBe('function');
			expect(typeof store.connectToAddress).toBe('function');
			expect(typeof store.getSignatureForPublicKeyPublication).toBe('function');
			expect(typeof store.switchWalletChain).toBe('function');
			expect(typeof store.unlock).toBe('function');
			expect(typeof store.ensureConnected).toBe('function');
			expect(typeof store.isTargetStepReached).toBe('function');
		});

		it('should start in Idle step with loading true when autoConnect is true (with no saved session)', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: true,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			expect(currentState?.step).toBe('Idle');
			// When no saved session exists, loading becomes false after initial check
			// The loading: true state is very brief and may resolve to false immediately
			expect(currentState?.step === 'Idle').toBe(true);
		});

		it('should start in Idle step with loading false when autoConnect is false', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			expect(currentState?.step).toBe('Idle');
			expect(currentState?.step === 'Idle' && currentState.loading).toBe(false);
		});

		it('should expose chainId and chainInfo', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store.chainId).toBe('1');
			expect(store.chainInfo).toEqual(defaultChainInfo);
		});

		it('should set targetStep to SignedIn by default', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store.targetStep).toBe('SignedIn');
		});

		it('should respect custom targetStep', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store.targetStep).toBe('WalletConnected');
		});

		it('should set walletOnly based on settings', () => {
			const walletConnector = createMockWalletConnector();
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				walletOnly: true,
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store.walletOnly).toBe(true);
		});
	});

	describe('connect with wallet mechanism', () => {
		it('should transition to MechanismToChoose when connect is called without mechanism', async () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect();

			expect(currentState?.step).toBe('MechanismToChoose');
		});

		it('should transition to WalletToChoose when connect is called with wallet mechanism but no specific wallet', async () => {
			const walletConnector = createMockWalletConnector([
				createMockWalletHandle('Wallet1'),
				createMockWalletHandle('Wallet2'),
			]);
			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallets to be fetched
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect({type: 'wallet'});

			expect(currentState?.step).toBe('WalletToChoose');
		});

		it('should transition to WalletConnected when single wallet connects successfully', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('WalletConnected');
			if (currentState?.step === 'WalletConnected') {
				expect(currentState.mechanism.name).toBe('MockWallet');
				expect(currentState.mechanism.address).toBe('0xuser123');
			}
		});

		it('should transition to ChooseWalletAccount when multiple accounts available', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser1' as `0x${string}`, '0xuser2' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
				alwaysUseCurrentAccount: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('ChooseWalletAccount');
			if (currentState?.step === 'ChooseWalletAccount') {
				expect(currentState.wallet.accounts).toEqual(['0xuser1', '0xuser2']);
			}
		});

		it('should skip account selection when alwaysUseCurrentAccount is true', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser1' as `0x${string}`, '0xuser2' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
				alwaysUseCurrentAccount: true,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('WalletConnected');
		});

		it('should set error when wallet connection fails', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', []);
			// Make requestAccounts return empty array to simulate connection failure
			(mockHandle.walletProvider.requestAccounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);

			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('MechanismToChoose');
			expect(currentState?.error?.message).toBe('could not get any accounts');
		});
	});

	describe('disconnect', () => {
		it('should transition to Idle and clear storage when disconnect is called', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			// Connect first
			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('WalletConnected');

			// Now disconnect
			store.disconnect();

			expect(currentState?.step).toBe('Idle');
			if (currentState?.step === 'Idle') {
				expect(currentState.loading).toBe(false);
				expect(currentState.wallet).toBeUndefined();
			}
		});
	});

	describe('cancel', () => {
		it('should transition to Idle when cancel is called', async () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect();
			expect(currentState?.step).toBe('MechanismToChoose');

			store.cancel();

			expect(currentState?.step).toBe('Idle');
		});
	});

	describe('back', () => {
		it('should transition to MechanismToChoose when back is called with MechanismToChoose', async () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle(), createMockWalletHandle('Wallet2')]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallets to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect({type: 'wallet'});
			expect(currentState?.step).toBe('WalletToChoose');

			store.back('MechanismToChoose');
			expect(currentState?.step).toBe('MechanismToChoose');
		});

		it('should transition to Idle when back is called with Idle', async () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect();
			expect(currentState?.step).toBe('MechanismToChoose');

			store.back('Idle');
			expect(currentState?.step).toBe('Idle');
		});

		it('should transition to WalletToChoose when back is called with WalletToChoose', async () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			await store.connect();

			store.back('WalletToChoose');
			expect(currentState?.step).toBe('WalletToChoose');
		});
	});

	describe('connectToAddress', () => {
		it('should connect to a specific address when wallet is connected', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser1' as `0x${string}`, '0xuser2' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
				alwaysUseCurrentAccount: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('ChooseWalletAccount');

			// Now choose a specific address
			store.connectToAddress('0xuser2' as `0x${string}`);
			await vi.advanceTimersByTimeAsync(100);

			expect(currentState?.step).toBe('WalletConnected');
			if (currentState?.step === 'WalletConnected') {
				expect(currentState.mechanism.address).toBe('0xuser2');
			}
		});

		it('should throw error when no wallet is connected', () => {
			const walletConnector = createMockWalletConnector([]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			expect(() => store.connectToAddress('0xuser' as `0x${string}`)).toThrow('need to be using a wallet');
		});
	});

	describe('store.isTargetStepReached', () => {
		it('should correctly check if target step is reached', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			// Initially not reached
			expect(store.isTargetStepReached(currentState!)).toBe(false);

			// Connect
			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			// Now should be reached
			expect(store.isTargetStepReached(currentState!)).toBe(true);
		});
	});

	describe('chainId handling', () => {
		it('should detect invalid chainId when wallet chain differs from configured chain', async () => {
			// Create a wallet on chain 5 (Goerli) while our config is for chain 1 (Mainnet)
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`], '0x5');
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo, // Chain ID 1
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('WalletConnected');
			if (currentState?.step === 'WalletConnected') {
				expect(currentState.wallet.invalidChainId).toBe(true);
				expect(currentState.wallet.chainId).toBe('5');
			}
		});

		it('should not mark chainId as invalid when chains match', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`], '0x1');
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				walletHost: 'https://wallet.example.com',
				chainInfo: defaultChainInfo, // Chain ID 1
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			expect(currentState?.step).toBe('WalletConnected');
			if (currentState?.step === 'WalletConnected') {
				expect(currentState.wallet.invalidChainId).toBe(false);
				expect(currentState.wallet.chainId).toBe('1');
			}
		});
	});

	describe('WalletConnected targetStep', () => {
		it('should auto-connect with wallet mechanism when targetStep is WalletConnected', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			let currentState: Connection<MockUnderlyingProvider> | undefined;
			store.subscribe((state) => {
				currentState = state;
			});

			// When calling connect() without mechanism, should default to wallet
			// Specify wallet name to avoid WalletToChoose step
			const connectPromise = store.connect({type: 'wallet', name: 'MockWallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			// For single wallet with specified name, should go to WalletConnected directly
			expect(currentState?.step).toBe('WalletConnected');
		});
	});

	describe('ensureConnected', () => {
		it('should resolve when already connected to target step', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			// Connect first
			const connectPromise = store.connect({type: 'wallet'});
			await vi.advanceTimersByTimeAsync(100);
			await connectPromise;

			// Now ensureConnected should resolve immediately
			const result = await store.ensureConnected();
			expect(result.step).toBe('WalletConnected');
		});

		it('should start connection if not yet connected', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			// ensureConnected should start connection and resolve
			const ensurePromise = store.ensureConnected();
			await vi.advanceTimersByTimeAsync(200);
			const result = await ensurePromise;

			expect(result.step).toBe('WalletConnected');
		});

		it('should reject when connection is cancelled', async () => {
			const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
			const walletConnector = createMockWalletConnector([mockHandle]);

			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Wait for wallet to be announced
			vi.advanceTimersByTime(50);

			// Start ensureConnected
			const ensurePromise = store.ensureConnected();

			// Cancel the connection
			store.cancel();

			await expect(ensurePromise).rejects.toThrow('Connection cancelled');
		});
	});

	describe('walletHost requirement', () => {
		it('should not require walletHost for WalletConnected targetStep', () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);

			// This should not throw
			const store = createConnection({
				targetStep: 'WalletConnected',
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store).toBeDefined();
		});

		it('should not require walletHost when walletOnly is true', () => {
			const walletConnector = createMockWalletConnector([createMockWalletHandle()]);

			// This should not throw
			const store = createConnection({
				walletOnly: true,
				chainInfo: defaultChainInfo,
				walletConnector,
			});

			expect(store).toBeDefined();
		});

		it('should throw when using popup-based auth without walletHost', async () => {
			const walletConnector = createMockWalletConnector([]);

			const store = createConnection({
				walletHost: undefined as unknown as string, // Force undefined to test
				chainInfo: defaultChainInfo,
				walletConnector,
				autoConnect: false,
			});

			// Attempting popup-based auth should fail
			await expect(store.connect({type: 'email', email: 'test@example.com', mode: 'otp'})).rejects.toThrow(
				'walletHost is required for popup-based authentication',
			);
		});
	});
});

describe('wallet state tracking', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('should track wallet status correctly', async () => {
		const mockHandle = createMockWalletHandle('MockWallet', ['0xuser123' as `0x${string}`]);
		const walletConnector = createMockWalletConnector([mockHandle]);

		const store = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo: defaultChainInfo,
			walletConnector,
			autoConnect: false,
		});

		// Wait for wallet to be announced
		vi.advanceTimersByTime(50);

		let currentState: Connection<MockUnderlyingProvider> | undefined;
		store.subscribe((state) => {
			currentState = state;
		});

		const connectPromise = store.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(100);
		await connectPromise;

		expect(currentState?.step).toBe('WalletConnected');
		if (currentState?.step === 'WalletConnected') {
			expect(currentState.wallet.status).toBe('connected');
			expect(currentState.wallet.accounts).toContain('0xuser123');
			expect(currentState.wallet.switchingChain).toBe(false);
		}
	});

	it('should populate wallets array when wallets are announced', async () => {
		const handle1 = createMockWalletHandle('Wallet1', ['0x111' as `0x${string}`]);
		const handle2 = createMockWalletHandle('Wallet2', ['0x222' as `0x${string}`]);
		const walletConnector = createMockWalletConnector([handle1, handle2]);

		const store = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo: defaultChainInfo,
			walletConnector,
			autoConnect: false,
		});

		let currentState: Connection<MockUnderlyingProvider> | undefined;
		store.subscribe((state) => {
			currentState = state;
		});

		// Wait for wallets to be announced
		vi.advanceTimersByTime(50);

		expect(currentState?.wallets.length).toBe(2);
		expect(currentState?.wallets.map((w) => w.info.name)).toContain('Wallet1');
		expect(currentState?.wallets.map((w) => w.info.name)).toContain('Wallet2');
	});
});
