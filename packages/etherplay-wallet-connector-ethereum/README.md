# @etherplay/wallet-connector-ethereum

Ethereum wallet connector implementation for the `@etherplay/connect` ecosystem. This package provides EIP-6963 provider detection, account management, and chain switching support for Ethereum-compatible wallets.

## Installation

```bash
npm install @etherplay/wallet-connector-ethereum
# or
pnpm add @etherplay/wallet-connector-ethereum
# or
yarn add @etherplay/wallet-connector-ethereum
```

## Features

- **EIP-6963 Support**: Automatic detection of multiple wallet providers via the EIP-6963 standard
- **Account Generation**: Generate Ethereum accounts from BIP-39 mnemonics using standard derivation paths (m/44'/60'/0'/0/x)
- **Message Signing**: Support for EIP-191 personal_sign messages
- **Chain Management**: Switch and add Ethereum chains
- **Always-On Provider**: Fallback RPC provider for read operations

## Usage

### Basic Setup

```typescript
import {EthereumWalletConnector} from '@etherplay/wallet-connector-ethereum';

const connector = new EthereumWalletConnector();

// Fetch available wallets (EIP-6963)
connector.fetchWallets((walletHandle) => {
	console.log('Wallet found:', walletHandle.info.name);
	// walletHandle.walletProvider is ready to use
});
```

### Account Generation

Generate Ethereum accounts from a BIP-39 mnemonic phrase:

```typescript
const connector = new EthereumWalletConnector();

// Generate account at index 0
const account = connector.accountGenerator.fromMnemonicToAccount(
	'your twelve word mnemonic phrase goes here and more words',
	0,
);

console.log(account.address); // 0x...
console.log(account.publicKey); // 0x...
console.log(account.privateKey); // 0x...
```

### Message Signing

Sign messages using EIP-191 personal_sign:

```typescript
const connector = new EthereumWalletConnector();

const signature = await connector.accountGenerator.signTextMessage('Hello, Ethereum!', account.privateKey);
```

### Always-On Provider

Create a provider that falls back to an RPC endpoint when no wallet is connected:

```typescript
const connector = new EthereumWalletConnector();

const provider = connector.createAlwaysOnProvider({
	endpoint: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY',
	chainId: '1',
	prioritizeWalletProvider: true, // Use wallet if available
	requestsPerSecond: 10,
});

// The provider can now be used for read operations
// even when no wallet is connected
```

### Wallet Provider Operations

```typescript
connector.fetchWallets(async (walletHandle) => {
	const {walletProvider} = walletHandle;

	// Request account access
	const accounts = await walletProvider.requestAccounts();

	// Get current chain
	const chainId = await walletProvider.getChainId();

	// Sign a message
	const signature = await walletProvider.signMessage('Sign this message', accounts[0]);

	// Switch to a different chain
	await walletProvider.switchChain('0x89'); // Polygon

	// Add a new chain
	await walletProvider.addChain({
		chainId: '0x89',
		chainName: 'Polygon Mainnet',
		rpcUrls: ['https://polygon-rpc.com'],
		nativeCurrency: {
			name: 'MATIC',
			symbol: 'MATIC',
			decimals: 18,
		},
		blockExplorerUrls: ['https://polygonscan.com'],
	});

	// Listen for account changes
	walletProvider.listenForAccountsChanged((accounts) => {
		console.log('Accounts changed:', accounts);
	});

	// Listen for chain changes
	walletProvider.listenForChainChanged((chainId) => {
		console.log('Chain changed:', chainId);
	});
});
```

## API Reference

### EthereumWalletConnector

Main connector class implementing `WalletConnector<CurriedRPC<Methods>>`:

```typescript
class EthereumWalletConnector {
	accountGenerator: AccountGenerator;
	fetchWallets(walletAnnounced: (walletHandle: WalletHandle<CurriedRPC<Methods>>) => void): void;
	createAlwaysOnProvider(params: {
		endpoint: string | UnderlyingEthereumProvider;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<CurriedRPC<Methods>>;
}
```

### EthereumAccountGenerator

Account generator for Ethereum using BIP-32/BIP-39 standards:

```typescript
class EthereumAccountGenerator implements AccountGenerator {
	type: 'ethereum';
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount;
	signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`>;
}
```

### EthereumWalletProvider

Wrapper for EIP-1193 wallet providers:

```typescript
class EthereumWalletProvider implements WalletProvider<CurriedRPC<Methods>> {
	underlyingProvider: CurriedRPC<Methods>;
	signMessage(message: string, account: `0x${string}`): Promise<`0x${string}`>;
	getChainId(): Promise<`0x${string}`>;
	getAccounts(): Promise<`0x${string}`[]>;
	requestAccounts(): Promise<`0x${string}`[]>;
	listenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void): void;
	stopListenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void): void;
	listenForChainChanged(handler: (chainId: `0x${string}`) => void): void;
	stopListenForChainChanged(handler: (chainId: `0x${string}`) => void): void;
	switchChain(chainId: string): Promise<null | any>;
	addChain(chainInfo: ChainInfo): Promise<null | any>;
}
```

## Utility Functions

```typescript
// Add 0x prefix to hex string
add0x(hex: string): string;

// Remove 0x prefix from hex string
strip0x(hex: string): string;

// Get checksummed address
addChecksum(nonChecksummedAddress: string): string;

// Derive address from public key
fromPublicKey(key: string | Uint8Array): string;

// Derive address from private key
fromPrivateKey(key: string | Uint8Array): string;

// Hash a text message for signing (EIP-191)
hashTextMessage(str: string): string;

// Derive HD key from mnemonic
fromMnemonicToHDKey(mnemonic: string, index: number): HDKey;
```

## Dependencies

- `@etherplay/wallet-connector` - Core interfaces
- `@noble/curves` - Cryptographic curve operations
- `@noble/hashes` - Hash functions
- `@scure/bip32` - HD wallet derivation
- `@scure/bip39` - Mnemonic phrase handling
- `remote-procedure-call` - RPC utilities

## Related Packages

- [`@etherplay/wallet-connector`](../etherplay-wallet-connector) - Core wallet connector interfaces
- [`@etherplay/connect`](../etherplay-connect) - Main connection library
- [`@etherplay/alchemy`](../etherplay-alchemy) - Social login mechanisms

## License

MIT
