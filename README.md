# @etherplay/connect

A modern wallet connection library that provides seamless authentication via session accounts. Support for both social login mechanisms (email, OAuth, mnemonic) and traditional Web3 wallet connections.

## Overview

@etherplay/connect is a TypeScript library offering a flexible wallet connection solution that bridges the gap between Web3 wallets and Web2 social authentication. It enables users to authenticate through multiple mechanisms and maintain session accounts that persist across device and browser sessions.

### Key Features

- **Multiple Authentication Mechanisms**
  - Email with OTP verification
  - OAuth (Google, Facebook, Auth0)
  - Mnemonic phrase login
  - Web3 wallet connection (MetaMask, WalletConnect, etc.)

- **Session Account Management**
  - Derives origin accounts from signatures
  - Secure local storage persistence
  - Automatic reconnection on page reload

- **Web3 Wallet Integration**
  - EIP-6963 provider detection
  - Account and chain change monitoring
  - Automatic chain switching support
  - Lock/unlock state handling

- **Developer Friendly**
  - TypeScript support with full type definitions
  - Svelte 5 store integration
  - Comprehensive connection states
  - Built-in error handling

## Monorepo Structure

```
etherplay-connect/
├── packages/
│   ├── @etherplay/wallet-connector/          # Core wallet connector interfaces
│   ├── @etherplay/wallet-connector-ethereum/  # Ethereum implementation
│   ├── @etherplay/alchemy/                   # Social login integration
│   └── @etherplay/connect/                   # Main connection library
├── demoes/
│   └── sveltekit/                            # Demo application
├── web/
│   └── login/                                # Login component
└── package.json
```

## Installation

### Using the main package

```bash
pnpm add @etherplay/connect
```

## Quick Start

### Basic Setup

```typescript
import {createConnection} from '@etherplay/connect';

const connection = createConnection({
	signingOrigin: 'https://testing.io',
	walletHost: PUBLIC_WALLET_HOST,
	chainInfo: {
		id: 1,
		rpcUrls: {
			default: {
				http: [ETHEREUM_RPC],
			},
		},
		name: 'Ethereum',
		nativeCurrency: {
			decimals: 18,
			name: 'Ether',
			symbol: 'ETH',
		},
	},
});

// Subscribe to connection state
connection.subscribe(($connection) => {
	console.log('Connection state:', $connection);
});

// Connect via social login
await connection.connect({type: 'email', mode: 'otp', email: 'user@example.com'});

// Or connect via wallet
await connection.connect({type: 'wallet', name: 'MetaMask'});
```

### Using in Svelte

```svelte
<script>
  import { createConnection } from '@etherplay/connect';

  const connection = createConnection({
    signingOrigin: 'https://testing.io',
    walletHost: PUBLIC_WALLET_HOST,
    chainInfo: {
      id: 1,
      rpcUrls: { default: { http: [ETHEREUM_RPC] } }
    }
  });

  let $connection;
  connection.subscribe(value => $connection = value);

  async function connectWithWallet() {
    await connection.connect({ type: 'wallet' });
  }
</script>

{#if $connection.step === 'Idle'}
  <button on:click={connectWithWallet}>Connect Wallet</button>
{/if}
```

## Authentication Mechanisms

### Email Login

```typescript
await connection.connect({
	type: 'email',
	mode: 'otp',
	email: 'user@example.com',
});
```

### OAuth Login

```typescript
// Popup mode
await connection.connect({
	type: 'oauth',
	provider: {id: 'google'},
	usePopup: true,
});

// Redirect mode
await connection.connect({
	type: 'oauth',
	provider: {id: 'auth0', connection: 'your-connection'},
	usePopup: false,
});
```

### Mnemonic Login

```typescript
await connection.connect({
	type: 'mnemonic',
	mnemonic: 'your twelve word mnemonic phrase here',
	index: 0,
});
```

### Web3 Wallet Login

```typescript
// Connect to any available wallet
await connection.connect({type: 'wallet'});

// Connect to specific wallet
await connection.connect({
	type: 'wallet',
	name: 'MetaMask',
});

// Connect to specific address
await connection.connect({
	type: 'wallet',
	address: '0x...',
});
```

## Connection States

The connection store goes through several states during the authentication flow:

- **Idle** - Initial state, waiting for user action
- **MechanismToChoose** - User needs to select authentication method
- **PopupLaunched** - Popup window opened for social login
- **WalletToChoose** - User needs to select from available wallets
- **WaitingForWalletConnection** - Connecting to selected wallet
- **ChooseWalletAccount** - User needs to select wallet account
- **WalletConnected** - Wallet connected, waiting for signature
- **WaitingForSignature** - Signature request pending
- **SignedIn** - Fully authenticated

## Configuration Options

### createConnection Parameters

```typescript
{
  signingOrigin?: string;           // Origin for signature messages
  walletHost: string;               // Host URL for login popup
  autoConnect?: boolean;            // Auto-connect on load (default: true)
  autoConnectWallet?: boolean;      // Auto-connect to wallet (default: true)
  walletConnector?: WalletConnector; // Custom wallet connector
  requestSignatureAutomaticallyIfPossible?: boolean;
  useCurrentAccount?: 'always' | 'whenSingle' | false; // Auto-switch when account changes (always or only when single account)
  chainInfo: ChainInfo;             // Blockchain configuration
  prioritizeWalletProvider?: boolean;
  requestsPerSecond?: number;       // Rate limiting for provider
}
```

## Development

### Prerequisites

- Node.js 18+
- pnpm 8+

### Setup

```bash
# Clone repository
git clone https://github.com/wighawag/etherplay-connect.git
cd etherplay-connect

# Install dependencies
pnpm install

# Start demo
pnpm start
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.
