# @etherplay/alchemy

Alchemy mechanism for deterministic account generation in the `@etherplay/connect` ecosystem. This package provides social login mechanisms including email OTP, OAuth (Google, Facebook, Auth0), and mnemonic phrase authentication using Alchemy's Account Kit infrastructure.

## Installation

```bash
npm install @etherplay/alchemy
# or
pnpm add @etherplay/alchemy
# or
yarn add @etherplay/alchemy
```

## Features

- **Email OTP Login**: Authenticate users via email with one-time passwords
- **OAuth Support**: Login via Google, Facebook, or Auth0 providers
- **Mnemonic Login**: Direct authentication using BIP-39 mnemonic phrases
- **Deterministic Account Generation**: Generate consistent accounts from social login credentials
- **Origin-Based Account Isolation**: Create isolated session accounts per origin for security
- **Svelte Integration**: Built-in Svelte store support for reactive state management

## Peer Dependencies

This package requires Svelte 5.x as a peer dependency:

```bash
npm install svelte@^5.0.0
```

## Usage

### Basic Setup

```typescript
import {createAlchemyConnection} from '@etherplay/alchemy';
import {EthereumWalletConnector} from '@etherplay/wallet-connector-ethereum';

const connector = new EthereumWalletConnector();

const connection = createAlchemyConnection({
	alchemy: {
		apiKey: 'YOUR_ALCHEMY_API_KEY',
		// Additional Alchemy configuration
	},
	accountGenerator: connector.accountGenerator,
	windowOrigin: window.location.origin,
	signingOrigin: 'https://your-app.com',
	autoInitialise: true,
});

// Subscribe to connection state changes (Svelte store)
connection.subscribe((state) => {
	console.log('Connection state:', state?.step);
});
```

### Email OTP Login

```typescript
// Start email authentication
await connection.connect({
	type: 'email',
	mode: 'otp',
	email: 'user@example.com',
});

// After user receives OTP
await connection.provideOTP('123456');
```

### OAuth Login (Google/Facebook)

```typescript
// Using popup
await connection.connect({
	type: 'oauth',
	provider: {id: 'google'},
	usePopup: true,
});

// Then confirm the OAuth flow
await connection.confirmOAuth();
```

### OAuth Login (Auth0)

```typescript
await connection.connect({
	type: 'oauth',
	provider: {id: 'auth0', connection: 'your-auth0-connection'},
	usePopup: true,
});
```

### Mnemonic Login

```typescript
await connection.connect({
	type: 'mnemonic',
	mnemonic: 'your twelve word mnemonic phrase goes here and more words',
	index: 0,
});
```

### Connection States

The connection follows a state machine with the following steps:

| Step                      | Description                           |
| ------------------------- | ------------------------------------- |
| `Initialising`            | Connection is being initialized       |
| `Initialised`             | Signer is ready                       |
| `MechanismToChoose`       | Waiting for mechanism selection       |
| `MechanismChosen`         | Mechanism selected, processing        |
| `EmailToProvide`          | Waiting for email input               |
| `WaitingForOTP`           | Email sent, waiting for OTP           |
| `VerifyingOTP`            | Verifying the provided OTP            |
| `ConfirmOAuth`            | OAuth popup ready, needs confirmation |
| `WaitingForOAuthResponse` | Waiting for OAuth provider response   |
| `MnemonicIndexToProvide`  | Waiting for mnemonic index            |
| `GeneratingAccount`       | Creating the account                  |
| `SignedIn`                | Successfully authenticated            |

### Origin Account Generation

Generate isolated accounts for specific origins:

```typescript
connection.subscribe(async (state) => {
	if (state?.step === 'SignedIn') {
		const originAccount = await connection.generateOriginAccount('https://game.example.com', state.account);

		console.log('Origin account address:', originAccount.signer.address);
		console.log('Origin public key:', originAccount.signer.publicKey);
	}
});
```

## Types

### AlchemyMechanism

```typescript
type AlchemyMechanism = EmailMechanism<string | undefined> | OauthMechanism | MnemonicMechanism<number | undefined>;
```

### EtherplayAccount

```typescript
type EtherplayAccount = {
	localAccount: {
		address: `0x${string}`;
		index: number;
		key: `0x${string}`;
	};
	signer: {
		mechanismUsed: AlchemyMechanism;
		user: AlchemyUser;
	};
	accountType: string;
};
```

### OriginAccount

```typescript
type OriginAccount = {
	address: `0x${string}`;
	signer: {
		origin: string;
		address: `0x${string}`;
		publicKey: `0x${string}`;
		privateKey: `0x${string}`;
		mnemonicKey: `0x${string}`;
	};
	metadata: {
		email?: string;
	};
	mechanismUsed: AlchemyMechanism | {type: string};
	savedPublicKeyPublicationSignature?: `0x${string}`;
	accountType: string;
};
```

### AlchemyUser

```typescript
type AlchemyUser = {
	email?: string;
	orgId: string;
	userId: string;
	address: `0x${string}`;
	credentialId?: string;
	idToken?: string;
	claims?: Record<string, unknown>;
};
```

## API Reference

### createAlchemyConnection

```typescript
function createAlchemyConnection(settings: {
	alchemy: AlchemySettings;
	autoInitialise?: boolean;
	alwaysUsePopupForOAuth?: boolean;
	accountGenerator: AccountGenerator;
	windowOrigin: string;
	signingOrigin: string;
}): AlchemyConnectionStore;
```

### AlchemyConnectionStore Methods

| Method                                   | Description                                  |
| ---------------------------------------- | -------------------------------------------- |
| `subscribe`                              | Subscribe to connection state changes        |
| `connect(mechanism?)`                    | Start authentication with optional mechanism |
| `confirmOAuth()`                         | Confirm OAuth popup authentication           |
| `provideEmail(email)`                    | Provide email for OTP authentication         |
| `provideOTP(otp)`                        | Submit OTP code                              |
| `provideMnemonicIndex(index)`            | Provide account index for mnemonic           |
| `generateOriginAccount(origin, account)` | Generate origin-specific account             |
| `completeOAuthWithBundle(...)`           | Complete OAuth with redirect bundle          |
| `confirmOriginAccess()`                  | Confirm cross-origin access                  |

## Utility Functions

```typescript
// Generate mnemonic from entropy key
fromEntropyKeyToMnemonic(key: `0x${string}`): string;

// Generate key from signature
fromSignatureToKey(signature: `0x${string}`): `0x${string}`;

// Message templates
originKeyMessage(origin: string): string;
localKeyMessage(): string;
originPublicKeyPublicationMessage(origin: string, publicKey: `0x${string}`): string;
```

## Security Considerations

- **Local Key Message**: Users should never sign the local key generation message outside of the Etherplay wallet
- **Origin Isolation**: Each origin gets a unique derived account to prevent cross-site account correlation
- **OTP Verification**: Email OTP provides secure passwordless authentication
- **OAuth Tokens**: OAuth tokens are handled securely through Alchemy's infrastructure

## Related Packages

- [`@etherplay/wallet-connector`](../etherplay-wallet-connector) - Core wallet connector interfaces
- [`@etherplay/wallet-connector-ethereum`](../etherplay-wallet-connector-ethereum) - Ethereum wallet connector
- [`@etherplay/connect`](../etherplay-connect) - Main connection library

## License

MIT
