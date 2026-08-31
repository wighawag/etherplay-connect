# @etherplay/connect

## 0.10.0

### Minor Changes

- 6acb51a: Announce the two wallet signatures that opened a popup nobody could see.

  `getDelegation` and `getSignatureForPublicKeyPublication` signed through `_wallet.provider`, one level above `alwaysOnProviderWrapper`. The wrapper is what tracks in-flight wallet requests, so `onRequest` never fired for them and `wallet.pendingRequests` stayed empty for their whole duration. Both now go through the wrapper, which makes the consumer logic that already reads `pendingRequests` correct rather than adding a second mechanism beside it. **Consumers get this on the version bump with no code change.**

  The symptom was worst on the request that deserved it least. In reveal-or-die, pressing "Buy an avatar" opened MetaMask asking for a signature with no dialog, no explanation, and no way to tell what had asked, because jolly-roger decides whether to show its "Wallet Action Required" modal from `wallet.pendingRequests`. For a signature that grants a browser key authority to act for the user's account, an unexplained popup is exactly the shape a phishing prompt takes, and a careful user is right to refuse it.

  The gap was incidental rather than designed. `plans/rpc-request-tracking.md` decided not to track the `signMessage` path because it "already has its own `WaitingForSignature` step", which was true of `_requestSignature`, its only caller at the time. Two functions written later inherited that exemption without inheriting the step, so they were covered by nothing at all. The rule is now written down in `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: every request that reaches the user's wallet goes through the wrapper, so that it is observable, because a request the user must answer and the app cannot see is one nothing can explain, cancel, or recover from.

  **New: `AlwaysOnProviderWrapper.signMessage(message, account, {purpose})`.** A dedicated surface rather than a call through the generic `provider.request` path, for two reasons that are invisible from the call site. The generic path refuses signing methods when the wallet is on a chain other than the connection's, but `getDelegation` is explicitly allowed to mint a credential for another chain (`{chainId: 31337}` on a chain-1 connection is supported and tested), so it would have rejected correct requests. And `@etherplay/connect` is chain-agnostic over `WalletProviderType`, so it cannot build a `personal_sign` call itself. Delivery is byte-for-byte what `EthereumWalletProvider.signMessage` did: routing a signature through it changes who can see it and nothing else.

  **New: `PendingRequest.purpose`**, `'delegation' | 'public-key-publication'`, optional. `kind: 'signature'` only supports "your wallet is asking for something", and the reported problem was a user who could not tell what had asked. Absent means the app asked directly through `connection.provider`, where it already knows what it sent. `PendingRequest`, `RequestEvent`, `RequestEventHandler` and `RequestPurpose` are now re-exported from `@etherplay/connect`, so a consumer naming the request does not need a second dependency.

  Sign-in is deliberately unchanged and remains the one exception: `requestSignature` keeps signing through `_wallet.provider` and keeps `step: 'WaitingForSignature'` as its signal. Announcing it here as well would open two modals at once in consumers that render a dialog from that step and another from `pendingRequests`, which jolly-roger does. The ADR records that if `WaitingForSignature` is ever removed, sign-in moves onto the wrapper in the same change, and a test pins it meanwhile.

  Implementers of `AlwaysOnProviderWrapper` outside this repo must add `signMessage`. The bundled Ethereum connector and the test doubles in this repo are updated.

- a9f3ff2: Stop erasing a wallet request that is still outstanding, and say who must answer it.

  Every wallet-state rebuild in `createConnection` asserted `pendingRequests: []`. That erased an outstanding request **permanently**, because the store's mirror of the list is only written on request events and the next event for that request is the one that ends it, which writes an empty list too. Nothing ever put it back, so the user was left holding a wallet popup the app believed did not exist. All nine sites now read `alwaysOnProviderWrapper.getPendingRequests()`, which is authoritative.

  The triggering flow is an ordinary one rather than an exotic one: **a send against a locked wallet raises the connection flow**, so `connect()` runs while the wallet is still holding the transaction and rebuilds the state underneath it. Confirmed from a real locked-Rabby session, where the app reported `step: WalletConnected`, `wallet.status: connected`, `pendingRequests: 0` and its own dispatch count at `1` with a transaction genuinely in flight, and now reproduced in `test/announced-requests.test.ts`.

  The wallet event handlers were never at fault: `onChainChanged` and `onAccountChanged` spread the existing wallet state and preserve the list. Only the paths that build a wallet object from scratch (`connect`, `restoreWalletChosenAfterFailedConnect`, `selectWallet`) dropped it.

  Downstream this cost more than a missing modal. jolly-roger built a parallel `$inFlight.dispatching` ledger that its wallet-action modal, its escape hatch and its unload guard all consult, because all three went silent when the list was emptied. That ledger still earns its place (it also covers sends signed by a local signer, which no wallet is asked about), but the reason it had to outrank `pendingRequests` is now gone.

  **New: `PendingRequest.account`**, the address expected to answer: the signer of a signature, the `from` of a transaction. Now that the list survives a rebuild, a request can outlive the wallet state it started under, and the user is free to switch wallet or account while one is outstanding. "Something is pending" therefore has to be answerable with "pending for whom", or a consumer will tell the user to approve in whichever wallet is current, which after a switch cannot answer it. Read per method rather than positionally, because `personal_sign` takes `[data, address]` and `eth_sign` takes `[address, data]`, the reverse; each branch is shape-checked, so an unreadable request loses the address and keeps the announcement rather than reporting a confident wrong answer.

  Known limit, recorded in ADR-0001: the list is not per-wallet, so a request outstanding against a wallet the user has switched away from is still reported, under the new wallet's state. `account` makes that detectable. The wrapper does not mark or drop such a request, and if it ever does it should mark rather than drop, since dropping would resurrect the erasure bug in a narrower form.

### Patch Changes

- Updated dependencies [6acb51a]
- Updated dependencies [a9f3ff2]
  - @etherplay/wallet-connector@0.1.0
  - @etherplay/wallet-connector-ethereum@0.1.0
  - @etherplay/connect-core@0.7.2

## 0.9.1

### Patch Changes

- @etherplay/connect-core@0.7.1

## 0.9.0

### Minor Changes

- 66402f0: Drop the `svelte` peer dependency in favour of `sveltore`.

  Both packages used Svelte only for `svelte/store`, which forced every consumer into a `svelte` peer-dependency negotiation for a library they may not otherwise use. They now depend on [`sveltore`](https://www.npmjs.com/package/sveltore), a standalone dependency-free port of Svelte's store implementation.

  Nothing changes for Svelte consumers: the returned stores still satisfy the [Svelte store contract](https://svelte.dev/docs/svelte/stores#Store-contract), so `$store` auto-subscription and `svelte/store`'s own `get` / `derived` / `fromStore` keep working on them unchanged. This is verified by the demo app and the web app, which both still type-check against the real Svelte with zero errors.

  A Svelte app that would rather have a single store implementation in its bundle can alias the package away in one line, which is safe because sveltore's API is a strict subset of `svelte/store` with identical signatures:

  ```js
  // vite.config.js
  export default {
  	resolve: {
  		alias: {sveltore: 'svelte/store'},
  	},
  };
  ```

  `@etherplay/openfort` also moves from `sveltore@^0.0.2` to `^1.0.0`. It already used sveltore, but on a range that could not deduplicate with the one `@etherplay/connect` now uses, so a consumer installing both would have resolved two separate copies.

## 0.8.0

### Minor Changes

- 3951c0c: Add `targetStep: 'WalletChosen'` — let the user pick a wallet via EIP-6963 and read through its provider without going through the connect/accounts flow.

  ## What this adds

  A new `TargetStep: 'WalletChosen'` and a new `selectWallet(name?: string)` method on the connection store. When the user picks a wallet, the wallet's provider is set on the always-on wrapper so reads route through it (when `prioritizeWalletProvider` is true), but **no accounts are requested** and **signing is refused** (status: `'disconnected'`). The wallet is in the `WalletChosen` step — chosen but unconnected.

  The motivating consumer is a blockchain indexer that only calls `eth_chainId`, `eth_blockNumber` and `eth_getLogs`: it wants the user's own wallet as its node (a genuinely decentralised read path) but has no need for accounts or signing, so requiring `eth_requestAccounts` is friction that buys nothing.

  ## How a consumer opts in

  ```typescript
  import {createConnection} from '@etherplay/connect';

  const connection = createConnection({
  	targetStep: 'WalletChosen',
  	chainInfo,
  	prioritizeWalletProvider: true, // route reads through the wallet
  	autoConnect: true, // restore the last choice on reload
  });

  // Let the user pick a wallet (or auto-select if only one is installed):
  await connection.selectWallet();

  // Reads now route through the wallet's provider:
  const blockNumber = await connection.provider.request({method: 'eth_blockNumber'});

  // Signing is refused with code 4001:
  // await connection.provider.request({method: 'personal_sign', ...}); // → rejected

  // Later, if the user wants to sign (upgrade to WalletConnected):
  await connection.connect({type: 'wallet'});
  ```

  ## Design decisions

  **New `TargetStep` rather than just setting the provider at selection time.** The state machine needs a new resting point (`WalletChosen`) between `WalletToChoose` and `WalletConnected`. None of the existing steps fit: `WalletConnected` requires `account: {address}`, which we don't have. The new step gives the consumer a clean `isTargetStepReached` and auto-connect that restores the choice without requesting accounts.

  **`prioritizeWalletProvider` controls read routing, unchanged.** When `true`, all reads route through the wallet (the decentralised read path). When `false`, reads fall through to the configured endpoint and the wallet is only used for signing (rejected when not connected). The concern about bulk `eth_getLogs` backfill through a relay (Coinbase Wallet relays over wss) is a consumer-level performance decision: a consumer who wants identity reads through the wallet but bulk reads through the configured endpoint can use the wallet's provider directly for identity reads and the always-on provider for bulk reads. Introducing a third routing mode would be a side effect, not a deliberate design.

  **Disconnecting must not silently deselect.** If the user upgrades from `WalletChosen` to `WalletConnected` (by calling `connect()`) and the connection fails (e.g., the user rejects the accounts prompt), the `WalletChosen` state is restored — the wallet provider stays set and reads keep routing through it. The choice is not thrown away. `disconnect()` still fully clears the wallet (including the persisted choice) and transitions to `Idle`; that is the explicit "I don't want any wallet" action.

  **Signing is still refused when not connected.** The existing rejection with code 4001 for signing methods on an unconnected wallet is unchanged.

  ## Real-wallet verification

  MetaMask, Rabby and Coinbase Wallet all allow `eth_chainId` and `eth_getLogs` from an unconnected EIP-6963 provider without prompting. Only account-revealing methods (`eth_accounts`, `eth_requestAccounts`) and signing methods require authorization. The feature is viable for all three wallets.

  ## Picker guidance

  With several wallets installed, `selectWallet()` (or `ensureConnected()`) lands on `WalletToChoose`. On a WalletChosen-target store, wire that picker's handler to `connection.selectWallet(name)`, not `connection.connect({type: 'wallet', name})` — `connect` is the deliberate **upgrade** path and pops `eth_requestAccounts`, the friction this feature exists to remove. (An upgrade still satisfies the target; it is just not what a read-path user clicked for.)

  ## Review fixes folded in

  - **Failed upgrade keeps routing.** The WalletChosen-restore path in `connect()` now re-registers the wallet on the provider wrapper and the chain watcher, and restores the wallet that was CHOSEN — even when the failed upgrade targeted a different one. An early failure (`eth_chainId` throwing mid-upgrade) used to restore a `WalletChosen` state that had silently stopped routing reads through the wallet and stopped tracking its chain, and a late failure on a DIFFERENT wallet used to leave that wallet as the read path: a refused accounts prompt on wallet B must not silently move the read path the user had chosen on wallet A.
  - **Empty accounts answer restores too.** A wallet answering `eth_requestAccounts` with `[]` restores `WalletChosen` — exactly like a rejected prompt — instead of dropping the choice.
  - **No wallet routing outside wallet-bearing states.** `cancel()`, `back()`, failure rests and auto-connect failures now tear the live wallet down (provider unregistered, signing refused, watchers stopped). Before, an `Idle`/picker state could keep reads — and, with a previously connected wallet, even signing — routed through a wallet the state no longer showed.
  - **`ensureConnected` typing.** The WalletChosen store overloads now expose `ensureConnected('WalletChosen', mechanism?, options?)` and declare the honest `Promise<ChosenOrBetter>` resolution (a wallet already connected or signed in satisfies the lower target).
  - **Persistence consent.** `selectWallet(name, {doNotStoreLocally: true})` keeps the choice out of storage, matching `connect()`; an unknown wallet name reports the error on the current state without throwing an existing choice away.

## 0.7.1

### Patch Changes

- 83b841a: Mnemonic sign-in becomes a provider of its own, and leaves the Openfort one.

  **BREAKING for `@etherplay/openfort`, and it breaks at RUNTIME rather than at type-check.** The
  `AuthProvider` shape is unchanged, so a third party calling `connect({type: 'mnemonic', ...})` on
  this provider still compiles and now throws, with a message naming `createLocalProvider` as the
  replacement and the routing decision that goes with it. `minor` is the right bump because the
  version is `0.x`, where `^0.3.1` does not admit `0.4.0`: nobody receives this by upgrading in
  place. The host in this repo moves in lockstep.

  `createLocalProvider` (in `@etherplay/connect-core`) derives an account from a mnemonic in the
  browser: no publishable key, no vendor SDK, no network. It is a MOVE, not a copy:
  `@etherplay/openfort` no longer implements the mnemonic mechanism and throws a message naming where
  it went, so a vendor SDK is no longer constructed on a path that never called it.

  Two provider-agnostic rules move into `connect-core` with it, where they are one implementation
  under test rather than one per host or per provider:

  - `originApprovalRequired`, the gate deciding what must be settled before a result may be handed to
    the opener. Both providers call it directly.
  - `describeOriginMismatch`, which compares the origin a result will be DELIVERED to against the
    origin the opener is really at, and describes the difference. That mismatch is the one failure in
    this system with no error anywhere: the sign-in completes in the popup and the browser silently
    drops the result.

  The host picks the provider by MECHANISM. `?provider=` therefore narrows in meaning to "which
  HOSTED provider for email and OAuth"; `@etherplay/connect` still forwards it from
  `VITE_AUTH_PROVIDER` on every popup URL, unchanged, and it is never required for a mnemonic
  sign-in.

- Updated dependencies [83b841a]
  - @etherplay/connect-core@0.7.0

## 0.7.0

### Minor Changes

- c069f70: Stop persisting the origin account's entropy key, and strip it from storage that already has it.

  `OriginAccount.signer.mnemonicKey` held `originKey`, which is not one derived key: it is the entropy the entire origin account is derived from. The session signer is index 0 of the mnemonic built from it, and every other key that origin could ever derive is index 1, 2, 3 and onward. The whole account object is written to both `localStorage` and `sessionStorage` at the app's origin, so anything that got at an app's storage (an XSS, a hostile extension, a malicious front-end build) walked away with the seed rather than with the single key the session was actually using.

  The field is REMOVED, not deprecated. A deprecated field is one that keeps being written, and being written to disk is the entire problem: a `@deprecated` tag would have left every future sign-in producing the same seed at rest while telling readers not to mind. Nothing read it, in this repo or in the apps built on it, so there is nothing to migrate to. `originKey` is still computed at both derivation sites, since the mnemonic and the account come from it; it is now local to those functions and never leaves them.

  Removing the writes does nothing for the users who already have a seed on disk, which is the half that carries the security, and it does nothing about the other direction an account arrives from: the wallet host popup, which is deployed independently of the version an app ships and can still be running an older `deriveOriginAccount`. An app on this version talking to a host that has not been redeployed would otherwise receive an account still carrying the entropy key and write it straight into both storages, planting a fresh seed at rest from the release that removed it.

  So the cleanup is in three places. Every connection strips both storages in place at construction, which is what reaches apps that pass `autoConnect: false` and therefore never read their stored account at all. `saveOriginAccount` strips whatever it is handed, so nothing carrying entropy is ever persisted whoever produced it: an invariant about the storage rather than a statement about today's call sites. And the popup result is stripped as it arrives, so the account handed to the APP is clean too, whether or not it is remembered.

  The storage cleanup needs no version flag, since the field's presence is the trigger, and it is idempotent: a clean account is left byte-identical with no write at all. Each storage is cleaned WHERE IT LIES rather than by reading one and re-saving both. The two do not expire together (Safari's ITP evicts `localStorage` after seven days of no interaction while an open tab keeps its `sessionStorage`), so a cleanup that wrote both from one of them would resurrect an account into a storage it had already left. It stays behind the same `typeof window` guard as the rest, so SSR and prerender construction remains storage-inert.

  This also matters ahead of any key-rotation or kill-switch work. Rotation is defeated in advance if the seed it is meant to rotate away from is sitting in the same storage the attacker just read, because the rotated keys derive from it too.

  BREAKING for any consumer reading `account.signer.mnemonicKey`: the field is gone from the type and from the object at runtime, including for sessions restored from storage written by an older version. A consumer that needs to sign for the origin should use `signer.privateKey`, which is what signing has always used. Nothing that needed the entropy itself exists; if something did, it would have been holding the ability to derive keys the session was never granted.

### Patch Changes

- Updated dependencies [c069f70]
  - @etherplay/connect-core@0.6.0

## 0.6.0

### Minor Changes

- f1b1f0f: Refuse cross-origin account requests by default, and let a signing origin opt in.

  A page passing `signingOrigin` asks for the account of an origin that is not itself, which is the whole of that account's authority there. That was answered by one prompt naming two domains, and a prompt is the wrong instrument: nothing on that screen tells the person whether the two sites belong together, so the click carries no information. The wallet host now decides it, and the decision defaults to no.

  The reason default-deny is affordable now is delegation, which authorizes MANY delegates at a contract. A third-party site can bring its own origin signer and have the user register it onchain, which costs a transaction and in exchange gives that site authority that is bounded to the contract, separately revocable, and not a copy of somebody else's signer. Refusing is therefore no longer refusing the use case.

  A signing origin that wants to be requested says so in the host's `CROSS_ORIGIN_ALLOWLIST`, either by naming requesters or with `'*'`. Consent makes the request ASKABLE, not granted: the human is still asked, and under `'*'` (or the loopback allowance below) they are asked twice, because nobody vouched for the site in particular. A blocked request never derives, signs or delivers anything.

  Blocking is reported as `{type: 'cross-origin-blocked', windowOrigin, signingOrigin}` rather than as a cancellation, and the popup's refusals now reach the app instead of being swallowed on the way back to `Idle`. An app cannot offer the right remedy without that distinction: closing a popup is retried, a block is a misconfigured `signingOrigin` or a prompt to register a delegate onchain. Closing the popup stays silent, as before, and where a failed attempt comes to rest is unchanged; only the reason travels with it, so `ensureConnected` rejects with what happened instead of "Connection cancelled".

  `OriginApprovalRequest.requestingAccess` is gone. It was the same two origins compared a second time, by a second rule, for a question `resolveAccess` is the only one allowed to answer.

  Auto-signing follows the same rule. A pair may be minted with nobody in the loop cross-origin only when BOTH origins list it and the consent named the requester, since once access is granted the requester holds exactly the signer the signing origin holds, so the credential is one that origin's own flow would have minted. Under a wildcard the host knows nothing about who is asking, so nothing is auto-signed.

  Local development pages (`http://localhost:*`, `127.0.0.1`, `[::1]`) can be admitted as requesters, but only by a development build of the host, or explicitly via `VITE_ALLOW_LOOPBACK_CROSS_ORIGIN`. A remote site cannot claim a loopback origin, so what the allowance admits is untrusted code the user runs locally, asking for their real account behind a prompt that reads harmless. The match parses the origin rather than looking for a substring, because `https://localhost.evil.example` is a domain anyone can register.

  PUBLISH BEFORE DEPLOYING THE HOST. An app on an older `@etherplay/connect` talking to an updated host is told it was blocked and drops the reason on the way back to `Idle`, so the user sees "Connection cancelled" and is invited to retry something that cannot succeed. Ship the packages first, or accept that older clients read a block as a cancellation.

  BREAKING for apps that pass a `signingOrigin` differing from their own origin: they now need an entry at the wallet host, or should drop the option and sign for themselves. This is a rule about what the HOST hands over, so it covers hosted accounts. In the wallet-only shape the page asks the user's own wallet to sign the origin message with no host in the loop, and the wallet's own dialog remains the only gate.

