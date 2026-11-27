# Ed25519/X25519 keys in the public-key publication

**Status**: proposed (2026-11-27), not started. Waits on `delegated-identity` 0.2.0 (its spec `work/specs/tasked/ed25519-keys-in-the-publication.md`; check with `npm view delegated-identity@0.2.0 version`). Ships as `@etherplay/connect-core` 0.8.0 and `@etherplay/connect` 0.19.0 (breaking, so a minor bump on 0.x), the versions missiv's tasks check for.

Scope: `@etherplay/connect-core` (the derivation and the signature at sign-in), the wallet-host popup (`web/login`, deployed on its own), and `@etherplay/connect` (the account it hands the app, the publication signature, storage). The delegation contract and `savedDelegations` do not change.

## The problem

The public-key publication (`originPublicKeyPublicationMessage`, from `delegated-identity`) names the origin signer's secp256k1 key, and every service that checks a delegated request (missiv, push-notification-server, etherfold's trigger service) recovers that key from each request in pure JS (secp256k1 has no WebCrypto anywhere). missiv's throughput redesign (missiv `docs/adr/0004-messaging-keys-one-ciphertext-server-checked-signatures.md`) moves request and message signatures to Ed25519 and encryption to X25519, both native in WebCrypto, and the wallet authorizes them directly: `delegated-identity` changes the publication message to name an Ed25519 signing key and an X25519 encryption key instead of the origin key. This is a breaking change, made as an edit rather than a second format because no production app depends on it (decided with the human, 2026-11-27).

## What is decided

### The origin signer stays; two keys are derived beside it

`deriveOriginAccount` keeps deriving the origin signer exactly as today (it is the on-chain delegate in `savedDelegations`), and adds `delegated-identity`'s `deriveKeySet(originAccount.privateKey)`: an Ed25519 signing key and an X25519 encryption key, deterministic, so every device of the account derives the same set. The account object gains them beside `signer`, for example `keys: {signing: {publicKey, privateKey}, encryption: {publicKey, privateKey}}` (the exact name settled at build time, documented in the README). Persisting them is the same exposure as persisting `signer.privateKey` today, since they are derived from it.

### The publication signature names the key set

`deriveOriginAccount` signs `originPublicKeyPublicationMessage(origin, keySet)` with the account key, so `savedPublicKeyPublicationSignature` is over the new message. `getSignatureForPublicKeyPublication()` signs the new message live on the wallet path and returns the saved one on the popup paths, as today.

### Every previously connected account signs again

A hosted (popup) account can only sign at sign-in ("there is currently no way to sign it after the fact for these mechanisms", the README), so its new signature needs a new sign-in. connect therefore treats a stored account as signed out unless its saved publication signature VERIFIES for the new message: `recoverAccount({appOrigin, keySet, ownershipSignature: savedPublicKeyPublicationSignature})` must equal `account.address`. Checking for the presence of the key set is not enough, since an app could derive the keys from `signer.privateKey` beside an old-format signature. On load it drops a failing account (the same choke point that strips the legacy entropy key today, `withoutEntropyKey`), and the next connect goes through sign-in again, producing the key set and the new signature. Wallet accounts take the same path, so a wallet signs the new message once.

### The popup is deployed independently

The popup can be older than the app (the same skew `mnemonicKey` stripping handles). An app applies the same verification to an account the popup returns: one whose saved signature does not verify for the new message (an older popup) fails sign-in with a clear error ("the wallet host is out of date") rather than being stored. The popup is deployed before apps adopt this release.

## Order of work

1. `delegated-identity` releases the new publication message, `deriveKeySet` and the Ed25519 request envelope.
2. connect-core and the popup: derive, sign, return; the popup deployed.
3. `@etherplay/connect`: the account shape, storage invalidation, the skew check, README.
4. Consumers: missiv (its spec `scalable-direct-messaging`), push-notification-server (task `ed25519-delegated-identity`), etherfold's triggers (task `triggers-ed25519-delegated-identity`).
5. The apps, last, once all of the above are released: jolly-roger's `with/push-notifications` (`web/src/lib/push/notifications.ts`: the push client and the trigger registration take the key set and the signature instead of `signer`), `with/messaging` (`web/src/lib/messaging/messaging.ts`: missiv's registration and stores take the key set) and the dev stack's notifier (`web/notifier/serve.ts`), each cascaded through jolly-roger's template tree. jolly-roger has no `work/` tree; this step is tracked here until it does.

## Tests

- `deriveOriginAccount` returns the key set and a publication signature that `delegated-identity` verifies for it; two derivations from the same account and origin are identical.
- A stored account whose saved signature does not verify for the new message (old format, or keys without a matching signature) is dropped on load and the app sees `Idle` / signed out.
- An account from a popup whose signature does not verify fails sign-in with the out-of-date error.
- The existing derivation, delegation and storage-prefix tests still pass.
