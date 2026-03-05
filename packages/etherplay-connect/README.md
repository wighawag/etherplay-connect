# @etherplay/connect

Main connection library for Etherplay Accounts - provides seamless wallet and social authentication with session account management. This package combines Web3 wallet support with social login capabilities to create a unified authentication experience.

## Installation

```bash
npm install @etherplay/connect
# or
pnpm add @etherplay/connect
# or
yarn add @etherplay/connect
```

## Features

- **Web3 Wallet Support**: Connect via MetaMask, Coinbase Wallet, and other EIP-6963 compliant wallets
- **Social Login**: Authenticate via email OTP, Google, Facebook, or Auth0 through a popup flow
- **Mnemonic Login**: Direct authentication using BIP-39 mnemonic phrases
- **Session Accounts**: Generate origin-specific session accounts for enhanced security
- **Auto-Connect**: Automatically reconnect returning users
- **Chain Management**: Built-in chain switching and validation
- **Svelte Integration**: Reactive state management via Svelte stores
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

## Quick Start

### Basic Wallet Connection

```typescript
import {createConnection} from '@etherplay/connect';

// Create a connection targeting wallet connection only
const connection = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: {
		id: 1,
		name: 'Ethereum',
		rpcUrls: {default: {http: ['https://eth.llamarpc.com']}},
		nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
	},
});

// Subscribe to connection state changes
connection.subscribe((state) => {
	if (state.step === 'WalletConnected') {
		console.log('Connected:', state.account.address);
	}
});

// Initiate wallet connection
await connection.connect({type: 'wallet'});
```

### Full SignedIn Flow with Social Login

```typescript
import {createConnection} from '@etherplay/connect';

const connection = createConnection({
	walletHost: 'https://wallet.etherplay.io', // Required for popup-based auth
	chainInfo: {
		id: 1,
		name: 'Ethereum',
		rpcUrls: {default: {http: ['https://eth.llamarpc.com']}},
		nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
	},
	autoConnect: true, // Auto-reconnect returning users
});

// Connect via email
await connection.connect({type: 'email', mode: 'otp', email: 'user@example.com'});

// Or via OAuth
await connection.connect({type: 'oauth', provider: {id: 'google'}, usePopup: true});
```

### Using ensureConnected

The `ensureConnected` method provides a promise-based API that resolves when the target connection state is reached:

```typescript
// Wait for wallet connection
const state = await connection.ensureConnected('WalletConnected');
console.log('Wallet connected:', state.account.address);

// Wait for full sign-in
const signedInState = await connection.ensureConnected('SignedIn');
console.log('Session account:', signedInState.account.signer.address);
```

## Configuration

### createConnection Options

| Option                                    | Type                              | Required    | Description                                          |
| ----------------------------------------- | --------------------------------- | ----------- | ---------------------------------------------------- |
| `chainInfo`                               | `ChainInfo`                       | Yes         | Chain configuration including id, name, rpcUrls      |
| `targetStep`                              | `'WalletConnected' \| 'SignedIn'` | No          | Target connection step (default: `'SignedIn'`)       |
| `walletOnly`                              | `boolean`                         | No          | Restrict to wallet-only authentication               |
| `walletHost`                              | `string`                          | Conditional | URL for popup-based auth (required for social login) |
| `signingOrigin`                           | `string`                          | No          | Origin used for signing (defaults to current origin) |
| `autoConnect`                             | `boolean`                         | No          | Auto-reconnect returning users (default: `true`)     |
| `walletConnector`                         | `WalletConnector`                 | No          | Custom wallet connector (defaults to Ethereum)       |
| `requestSignatureAutomaticallyIfPossible` | `boolean`                         | No          | Auto-request signature after wallet connection       |
| `alwaysUseCurrentAccount`                 | `boolean`                         | No          | Always use current wallet account                    |
| `prioritizeWalletProvider`                | `boolean`                         | No          | Prioritize wallet for RPC calls                      |
| `requestsPerSecond`                       | `number`                          | No          | Rate limit for RPC requests                          |

## Connection States

The connection follows a state machine with these primary steps:

| Step                         | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `Idle`                       | Initial state, not connected                         |
| `MechanismToChoose`          | Waiting for auth mechanism selection                 |
| `WalletToChoose`             | Multiple wallets available, waiting for selection    |
| `WaitingForWalletConnection` | Connecting to selected wallet                        |
| `ChooseWalletAccount`        | Multiple accounts available, waiting for selection   |
| `WalletConnected`            | Wallet connected (target for `WalletConnected` mode) |
| `WaitingForSignature`        | Waiting for user to sign message                     |
| `PopupLaunched`              | Popup opened for social login                        |
| `SignedIn`                   | Fully authenticated with session account             |

### Wallet State Properties

When connected via wallet, additional state is available:

