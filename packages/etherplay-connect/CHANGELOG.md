# @etherplay/connect

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
