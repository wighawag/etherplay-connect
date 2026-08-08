# @etherplay/connect

## 0.3.0

### Minor Changes

- 57e3773: Pre-generate a second signature at derivation time, `savedDelegationSignature`, authorizing the derived session signer to act onchain on the account's behalf.

  `deriveOriginAccount` already pre-generated `savedPublicKeyPublicationSignature`, which authorizes the signer's public key to receive encrypted messages. This adds a sibling in the same style, over the new `originDelegationMessage(origin, signer.address)`, so a contract can verify "account A delegates to signer S" and attribute S's transactions to A. It is a separate message rather than a reuse of the existing one because a user who authorized a key so that "others can use this key to write encrypted messages to you securely" has not thereby authorized a key that spends gas and posts in their name: different risk, different consent, different text.

  It has to be pre-generated. A hosted account (email / OAuth) holds its key at the wallet host, not in the app, and no live arbitrary-signing capability is exposed, so sign-in is the only moment this signature can be produced. The registration transaction is submitted and paid for by a different wallet, so the account itself never needs gas or a wallet: it signs, somebody else submits.

  Two details are consensus rather than style, because the verifying contract reproduces them literally:

  - the delegate is the signer's **address**, not its public key, and it is rendered **lowercase**. The lowercasing happens inside `originDelegationMessage` rather than at the call site, so no caller can hand it an EIP-55 checksummed spelling (which is what viem returns) that then fails to verify onchain.
  - the message wording is fixed. `test/origin-delegation.test.ts` pins the exact bytes; changing them invalidates every signature ever generated and has to happen on both sides at once.

  The signature carries no nonce, index, expiry, chainId or contract address, because it asserts a permanent fact rather than a scoped authorization. The signer is derived as `keccak256(sign(originKeyMessage(origin)))` through a mnemonic, and ECDSA signing is deterministic (RFC 6979), so the same account on the same origin always derives the same signer, on every device and after any storage wipe. There is exactly one delegate per account per origin and it can never legitimately change, so replay is harmless: it re-asserts something already true, and the value forwarded in the registration transaction comes from the submitter, so a replayer spends their own gas to change nothing. Each omitted field would also require knowledge the host does not have at sign-in, turning one permanent signature into a stream it cannot generate. The accepted consequence is that one signature is valid on every chain and in every contract implementing the scheme, which is what its text says. Revocation is handled onchain by a withdrawal flag the account sets itself.

  `originKeyMessage` is untouched, and the new signature is purely additive: it does not feed back into the derivation. Both facts are pinned by tests, because any change there re-derives every existing user onto a different signer address, orphaning funds and onchain state attached to the old one with no migration path.

  On the wallet mechanism the field is `undefined`, matching `savedPublicKeyPublicationSignature`: the connected wallet is live and can sign the same message on demand. `originDelegationMessage` is re-exported from `@etherplay/connect`.

### Patch Changes

- Updated dependencies [57e3773]
  - @etherplay/connect-core@0.2.0

## 0.2.1

### Patch Changes

- 6903404: Type a `targetStep: 'WalletConnected'` connection as `walletOnly: true`, which is what it already is at runtime.

  The runtime computes `walletOnly = settings.walletOnly || targetStep === 'WalletConnected'`, so a `WalletConnected` store always exposes `walletOnly === true`. The two `WalletConnected` overloads disagreed about that: the default-Ethereum-connector one returned `ConnectionStore<..., 'WalletConnected', true>` while the custom-connector one returned `ConnectionStore<..., 'WalletConnected'>`, leaving the parameter at its `false` default. So `store.walletOnly` was typed `false` on a store that reports `true`, and the two overloads contradicted each other for no reason.

  Both now say `true`. Only the `walletOnly` property changes type: every other member of `ConnectionStore` ignores the `WalletOnly` parameter once `Target` is `'WalletConnected'`, so `connect`, `ensureConnected` and `isTargetStepReached` are unaffected. Code that read `store.walletOnly` on such a connection was reading a value the types described wrongly; code that compared it against `false` was already dead at runtime and now fails to compile, which is the point.

  `AnyConnectionStore` deliberately keeps its `ConnectionStore<..., 'WalletConnected', false>` member even though `createConnection` no longer produces one: the type is exported, and narrowing the union would break consumers that spelled that member out explicitly.

