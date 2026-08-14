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
│   ├── @etherplay/delegation/                # Onchain delegation: Solidity, message builder, ABI
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
  storagePrefix?: string;           // Namespace this connection's persisted state (default: '')
  permissions?: PermissionDeclaration[]; // Onchain authority to ask for at connect time
}
```

A page can run several connections at once (e.g. a player connection plus a separate payment connection). Give each one its own `storagePrefix` so they do not share a stored identity. See [`packages/etherplay-connect/README.md`](./packages/etherplay-connect/README.md#running-more-than-one-connection-in-a-page).

## Acting onchain for the user

A session account signs from a key of its own, so by default the address that sends a transaction is not the account the action belongs to. Delegation fixes that: the user authorizes the session signer to act in their name **at one contract on one chain**, and that contract attributes the signer's transactions to the account.

Ask for it at connect time:

```typescript
const connection = createConnection({
	walletHost: PUBLIC_WALLET_HOST,
	chainInfo: {id: 31337, /* ... */},
	permissions: [
		{
			type: 'delegation',
			chainId: 31337,
			contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
			required: false, // denying it lets sign-in proceed without the credential
		},
	],
});
```

`permissions` is for **hosted** accounts, and the types enforce it: a hosted account holds its key at the wallet host, so sign-in is the only moment a credential can be minted for it, and declaring it up front is the only way. It is refused on `walletOnly: true` and on `targetStep: 'WalletConnected'`, where nothing could honour it.

An injected wallet is the other shape: the owner is right there, so ask it when the credential is wanted, which is the better moment anyway. Consent at the point of use beats consent at the door, and nothing is minted for a contract the app never touches.

```typescript
// works for both: a stored credential for a hosted account, a live signature for a wallet
const credential = await connection.getDelegation({chainId, contract});
```

If a wallet-owned connection was given a declaration anyway (possible when the app can reach a host but the user picks a wallet), every entry comes back as `{granted: false, reason: 'sign-on-demand'}` rather than silently absent, so the app knows to call `getDelegation` rather than to offer a pointless re-prompt.

What comes back on the account:

```typescript
account.savedDelegations; // one credential per granted (chainId, contract)
account.permissions;      // an answer for EVERY entry, granted or not
```

`permissions` is the part worth reading. An absent credential does not say whether the user declined, whether the wallet was too old to understand the request, or whether the app never asked, and those call for different remedies. Each entry is `{granted: true, deadline}` or `{granted: false, reason: 'denied' | 'unsupported'}`.

Use the credential with `findSavedDelegation` and the exported ABI:

```typescript
import {findSavedDelegation, DELEGATION_ABI} from '@etherplay/connect';

const credential = findSavedDelegation(account.savedDelegations, {chainId, contract});
// anyone can submit it, and pays for it: the account itself never needs gas
await client.writeContract({
	address: contract,
	abi: DELEGATION_ABI,
	functionName: 'registerDelegateViaSignature',
	args: [account.address, credential.delegate, BigInt(credential.deadline), credential.signature],
});
```

The contract side is [`@etherplay/delegation`](./packages/etherplay-delegation/README.md), which ships the Solidity to compile into your own contract. There is deliberately no shared registry: the contract's own address is inside the signed message, which is what stops a credential granted for one game being usable at another.

A credential is a **cache of what is inside the signed bytes**. If a stored copy disagrees with the signed one there is no way to notice locally, the signature simply fails to recover, so treat a signature failure as "discard this record and sign in again" rather than as a contract error.

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
