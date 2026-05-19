# Code Review — etherplay-connect

> Date: 2026-05-19
> Scope: Full monorepo — all packages, web/login, demoes/sveltekit

---

## 1. Openfort Package — Cross-Cutting Concerns It Shouldn't Own

The `@etherplay/openfort` package does a lot that is **not Openfort-specific**. These functions perform generic key derivation and account management that every `AuthProvider` implementation would need.

### 1.1 `generateAccount()` is auth-provider-agnostic

**File:** `packages/etherplay-openfort/src/index.ts`, line 396

```typescript
async function generateAccount({key, mechanism}: {key: `0x${string}`; mechanism: AuthMechanism}) {
    const mnemonic = fromEntropyKeyToMnemonic(key);
    const etherplayAccount: EtherplayAccount = {
        localAccount: {
            address: settings.accountGenerator.fromMnemonicToAccount(mnemonic, 0).address,
            index: 0,
            key,
        },
        signer: { mechanismUsed: mechanism },
        accountType: settings.accountGenerator.type,
    };
    return etherplayAccount;
}
```

This function converts an entropy key into a mnemonic-derived account. It has **nothing to do with Openfort**. It is pure key derivation. The TODO on line 395 even acknowledges it:

> `// TODO extract it from hhere, not openfort specific`

**Should be in:** `@etherplay/connect-core` as a shared utility, since every `AuthProvider` implementation (Openfort, Alchemy, custom) would need this same account derivation logic.

### 1.2 `generateOriginAccount()` is also auth-provider-agnostic

**File:** `packages/etherplay-openfort/src/index.ts`, line 421

```typescript
async function generateOriginAccount(origin: string, account: EtherplayAccount): Promise<OriginAccount> {
    const accountMnemonic = fromEntropyKeyToMnemonic(account.localAccount.key);
    const accountObject = settings.accountGenerator.fromMnemonicToAccount(accountMnemonic, account.localAccount.index);
    const originKeySignature = await settings.accountGenerator.signTextMessage(
        originKeyMessage(origin), accountObject.privateKey,
    );
    const originKey = fromSignatureToKey(originKeySignature);
    const originMnemonic = fromEntropyKeyToMnemonic(originKey);
    const originAccount = settings.accountGenerator.fromMnemonicToAccount(originMnemonic, 0);
    const savedPublicKeyPublicationSignature = await settings.accountGenerator.signTextMessage(
        originPublicKeyPublicationMessage(origin, originAccount.publicKey), accountObject.privateKey,
    );
    return {
        address: account.localAccount.address,
        signer: { origin, publicKey: originAccount.publicKey, address: originAccount.address, privateKey: originAccount.privateKey, mnemonicKey: originKey },
        metadata: {},
        mechanismUsed: account.signer.mechanismUsed,
        savedPublicKeyPublicationSignature,
        accountType: settings.accountGenerator.type,
    };
}
```

This builds an `OriginAccount` by:
1. Deriving a key from the user's local account key
2. Signing the origin message with that key
3. Deriving a new origin account from the signature

The only Openfort-specific thing is that it uses `settings.accountGenerator` (which comes from the Ethereum connector). But the **logic itself** — deriving origin accounts from signatures — is a core protocol concept, not an Openfort concern.

**Should be in:** `@etherplay/connect-core` or `@etherplay/connect`.

### 1.3 `setupOpenfortAccount()` is the truly Openfort-specific part

The only thing that *actually* belongs in the Openfort package is:
- Calling `openfortInstance.embeddedWallet.getEmbeddedState()`
- Calling `openfortInstance.embeddedWallet.create()` / `recover()`
- Calling `openfortInstance.embeddedWallet.signMessage()`
- Calling `openfortInstance.user.get()`
- Calling `openfortInstance.auth.logout()` / `logInWithEmailOtp()` / `initOAuth()` / `storeCredentials()`

### 1.4 Suggested Refactor

```
@etherplay/connect-core
  ├── fromEntropyKeyToMnemonic()
  ├── deriveOriginAccount(origin, localKey, accountGenerator)  ← NEW
  └── deriveEtherplayAccount(key, accountGenerator)            ← NEW

@etherplay/openfort
  └── setupEmbeddedWallet()  ← only Openfort SDK calls
  └── signWithEmbeddedWallet(message)  ← only Openfort SDK calls
```

The `AuthProvider` interface could add a hook:

```typescript
export interface AuthProvider extends Readable<AuthState> {
    // ... existing methods
    setupLocalAccount(): Promise<EtherplayAccount>;   // NEW — Openfort implements this
    // generateAccount and generateOriginAccount removed from interface
}
```