- 5f21172: Document and test the backend-free configuration: `targetStep: 'SignedIn'` with `walletOnly: true` and no `walletHost`.

  This capability already worked, but only the type surface implied it, so downstream apps had no way to tell an intended guarantee from an accident of how the overloads happen to be written. Nothing is added and no behaviour changes: the configuration is now a supported, tested, documented shape.

  It means: sign the user in and derive the local session signer, but offer only built-in (injected / EIP-6963) wallets as the owner, with no hosted email/social mechanisms and no backend of any kind. The wallet signs `originKeyMessage(origin)`, the signature is hashed into an entropy key, and the mnemonic derived from it produces the session account. No request leaves the page, and the derivation is reproducible, so a returning user recovers the same signer with no server to ask.

  The `walletHost?: string` on the `walletOnly: true` SignedIn overloads is a promise, not an accident. It is declared optional there while staying `walletHost: string` on the `walletOnly?: false` SignedIn overloads: a host is required exactly when a popup can be reached, and under `walletOnly` none can, since `connect()` defaults the mechanism to `{type: 'wallet'}` and the mechanism picker is never shown.

  - `test/wallet-only-no-host.test.ts` pins the runtime behaviour end-to-end against the real Ethereum connector and a real EIP-6963 announcement: construction with no host, reaching `WalletConnected` without ever entering `MechanismToChoose` or `PopupLaunched`, reaching `SignedIn` with a session signer whose address really is its private key's address, signing over the page's own origin, reproducible derivation, working auto-connect, and `window.open` never being called.
  - `test/types/wallet-only-no-host.types.ts` pins the type surface, including the negative case: making `walletHost` optional everywhere fails the check. It is compile-time only and runs via the new `pnpm test:types`, which `pnpm test` now also runs.
  - The README gains a "Supported connection shapes" section covering hosted sign-in, wallet-only sign-in with no backend, and plain `WalletConnected` side by side.

  It also documents a mistake this configuration makes easy to re-make: deciding whether an app can have a local signer by testing whether a `PUBLIC_WALLET_HOST`-style variable is set. That is wrong, because both wallet-only sign-in and `targetStep: 'WalletConnected'` run with no host and only the first has a signer. The correct test is `targetStep === 'SignedIn'`.

  `getSignatureForPublicKeyPublication()` was checked as the one method that sounded host-adjacent. It is not: on a wallet mechanism it asks the connected wallet to sign the publication message locally, so it is fully available in this configuration. Its real constraint, now documented, is the mechanism rather than the host: on popup mechanisms it can only return a signature the hosted sign-in already saved.

- 779ed5a: Stop `withTimeout` emitting an unhandled rejection (and leaking a timer) when the call it wraps fails.

  `withTimeout` attaches a side-effect handler to the promise it races, purely to cancel the pending timer once that promise settles. It passed only an `onFulfilled` callback:

  ```js
  promise.then((result) => {
  	/* clear the timer */
  });
  ```

  A `.then()` with no rejection handler creates a SECOND derived promise, and that one rejects with nobody listening. The caller's own error handling is irrelevant: it is attached to the promise returned by `Promise.race`, not to this derived branch. So every failing call routed through `withTimeout` emitted an unhandled rejection even when fully handled.

  `connect()` wraps `getChainId()` and `getAccounts()` in `withTimeout`, so this fired on completely ordinary outcomes: a locked wallet, a wallet that refuses to authorize accounts (EIP-1193 `4100`), a user declining a prompt (`4001`). The visible effects were console noise blaming the app for an error it had handled, a spurious failure in test runs that treat unhandled rejections as errors, and a hard crash under `--unhandled-rejections=strict`.

  The same missing handler leaked the timer on the rejection path: after a call failed, its timer stayed pending for the rest of the timeout (5s by default) instead of being cancelled.

  Both are fixed by handling both settle paths, since the branch only ever existed for its side effect. The value and the error are still propagated by the `Promise.race`, so timeout semantics are unchanged. `test/utils.test.ts` now pins the rejection is propagated unchanged, that no unhandled rejection is emitted (whether the caller awaits or catches, and also when the wrapped promise fails only after the timeout has already won), and that the timer is cleared on both paths.

## 0.2.0

### Minor Changes

