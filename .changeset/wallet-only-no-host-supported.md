---
'@etherplay/connect': patch
---

Document and test the backend-free configuration: `targetStep: 'SignedIn'` with `walletOnly: true` and no `walletHost`.

This capability already worked, but only the type surface implied it, so downstream apps had no way to tell an intended guarantee from an accident of how the overloads happen to be written. Nothing is added and no behaviour changes: the configuration is now a supported, tested, documented shape.

It means: sign the user in and derive the local session signer, but offer only built-in (injected / EIP-6963) wallets as the owner, with no hosted email/social mechanisms and no backend of any kind. The wallet signs `originKeyMessage(origin)`, the signature is hashed into an entropy key, and the mnemonic derived from it produces the session account. No request leaves the page, and the derivation is reproducible, so a returning user recovers the same signer with no server to ask.

The `walletHost?: string` on the `walletOnly: true` SignedIn overloads is a promise, not an accident. It is declared optional there while staying `walletHost: string` on the `walletOnly?: false` SignedIn overloads: a host is required exactly when a popup can be reached, and under `walletOnly` none can, since `connect()` defaults the mechanism to `{type: 'wallet'}` and the mechanism picker is never shown.

- `test/wallet-only-no-host.test.ts` pins the runtime behaviour end-to-end against the real Ethereum connector and a real EIP-6963 announcement: construction with no host, reaching `WalletConnected` without ever entering `MechanismToChoose` or `PopupLaunched`, reaching `SignedIn` with a session signer whose address really is its private key's address, signing over the page's own origin, reproducible derivation, working auto-connect, and `window.open` never being called.
- `test/types/wallet-only-no-host.types.ts` pins the type surface, including the negative case: making `walletHost` optional everywhere fails the check. It is compile-time only and runs via the new `pnpm test:types`, which `pnpm test` now also runs.
- The README gains a "Supported connection shapes" section covering hosted sign-in, wallet-only sign-in with no backend, and plain `WalletConnected` side by side.

It also documents a mistake this configuration makes easy to re-make: deciding whether an app can have a local signer by testing whether a `PUBLIC_WALLET_HOST`-style variable is set. That is wrong, because both wallet-only sign-in and `targetStep: 'WalletConnected'` run with no host and only the first has a signer. The correct test is `targetStep === 'SignedIn'`.

`getSignatureForPublicKeyPublication()` was checked as the one method that sounded host-adjacent. It is not: on a wallet mechanism it asks the connected wallet to sign the publication message locally, so it is fully available in this configuration. Its real constraint, now documented, is the mechanism rather than the host: on popup mechanisms it can only return a signature the hosted sign-in already saved.