---

## 2. `@etherplay/connect` — Single File Too Large

**File:** `packages/etherplay-connect/src/index.ts` — **1536 lines in a single file**

It contains:
- The `createConnection()` factory
- Connection state machine types
- Auto-connect logic
- Wallet connection logic
- Popup management
- Signature request handling
- Chain switching
- Account change watching
- `ensureConnected()` overloads

This is a massive violation of the single responsibility principle. It should be split into at least:
- `connection-types.ts` — all the type definitions
- `create-connection.ts` — the factory function
- `auto-connect.ts` — auto-connect logic
- `wallet-logic.ts` — wallet connection, account switching
- `signature-logic.ts` — signature request flow

---

## 3. Code Duplication Across Packages

The same utility functions are duplicated in both `@etherplay/connect-core` and `@etherplay/wallet-connector-ethereum`:

| Function | connect-core (line) | wallet-connector-ethereum (line) |
|----------|---------------------|---------------------------------|
| `strip0x()` | 37 | 25 |
| `add0x()` | 40 | 28 |
| `astr()` | 44 | 32 |
| `parse()` | 49 | 36 |
| `addChecksum()` | 61 | 49 |
| `fromPublicKey()` | 73 | 61 |
| `fromPrivateKey()` | 80 | 68 |
| `fromMnemonicToHDKey()` | 27 | 296 |

The ethereum connector even has a copy-paste comment:

```
///////////////////////////////////////////////////////////////////////////////////////////////////
// TAKEN FROM https://github.com/paulmillr/micro-eth-signer/
///////////////////////////////////////////////////////////////////////////////////////////////////
```

**Fix:** These should all live exclusively in `@etherplay/connect-core`, and the ethereum connector should import them.

---

## 4. Hardcoded OAuth Provider Map

**File:** `packages/etherplay-openfort/src/index.ts`, line 129

```typescript
const providerMap: Record<string, any> = {
    google: OAuthProvider.GOOGLE,
    facebook: OAuthProvider.FACEBOOK,
    twitter: OAuthProvider.TWITTER,
    discord: OAuthProvider.DISCORD,
    apple: OAuthProvider.APPLE,
    epic: OAuthProvider.EPIC_GAMES,
    line: OAuthProvider.LINE,
};
```

This is a hardcoded map inside the Openfort implementation. If you add a new auth provider, you need to:
1. Update the Openfort package
2. Update the web/login `state.ts` validation (line 77: only `google` or `facebook` allowed)
3. Update the demo app

There's no registry or discovery mechanism.

---

## 5. `createAuthProvider` in `web/login` — Only Openfort

**File:** `web/login/src/lib/handler.ts`, line 11

```typescript
if (authProviderType === 'openfort') {
    return createOpenfortProvider({...});
}
throw new Error(`auth provider of type "${authProviderType}" is not supported`);
```

The factory is a one-branch switch with no extensibility. A registry pattern would allow third-party providers to register themselves:

```typescript
const providerRegistry = new Map<string, (settings: ProviderSettings) => AuthProvider>();

export function registerAuthProvider(type: string, factory: (settings) => AuthProvider) {
    providerRegistry.set(type, factory);
}

export function createAuthProvider(type: string, ...args) {
    const factory = providerRegistry.get(type);
    if (!factory) throw new Error(`unknown provider: ${type}`);
    return factory(...args);
}
```

---

## 6. State Machine Issues

### 6.1 `AuthState` has unreachable steps

**File:** `packages/etherplay-connect-core/src/types.ts`, line 57

```typescript
| { step: 'Initialising'; auto: boolean; }
| { step: 'Initialised'; }
| { step: 'MechanismToChoose'; }
| { step: 'InitialisingMechanism'; mechanism: AuthMechanism; }   // ← NEVER SET
| { step: 'MechanismChosen'; mechanism: AuthMechanism; }          // ← NEVER SET
```

`InitialisingMechanism` and `MechanismChosen` are defined but never set by the Openfort provider. The Openfort code jumps from `Initialised` directly to `WaitingForOTP`, `ConfirmOAuth`, or `MnemonicIndexToProvide`. These are dead types.

### 6.2 `Connection` and `AuthState` are two separate state machines

The `@etherplay/connect` package has its own `Connection` type (9 steps), and `@etherplay/openfort` has its own `AuthState` type (15+ steps). The popup bridge them via `postMessage`, but there's no coordination. When the popup reaches `SignedIn`, the main app also reaches `SignedIn`, but they use different type structures.

---

## 7. Error Handling Gaps

### 7.1 Swallowed errors in `provideOTP`

