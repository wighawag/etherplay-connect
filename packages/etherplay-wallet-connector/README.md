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

Wrapper for providers that should always be available:

```typescript
interface AlwaysOnProviderWrapper<WalletProviderType> {
  setWalletProvider: (walletProvider: WalletProviderType | undefined) => void;
  setWalletStatus: (newStatus: 'connected' | 'locked' | 'disconnected') => void;
  chainId: string;
  provider: WalletProviderType;
}
```

## Usage

This package is primarily used as a dependency for implementing blockchain-specific wallet connectors:

```typescript
import type {
  WalletConnector,
  WalletProvider,
  AccountGenerator,
  ChainInfo,
} from '@etherplay/wallet-connector';

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