```typescript
interface WalletState {
	provider: WalletProvider;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`; // Set if user switched accounts
	chainId: string;
	invalidChainId: boolean; // True if on wrong chain
	switchingChain: 'addingChain' | 'switchingChain' | false;
	status: 'connected' | 'locked' | 'disconnected';
}
```

## Authentication Mechanisms

### Wallet Authentication

```typescript
// Auto-select wallet if only one available
await connection.connect({type: 'wallet'});

// Connect to specific wallet by name
await connection.connect({type: 'wallet', name: 'MetaMask'});

// Connect to specific address
await connection.connect({
	type: 'wallet',
	name: 'MetaMask',
	address: '0x1234...',
});
```

### Email OTP (requires walletHost)

```typescript
await connection.connect({
	type: 'email',
	mode: 'otp',
	email: 'user@example.com',
});
```

### OAuth (requires walletHost)

```typescript
// Google
await connection.connect({
	type: 'oauth',
	provider: {id: 'google'},
	usePopup: true,
});

// Facebook
await connection.connect({
	type: 'oauth',
	provider: {id: 'facebook'},
	usePopup: true,
});

// Auth0
await connection.connect({
	type: 'oauth',
	provider: {id: 'auth0', connection: 'your-connection'},
	usePopup: true,
});
```

### Mnemonic (requires walletHost)

```typescript
await connection.connect({
	type: 'mnemonic',
	mnemonic: 'your twelve word phrase here...',
	index: 0,
});
```

## API Reference

### ConnectionStore Methods

| Method                                         | Description                           |
| ---------------------------------------------- | ------------------------------------- |
| `subscribe(callback)`                          | Subscribe to state changes            |
| `connect(mechanism?, options?)`                | Initiate connection                   |
| `cancel()`                                     | Cancel ongoing connection             |
| `back(step)`                                   | Navigate back to previous step        |
| `disconnect()`                                 | Disconnect and clear stored data      |
| `requestSignature()`                           | Request signature for session account |
| `connectToAddress(address, options?)`          | Connect to specific wallet address    |
| `switchWalletChain(chainInfo?)`                | Switch wallet to different chain      |
| `unlock()`                                     | Unlock locked wallet                  |
| `ensureConnected(step?, mechanism?, options?)` | Promise-based connection              |
| `isTargetStepReached(connection)`              | Check if target step is reached       |
| `getSignatureForPublicKeyPublication()`        | Get signature for public key          |

### Connect Options

```typescript
interface ConnectOptions {
	requireUserConfirmationBeforeSignatureRequest?: boolean;
	doNotStoreLocally?: boolean;
	requestSignatureRightAway?: boolean;
}
```

### EnsureConnected Options

```typescript
interface EnsureConnectedOptions extends ConnectOptions {
	skipChainCheck?: boolean; // Skip chain validation for WalletConnected step
}
```

## Origin Account Structure

When fully signed in, the account includes:

```typescript
interface OriginAccount {
	address: `0x${string}`; // Main wallet address
	signer: {
		origin: string; // Origin used for signing
		address: `0x${string}`; // Derived session address
		publicKey: `0x${string}`; // Session public key
		privateKey: `0x${string}`; // Session private key
		mnemonicKey: `0x${string}`; // Entropy key
	};
	metadata: {
		email?: string;
	};
	mechanismUsed: Mechanism;
	savedPublicKeyPublicationSignature?: `0x${string}`;
	accountType: string;
}
```

## Type Helpers

### isTargetStepReached

Type guard to narrow connection state:

```typescript
import {isTargetStepReached} from '@etherplay/connect';

connection.subscribe((state) => {
	if (isTargetStepReached(state, 'SignedIn')) {
		// state is now typed as SignedInState
		console.log(state.account.signer.address);
	}
});
```

## Svelte Integration

The connection store is a Svelte store and works seamlessly with Svelte's reactivity:

```svelte
<script>
  import { createConnection } from '@etherplay/connect';

  const connection = createConnection({
    chainInfo: { id: 1, name: 'Ethereum', rpcUrls: { default: { http: ['...'] } } }
  });
</script>

{#if $connection.step === 'Idle'}
  <button on:click={() => connection.connect()}>Connect</button>
{:else if $connection.step === 'SignedIn'}
  <p>Connected as {$connection.account.address}</p>
  <button on:click={() => connection.disconnect()}>Disconnect</button>
{/if}
```

## Utility Exports

```typescript
// Re-exported from @etherplay/alchemy
export {fromEntropyKeyToMnemonic, originPublicKeyPublicationMessage, originKeyMessage};
export type {OriginAccount};

// Re-exported from @etherplay/wallet-connector-ethereum
export type {UnderlyingEthereumProvider};
```

## Related Packages

- [`@etherplay/wallet-connector`](../etherplay-wallet-connector) - Core wallet connector interfaces
- [`@etherplay/wallet-connector-ethereum`](../etherplay-wallet-connector-ethereum) - Ethereum wallet connector
- [`@etherplay/alchemy`](../etherplay-alchemy) - Social login mechanisms

## License

MIT