- 7d71662: Add `storagePrefix` so several connections in one page keep separate persisted state.

  A page can legitimately run more than one connection: a player connection (hosted sign-in, `targetStep: 'SignedIn'`) plus a separate payment connection (`targetStep: 'WalletConnected'`, `autoConnect: false`) so whoever pays need not be the account the player signed in as. Until now both wrote the same two module-level keys, `__origin_account` and `__last_wallet`, in both `localStorage` and `sessionStorage`, so they silently overwrote and deleted each other's state: connecting the payment wallet made the player connection auto-reconnect as the payer on the next page load, `disconnect()` on either connection wiped the other's stored identity, and `cancel()` wiped the other's last-wallet hint.

  `storagePrefix` is available on every `createConnection` overload and namespaces both keys in both storages, so the effective keys are `${storagePrefix}__origin_account` and `${storagePrefix}__last_wallet`. It defaults to `''`, which keeps the keys byte-identical for existing single-connection apps: no migration, no lost sessions. `disconnect()` and `cancel()` now only clear their own connection's namespace, which falls out of the prefixing.

  What `doNotStoreLocally` covers is unchanged: it still gates saving the origin account and nothing else. `saveLastWallet` stays unconditional on purpose, since remembering the last wallet is wanted for every connection, including the payment one, and namespaced it no longer collides.

### Patch Changes

- e75e69a: Deduplicate EIP-6963 wallet announcements so several connections in one page are safe.

  EIP-6963 discovery is page-wide. Unless a `walletConnector` is passed in, each `createConnection` builds its own connector, which attaches an `eip6963:announceProvider` listener and dispatches `eip6963:requestProvider`. Two connections constructed close together overlap in that window: the second one's request makes every installed wallet announce itself again while the first is still listening, and the first appended the repeat. With exactly one wallet installed, `connection.wallets` ended up with two entries for the same `info.uuid`, which took the `wallets.length > 1` branch and stopped the flow at a `WalletToChoose` picker listing that wallet twice, with the entry button degraded from "Connect \<WalletName\>" to "Connect a Wallet".

  Announcements are now deduplicated on `info.uuid`, falling back to `info.rdns` for wallets that regenerate their uuid. This is done where the list is built in `@etherplay/connect`, so it holds for any connector, and also inside `createWalletFetcher` in `@etherplay/wallet-connector-ethereum`, so the connector never records the same wallet twice either. Creating any number of connections is safe by default, with no need to share an `EthereumWalletConnector` between them.

  Unchanged, and still a known limitation: the Ethereum connector stops listening for announcements 100 ms after construction, so a wallet that announces later is not listed.

- Updated dependencies [e75e69a]
  - @etherplay/wallet-connector-ethereum@0.0.12

## 0.1.4

### Patch Changes

- 3b80f88: Document and pin down the SSR / construction-inertness contract. `createConnection(...)` is now a tested, guaranteed property: it constructs in any environment (bare Node, no DOM) without throwing, touching `window`/`document`/`localStorage`/`sessionStorage`, scheduling timers, or doing network I/O, and off-browser the store rests at `{step: 'Idle', loading: true, wallets: []}` — identical to the browser's first render so hydration does not mismatch. Added a `node`-environment regression test (`test/ssr-inert.test.ts`) covering both `targetStep: 'WalletConnected'` and `targetStep: 'SignedIn'` configurations, and documented the contract (including that `loading: true` and the initial store shape are a hydration-visible breaking change, and that `provider.request(...)` intentionally performs a real RPC request off-browser) in the README. No runtime behaviour changed.

## 0.1.3

### Patch Changes

- 54f3d05: Reset the always-on provider wrapper when a connection attempt fails, so read-only RPC calls (eth_call, eth_blockNumber, etc.) fall back to the JSON-RPC endpoint instead of being routed through the failed wallet provider.

## 0.1.2

### Patch Changes

- d1ec11c: Distinguish EIP-1193 error codes (4100/4001) in connect failure and add clearError to store API

## 0.1.1

### Patch Changes