**File:** `packages/etherplay-openfort/src/index.ts`, line 281-289

```typescript
} catch (err) {
    const message = 'failed to generate account after OTP';
    store.update((currentState) => ({
        ...currentState,
        error: {message, cause: err},
    }));
    console.error(message, err);
    // throw err;  // ← commented out!
}
```

The error is stored but the function returns `undefined` (void). The caller has no way to know the operation failed — no rejection, no callback. The state machine can't react to it.

### 7.2 `connectViaPopup` ignores `authProvider` env check

**File:** `packages/etherplay-connect/src/index.ts`, line 1392

```typescript
const authProvider = (import.meta as any).env?.VITE_AUTH_PROVIDER || 'openfort';
```

This is used to set the `provider` search param on the popup URL, but the web/login app has no way to register alternative providers (see point 5). If someone sets `VITE_AUTH_PROVIDER=alchemy`, the popup will throw `auth provider of type "alchemy" is not supported`.

---

## 8. Security Concerns

### 8.1 Hardcoded test mnemonic

**File:** `web/login/src/lib/state.ts`, line 107

```typescript
mnemonic: import.meta.env.VITE_DEV_MNEMONIC || 'test test test test test test test test test test test junk',
```

A hardcoded mnemonic in production code is a security risk. Even if intended for dev, it could leak into production builds if env vars aren't properly enforced.

### 8.2 Private keys stored in `OriginAccount`

**File:** `packages/etherplay-connect-core/src/types.ts`, line 21-35

```typescript
export type OriginAccount = {
    signer: {
        privateKey: `0x${string}`;
        mnemonicKey: `0x${string}`;
    };
};
```

The `OriginAccount` stores both `privateKey` and `mnemonicKey` in `localStorage`/`sessionStorage`. While this may be intentional for session accounts, it should be clearly documented as a security boundary. There's no encryption at rest.

### 8.3 `generateKey` logs private key

**File:** `packages/etherplay-openfort/src/index.ts`, line 381-392

```typescript
async function generateKey(message: string): Promise<`0x${string}`> {
    const signature = await openfortInstance.embeddedWallet.signMessage(message);
    const signatureUsingMessageHash = await openfortInstance.embeddedWallet.signMessage(message, {hashMessage: true});
    console.log({
        signature,
        signatureUsingMessageHash,
        privateKey: await openfortInstance.embeddedWallet.exportPrivateKey(),  // ← logged!
    });
    return fromSignatureToKey(signature as `0x${string}`);
}
```

The embedded wallet's private key is printed to the console. This is clearly debug code that should be removed or gated behind a debug flag.

---

## 9. Type System Issues

### 9.1 `AuthProviderSettings` is too loose

**File:** `packages/etherplay-connect-core/src/types.ts`, line 40-42

```typescript
export type AuthProviderSettings = {
    [key: string]: unknown;
};
```

This is an empty interface in disguise. It provides zero type safety for settings passed to `init()`. Each provider should define its own settings type.

### 9.2 `signer` in `EtherplayAccount` allows any key

**File:** `packages/etherplay-connect-core/src/types.ts`, line 50-53

```typescript
signer: {
    mechanismUsed: AuthMechanism;
    [key: string]: unknown;  // ← allows anything
};
```

The `EtherplayAccount.signer` type uses an index signature `[key: string]: unknown`, which defeats the purpose of TypeScript's type safety.

---

## 10. Architecture — Missing Abstractions

### 10.1 No `AuthProviderSettings` typing per provider

Each auth provider needs different settings:
- Openfort needs: `publishableKey`, `shieldPublishableKey`, `encryptionSessionEndpoint`
- A hypothetical Alchemy provider would need different keys

The `AuthProviderSettings` type is `{[key: string]: unknown}` — no compile-time safety.

### 10.2 `AccountGenerator` is Ethereum-specific but typed as generic

The `AccountGenerator` interface is generic, but in practice:
- The only implementation is `EthereumAccountGenerator`
- The web/login `state.ts` line 134 has a hardcoded check: `accountType === 'ethereum'`
- There's no Fuel, Starknet, or other chain support despite the TODO comment in Openfort mentioning them

### 10.3 No plugin/extension system

Adding a new auth provider requires:
1. Creating a new package
2. Modifying `web/login/src/lib/handler.ts` with another `if` branch
3. Modifying `web/login/src/lib/state.ts` validation
4. Potentially modifying `packages/etherplay-connect/src/index.ts` popup logic

There's no registration or discovery mechanism.

---

## 11. Other Issues

### 11.1 `TODO.md` open tasks

**File:** `TODO.md`

