# @etherplay/wallet-connector

Core wallet connector interfaces and types for the `@etherplay/connect` ecosystem. This package provides the foundational abstractions for wallet provider implementations across different blockchain networks.

## Installation

```bash
npm install @etherplay/wallet-connector
# or
pnpm add @etherplay/wallet-connector
# or
yarn add @etherplay/wallet-connector
```

## Overview

This package defines the core interfaces and types used by wallet connector implementations. It serves as the foundation for building wallet integrations that work consistently across different blockchain networks.

## Core Types

### WalletHandle

Represents a wallet with its provider and metadata:

```typescript
type WalletHandle<UnderlyingProvider> = {
	walletProvider: WalletProvider<UnderlyingProvider>;
	info: WalletInfo;
};
```

### WalletInfo

Metadata about a wallet:

```typescript
type WalletInfo = {
	uuid: string;
	name: string;
	icon: string;
	rdns: string;
};
```

### ChainInfo

Information about a blockchain network:

```typescript
type ChainInfo = Readonly<{
	chainId: `0x${string}`;
	rpcUrls?: readonly string[];
	blockExplorerUrls?: readonly string[];
	chainName?: string;
	iconUrls?: readonly string[];
	nativeCurrency?: Readonly<{
		name: string;
		symbol: string;
		decimals: number;
	}>;
}>;
```

## Interfaces

### AccountGenerator

Interface for generating accounts from mnemonics:

```typescript
interface AccountGenerator {
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount;
	signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`>;
	type: string;
}
```

### WalletConnector

Main interface for wallet connector implementations:

```typescript
interface WalletConnector<UnderlyingProvider> {
	fetchWallets(walletAnnounced: (walletHandle: WalletHandle<UnderlyingProvider>) => void): void;
	createAlwaysOnProvider(params: {
		endpoint: string | UnderlyingProvider;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<UnderlyingProvider>;
	accountGenerator: AccountGenerator;
}
```

### WalletProvider

Interface for wallet provider interactions:

```typescript
interface WalletProvider<UnderlyingProvider> extends BasicWalletProvider<UnderlyingProvider> {
	listenForAccountsChanged: (handler: (accounts: `0x${string}`[]) => void) => void;
	stopListenForAccountsChanged: (handler: (accounts: `0x${string}`[]) => void) => void;
	listenForChainChanged: (handler: (chainId: `0x${string}`) => void) => void;
	stopListenForChainChanged: (handler: (chainId: `0x${string}`) => void) => void;
	switchChain: (chainId: `0x${string}`) => Promise<null | any>;
	addChain(chainInfo: ChainInfo): Promise<null | any>;
}
```

### AlwaysOnProviderWrapper

Wrapper for providers that should always be available, and the single place every wallet-reaching
request is announced from:

```typescript
interface AlwaysOnProviderWrapper<WalletProviderType> {
	setWalletProvider: (walletProvider: WalletProviderType | undefined) => void;
	setWalletStatus: (newStatus: 'connected' | 'locked' | 'disconnected') => void;
	chainId: string;
	provider: WalletProviderType;

	// Ask the wallet to sign text, ANNOUNCED. A separate surface from `provider.request` because
	// that path speaks for one chain and refuses signing methods when the wallet is elsewhere,
	// while a text signature is chain-independent.
	signMessage: (
		message: string,
		account: `0x${string}`,
		options?: {purpose?: RequestPurpose},
	) => Promise<`0x${string}`>;

	// Request tracking. `onRequest` returns an unsubscribe function.
	onRequest: (handler: RequestEventHandler) => () => void;
	getPendingRequests: () => PendingRequest[];
}
```

A request the user must answer and the app cannot see is a request nothing can explain, cancel or
recover from, and the failure is silent: the request still works and returns the right bytes, while
the only symptom is an unexplained wallet popup. So an implementation must announce everything that
reaches the user's wallet, and `signMessage` exists so that a signature the library itself needs is
reported like any other request. See
[ADR-0001](../../docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md).

`PendingRequest.purpose` says WHY, for requests this library originates (`'delegation' |
'public-key-publication'`). It is absent when the app asked directly through `provider`, where the
app already knows what it sent. `PendingRequest.account` says WHO must answer it: the signer of a
signature, the `from` of a transaction. A request can outlive the wallet state it started under,
because the user may switch wallet or account while one is outstanding, so a consumer needs it to
avoid pointing them at a wallet that cannot answer.

`getPendingRequests()` is authoritative. A consumer that rebuilds wallet state while a request is
outstanding must copy the current list from it rather than assume an empty one: assuming empty
erases the request permanently, because the next event for it is the one that ends it.

## Usage

This package is primarily used as a dependency for implementing blockchain-specific wallet connectors:

```typescript
import type {WalletConnector, WalletProvider, AccountGenerator, ChainInfo} from '@etherplay/wallet-connector';

// Implement a custom wallet connector
class MyWalletConnector implements WalletConnector<MyProvider> {
	// ... implementation
}
```

## Related Packages

- [`@etherplay/wallet-connector-ethereum`](../etherplay-wallet-connector-ethereum) - Ethereum implementation of the wallet connector
- [`@etherplay/connect`](../etherplay-connect) - Main connection library that uses wallet connectors
- [`@etherplay/alchemy`](../etherplay-alchemy) - Social login mechanisms for account generation

## License

MIT