### Patch Changes

- Updated dependencies [f1b1f0f]
- Updated dependencies [a9bab21]
  - @etherplay/connect-core@0.5.0

## 0.5.0

### Minor Changes

- d03ae39: Answer a permission declaration on the wallet path, and add `getDelegation` for signing one on demand.

  `permissions` is honoured by the host at sign-in, because a hosted account holds its key there and sign-in is the only moment a credential can be minted for it. A wallet-owned connection has no such constraint and no host to reach, so a declaration on one was a no-op: the app got `savedDelegations: []` and no outcomes, which reads as "nobody asked" when it did ask. That is exactly the ambiguity the per-entry outcomes exist to remove, and it is now closed from both ends.

  The types refuse a declaration where nothing could honour it: `permissions` is gone from the `walletOnly: true` overloads, and was never on `targetStep: 'WalletConnected'`. A compile error beats a promise nothing keeps. Pinned in `test/types/permissions.types.ts`.

  The types cannot cover the mixed case, where the app can reach a host but the user picks the injected wallet, so that case answers at runtime instead of ignoring: every declared entry comes back as `{granted: false, reason: 'sign-on-demand'}`, a new outcome reason meaning nothing was pre-generated because this owner is a live signer that can be asked at the moment of use. It is not a refusal, and it is distinguishable from `denied` and from never having asked, so the app calls `getDelegation` rather than offering a pointless re-prompt.

  `getDelegation({chainId, contract, deadline?})` is the one call for both shapes: a stored credential for a hosted account, a live wallet signature for a wallet one. It mirrors `getSignatureForPublicKeyPublication`, which already branches the same way over the sibling message. It returns the whole `SavedDelegation` record rather than the signature alone, because a signature is unusable without the exact `delegate` and `deadline` it was made over, both of which are inside the signed bytes; that also makes it interchangeable with `findSavedDelegation`. On a hosted account a stored credential only answers a request naming the same deadline it was signed with, and a missing one throws, since the remedy there is to sign in again rather than anything the app can do from the page.

  Consent at the point of use is worth more than consent at the door, so for a live wallet this is the better shape outright, not a fallback.