- [ ] save publicKey signed message in originAccount
- [ ] allow multiple originAccount in localStorage (indexed by address)
- [ ] fix popup closing detection (not always detected)
- [ ] handle `window.opener == null` with encryption intermediary + broadcast channel
- [ ] auto logout on wallet disconnect/lock (optional, installed wallets only)

### 11.2 `rpc-request-tracking.md` — planned feature

**File:** `plans/rpc-request-tracking.md`

Implementation plan for RPC request tracking. Tracked methods: `eth_sendTransaction`, `personal_sign`, `eth_signTypedData`, `eth_signTypedData_v4`, `eth_sign`, `eth_signTransaction`.

Files to modify:
- `etherplay-wallet-connector/src/index.ts` (types)
- `etherplay-wallet-connector-ethereum/src/provider.ts` (implementation)
- `etherplay-connect/src/index.ts` (store integration)

### 11.3 `lockCheckInterval` polling every 1 second

**File:** `packages/etherplay-connect/src/index.ts`, line 943

```typescript
lockCheckInterval = setInterval(checkLockStatus, 1000);
```

Polling every second for lock status is wasteful. Consider debouncing or using a more efficient approach.

### 11.4 `waitForWallet` hardcoded timeout

**File:** `packages/etherplay-connect/src/index.ts`, line 543-557

```typescript
function waitForWallet(name: string): Promise<WalletHandle<WalletProviderType>> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(interval); reject('timeout'); }, 1000);
        const interval = setInterval(() => {
            const wallet = $connection.wallets.find((v) => v.info.name == name);
            if (wallet) { clearTimeout(timeout); clearInterval(interval); resolve(wallet); }
        }, 100);
    });
}
```

1 second timeout is very aggressive. A wallet announcement can take longer, especially on slow machines or with many wallets installed.

### 11.5 `connect` function — duplicated state transition logic

The wallet connection flow has two nearly identical code blocks (lines 1014-1084 and 1093-1161) for handling the case when accounts are available vs when `requestAccounts()` needs to be called. These could be extracted into a shared helper.

---

## Summary of Prioritized Issues

| Priority | Issue | Impact | Files |
|----------|-------|--------|-------|
| **P0** | `generateAccount()` / `generateOriginAccount()` should be in `connect-core` | Architectural — every provider repeats this logic | `packages/etherplay-openfort/src/index.ts:396,421` |
| **P0** | Code duplication (`strip0x`, `add0x`, `parse`, etc.) across packages | Maintenance burden, inconsistency risk | `packages/etherplay-connect-core/src/index.ts`, `packages/etherplay-wallet-connector-ethereum/src/index.ts` |
| **P1** | `console.log` of private key in production code | Security | `packages/etherplay-openfort/src/index.ts:391` |
| **P1** | Hardcoded OAuth provider map + state.ts validation | Extensibility — adding providers requires touching 3+ packages | `packages/etherplay-openfort/src/index.ts:129`, `web/login/src/lib/state.ts:77` |
| **P1** | `createAuthProvider` factory is a one-branch switch | Extensibility | `web/login/src/lib/handler.ts:11` |
| **P2** | Swallowed errors in `provideOTP` (void return, no throw) | Bugs — callers can't detect failures | `packages/etherplay-openfort/src/index.ts:281-289` |
| **P2** | `connect` is 1536 lines in a single file | Maintainability | `packages/etherplay-connect/src/index.ts` |
| **P2** | Dead types in `AuthState` (`InitialisingMechanism`, `MechanismChosen`) | Confusion | `packages/etherplay-connect-core/src/types.ts:72-78` |
| **P2** | `lockCheckInterval` polls every 1 second | Performance | `packages/etherplay-connect/src/index.ts:943` |
| **P2** | `waitForWallet` 1s timeout is too aggressive | Reliability | `packages/etherplay-connect/src/index.ts:543-557` |
| **P3** | Hardcoded test mnemonic in state.ts | Security risk in dev | `web/login/src/lib/state.ts:107` |
| **P3** | `AuthProviderSettings` is `{[key: string]: unknown}` | No type safety | `packages/etherplay-connect-core/src/types.ts:40-42` |
| **P3** | Two disconnected state machines (`Connection` + `AuthState`) | Complexity | `packages/etherplay-connect/src/index.ts`, `packages/etherplay-connect-core/src/types.ts` |
| **P3** | `EtherplayAccount.signer` uses index signature `[key: string]: unknown` | Type safety | `packages/etherplay-connect-core/src/types.ts:52` |
| **P3** | Duplicated state transition logic in `connect` | Maintainability | `packages/etherplay-connect/src/index.ts:1014-1161` |