- 60a51f3: Fix a dead end after a rejected wallet prompt in wallet-only mode.

  In wallet-only mode (`walletOnly: true`, or `targetStep: 'WalletConnected'`) the mechanism picker is never shown, because `connect` always defaults the mechanism to `{type: 'wallet'}`. The wallet failure handlers still rested on `MechanismToChoose`, a step such an app has no reason to render, so a rejected wallet prompt left the user with nothing on screen and no way to retry or cancel. `ensureConnected` only ever initiated from `Idle`, so the next call neither prompted the wallet nor settled: it hung silently.

  Two changes:

  - A failed attempt now rests on the step that offers the user a real next decision: `MechanismToChoose` when the app is multi-mechanism, `WalletToChoose` when the app is wallet-only and several wallets are detected, and `Idle` when it is wallet-only with a single (or no) wallet. The `error` is kept in every case so the UI can explain the failure. This rule now covers all three wallet failure paths, which is also what makes them consistent with the auto-connect paths that already reset to `Idle`.
  - `ensureConnected` now also initiates from a picker step that still carries the `error` of a previous failed attempt, so a retry prompts again instead of waiting forever. It still refuses to initiate from a picker step without an error, since that means the user is mid-choice and connecting would hijack it. The new `{forceConnect: true}` option opts into initiating from a resting step regardless. Rejection on a fresh error is now checked before the return-to-`Idle` cancellation, so a wallet-only failure that rests on `Idle` still rejects with the real cause (and `code === 4001` for a user rejection) rather than a generic `Connection cancelled`.

  Downstream cleanup: the `MechanismToChoose`/`WalletToChoose` -> `connection.back('Idle')` workaround in `mandalas` (`web/src/lib/ui/purchaseFlow.ts`) can be deleted once this is released, and `_ensureConnected` reduced to `ensureConnected` plus a catch.

## 0.1.0

### Minor Changes

- ccb8bdc: Add the Same-Origin Callback Bridge (domain-redirect fallback) for the OAuth-redirection flow.

  When a popup-based OAuth login severs the `window.opener` relationship (due to COOP headers or cross-scheme redirects), the popup can no longer reach the parent via `postMessage` or a same-origin `BroadcastChannel`. This adds a robust, 100% client-side fallback: the popup redirects one final time to a static bridge page (`_etherplay_accounts.html`) served on the parent's own origin, which delivers the result via `window.opener.postMessage` (often re-established once same-origin) or `BroadcastChannel`.

  - `@etherplay/connect-core`: new zero-dependency Web Crypto helpers (ECDH P-256 + AES-GCM) used to encrypt the credential exchange that transits the URL hash fragment.
  - `@etherplay/connect`: new opt-in `domainRedirectBridge` config flag on `createConnection`. When enabled, the SDK generates an ephemeral ECDH keypair, threads its public key through the redirect chain, and decrypts the result on either transport (window `message` or `BroadcastChannel`). Delivery is opportunistic: the direct opener path is used when the link survives, the encrypted bridge only as a fallback.
  - `@etherplay/openfort`: the `domain-redirect-public-key` param is now carried through the Openfort `redirectTo` URL so it survives the full-page OAuth round-trip.

  Integrators opting in must host `_etherplay_accounts.html` at `/_etherplay_accounts.html` on their app's origin. When the bridge is disabled (the default), behavior is unchanged.

### Patch Changes

- d54e1d6: Fix `ensureConnected` never settling when a connection attempt fails.

  When the user rejected the wallet prompt (EIP-1193 code 4001), the store went `Idle -> WaitingForWalletConnection -> MechanismToChoose` with an `error` set. `ensureConnected` only rejected when the store returned to `Idle`, so the returned promise neither resolved nor rejected and every `await` on it hung forever, leaving downstream UI wedged with no error to react to.

  `ensureConnected` now rejects with a `ConnectionFailure` when an attempt ends without reaching the target step:

  - a fresh `error` appearing in the store (one that was not already there when `ensureConnected` was called) rejects with that error's `message`, and propagates the underlying wallet error as both `cause` and a convenience `code`, so callers can tell a user rejection (`code === 4001`) from a genuine failure,
  - an attempt that falls back to a resting step (`Idle`, `MechanismToChoose`, `WalletToChoose`) after having started rejects with `Connection cancelled`.

  Being at a resting step is never a failure by itself: `ensureConnected` is routinely called while the picker is showing (including with a stale error banner from a previous attempt), and those calls still wait for the user's choice and resolve normally.

  New export: `ConnectionFailure` (an `Error` subclass with `cause` and `code`).

  Downstream cleanup: the `_ensureConnected` workaround in `mandalas` (`web/src/lib/ui/purchaseFlow.ts`), which races `ensureConnected` against the store returning to a resting step, can be deleted once this is released; its call sites can simply catch the rejection. `template-onchain-app` awaits `ensureConnected` too and was exposed to the same hang.