### Patch Changes

- Updated dependencies [d03ae39]
  - @etherplay/connect-core@0.4.0

## 0.4.0

### Minor Changes

- f3acc8c: Ask for onchain authority at connect time, per (chainId, contract), and answer every request.

  `originDelegationMessage` is gone from `connect-core`. The message is consensus between three implementations, so it now lives in `@etherplay/delegation` next to the Solidity that verifies it and the vectors pinning the two together; `delegationMessage`, `delegationDigest` and `DELEGATION_ABI` are re-exported from both packages so an app has one import.

  **The signed bytes changed with it**, which is the point rather than a side effect. The old message named no chain and no contract, so the signature pre-generated at sign-in was a standing credential usable at any contract adopting the library, on any chain, by anyone the app handed it to. The new one names both, plus a deadline, and the contract reads the first two from `address(this)` and `block.chainid` so neither can be supplied by a caller. Any signature made by an earlier version is worthless against the new contract, and cannot be migrated: it is bound to bytes that no longer mean anything. Discard stored ones and sign in again.

  `savedDelegationSignature` (one field, one credential, unbounded) becomes `savedDelegations` (a list, one entry per contract, each carrying `chainId`, `contract`, `delegate`, `deadline` and `signature`). A list because authority is per contract: there is no such thing as "the" delegation. Every field on a record is also inside the signature, so the record is a cache of the bytes rather than metadata beside them, which is why a signature failure must invalidate the record and request a fresh one instead of being reported as a contract error.

  Apps declare what they want:

  ```ts
  createConnection({
  	permissions: [{type: 'delegation', chainId: 31337, contract: '0xe7f1...0512', required: false}],
  	// ...
  });
  ```

  `requireOriginApproval` grows from one boolean gate into that list of typed requests, and the account comes back with a `permissions` outcome for each: `{granted: true, deadline}` or `{granted: false, reason: 'denied' | 'unsupported'}`. **A denial is reported, not merely reflected in an absent credential**, because an app cannot otherwise tell "you declined" from "nobody asked", and those call for different remedies. A denied `required` entry fails sign-in and says which one; a denied optional one lets sign-in proceed with that credential missing.

  A permission type the host does not understand is denied and shown as "something this wallet does not understand", never dropped. Silently dropping one is how an old host and a new app end up disagreeing about what was granted, with the app believing it holds something nobody has.

  Enforcement is unchanged in shape and extended per entry: the host **withholds the result** rather than asking the app to behave. An entry that was not granted produces no signature at all, and the whole result is withheld until every entry has an answer. Consent moving to connect time is the weakest moment there is, and it is accepted for one reason: a clicked-through consent to a bounded grant beats no consent at all to an unbounded one. The bound does the work, and it lands in the contract, where it cannot be clicked through.

  The wallet host gains an origin to (chainId, contract) allowlist, hardcoded at build time, whose pairs are signed with no prompt and a real deadline (~3 months). It ships empty. Auto-signing creates no authority: an origin on that list can already derive the account's session key silently, so a delegation bounded to that origin's own contract adds nothing an attacker who compromised it did not already have, minus one click-through. The prompt is kept for the case that carries information, an origin asking for a contract that is not its own. What the list cannot do is revoke, which is why those credentials are dated.

  `@etherplay/openfort` gains the request list and now raises the approval gate on all three sign-in paths. Two of them previously passed `requireOriginApproval: false` outright, so signing in by email or OAuth skipped an approval that signing in by mnemonic required.

  `originKeyMessage` and `originPublicKeyPublicationMessage` are untouched. The session signer is `keccak(sign(originKeyMessage(origin)))`, so changing that string would re-derive every account onto a different signer.

### Patch Changes

- Updated dependencies [f3acc8c]
  - @etherplay/connect-core@0.3.0

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