- Updated dependencies [ccb8bdc]
  - @etherplay/connect-core@0.1.0

## 0.0.50

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.11

## 0.0.49

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.10

## 0.0.48

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.9

## 0.0.47

### Patch Changes

- allow provide nodeURL different from chainInfo (for wallets)

## 0.0.46

### Patch Changes

- 46e8b4e: fixes

## 0.0.45

### Patch Changes

- useCurrentAccount

## 0.0.44

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.8

## 0.0.43

### Patch Changes

- Updated dependencies [1b727a2]
  - @etherplay/wallet-connector-ethereum@0.0.7

## 0.0.42

### Patch Changes

- 331f862: implement tx/signature wallet request
- Updated dependencies [331f862]
  - @etherplay/wallet-connector-ethereum@0.0.6
  - @etherplay/wallet-connector@0.0.5

## 0.0.41

### Patch Changes

- 9e89c58: connect-core and remove alchemy dependencies of @etherplay/connect

## 0.0.40

### Patch Changes

- bumo

## 0.0.39

### Patch Changes

- 5dcb07c: unified account WalletConnected + SignedIn

## 0.0.38

### Patch Changes

- AnyConnectionStore

## 0.0.37

### Patch Changes

- walletOnly auto chose wallet type on connect

## 0.0.36

### Patch Changes

- better support for wallet-only connections

## 0.0.35

### Patch Changes

- allow to pass a provider instead of an http endpoint
- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.5
  - @etherplay/wallet-connector@0.0.4
  - @etherplay/alchemy@0.0.15

## 0.0.34

### Patch Changes

- support different origin
- Updated dependencies
  - @etherplay/alchemy@0.0.14

## 0.0.33

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.4

## 0.0.32

### Patch Changes

- fix ChainInfo, make it readonly

## 0.0.31

### Patch Changes

- use viem chainInfo

## 0.0.30

### Patch Changes

- export UnderlyingEthereumProvider

## 0.0.29

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.3
  - @etherplay/wallet-connector@0.0.3
  - @etherplay/alchemy@0.0.13

## 0.0.28

### Patch Changes

- support multiple blockchain wallet
- Updated dependencies
  - @etherplay/alchemy@0.0.12
  - @etherplay/wallet-connector@0.0.2
  - @etherplay/wallet-connector-ethereum@0.0.2

## 0.0.27

### Patch Changes

- debug pass through
- Updated dependencies
  - @etherplay/alchemy@0.0.11

## 0.0.26

### Patch Changes

- watch for lock + unlock

## 0.0.25

### Patch Changes

- alwaysUseCurrentAccount auto switch account

## 0.0.24

### Patch Changes

- keep updating accounts list

## 0.0.23

### Patch Changes

- cancel remove last wallet

## 0.0.22

### Patch Changes

- try catch some connection error

## 0.0.21

### Patch Changes

- handle timeout + signature rerequest

## 0.0.20

### Patch Changes

- update deps
- Updated dependencies
  - @etherplay/alchemy@0.0.10

## 0.0.19

### Patch Changes

- ensureConnect WalletConnected option type

## 0.0.18

### Patch Changes

- ensureConnected

## 0.0.17

### Patch Changes

- fix settings

## 0.0.16

### Patch Changes

- 40a0c5c: accounts list choice

## 0.0.15

### Patch Changes

- locked/disconnected

## 0.0.14

### Patch Changes

- save last wallet + disconnected support for metamask

## 0.0.13

### Patch Changes

- show invalid chain as long as we get wallet connected

## 0.0.12

### Patch Changes

- Updated dependencies
  - @etherplay/alchemy@0.0.9

## 0.0.11

### Patch Changes

- requestSignatureAutomaticallyIfPossible + unlock + better handling of web3 wallet + fixes

## 0.0.10

### Patch Changes

- provide a always on provider + allow switching chain on wallet provider
- Updated dependencies
  - @etherplay/alchemy@0.0.8

## 0.0.9

### Patch Changes

- add wallet provider + chainId
- Updated dependencies
  - @etherplay/alchemy@0.0.7
