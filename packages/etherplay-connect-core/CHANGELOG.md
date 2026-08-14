# @etherplay/connect-core

## 0.6.0

### Minor Changes

- c069f70: Stop persisting the origin account's entropy key, and strip it from storage that already has it.

  `OriginAccount.signer.mnemonicKey` held `originKey`, which is not one derived key: it is the entropy the entire origin account is derived from. The session signer is index 0 of the mnemonic built from it, and every other key that origin could ever derive is index 1, 2, 3 and onward. The whole account object is written to both `localStorage` and `sessionStorage` at the app's origin, so anything that got at an app's storage (an XSS, a hostile extension, a malicious front-end build) walked away with the seed rather than with the single key the session was actually using.

  The field is REMOVED, not deprecated. A deprecated field is one that keeps being written, and being written to disk is the entire problem: a `@deprecated` tag would have left every future sign-in producing the same seed at rest while telling readers not to mind. Nothing read it, in this repo or in the apps built on it, so there is nothing to migrate to. `originKey` is still computed at both derivation sites, since the mnemonic and the account come from it; it is now local to those functions and never leaves them.

  Removing the writes does nothing for the users who already have a seed on disk, which is the half that carries the security, and it does nothing about the other direction an account arrives from: the wallet host popup, which is deployed independently of the version an app ships and can still be running an older `deriveOriginAccount`. An app on this version talking to a host that has not been redeployed would otherwise receive an account still carrying the entropy key and write it straight into both storages, planting a fresh seed at rest from the release that removed it.

  So the cleanup is in three places. Every connection strips both storages in place at construction, which is what reaches apps that pass `autoConnect: false` and therefore never read their stored account at all. `saveOriginAccount` strips whatever it is handed, so nothing carrying entropy is ever persisted whoever produced it: an invariant about the storage rather than a statement about today's call sites. And the popup result is stripped as it arrives, so the account handed to the APP is clean too, whether or not it is remembered.

  The storage cleanup needs no version flag, since the field's presence is the trigger, and it is idempotent: a clean account is left byte-identical with no write at all. Each storage is cleaned WHERE IT LIES rather than by reading one and re-saving both. The two do not expire together (Safari's ITP evicts `localStorage` after seven days of no interaction while an open tab keeps its `sessionStorage`), so a cleanup that wrote both from one of them would resurrect an account into a storage it had already left. It stays behind the same `typeof window` guard as the rest, so SSR and prerender construction remains storage-inert.

  This also matters ahead of any key-rotation or kill-switch work. Rotation is defeated in advance if the seed it is meant to rotate away from is sitting in the same storage the attacker just read, because the rotated keys derive from it too.

  BREAKING for any consumer reading `account.signer.mnemonicKey`: the field is gone from the type and from the object at runtime, including for sessions restored from storage written by an older version. A consumer that needs to sign for the origin should use `signer.privateKey`, which is what signing has always used. Nothing that needed the entropy itself exists; if something did, it would have been holding the ability to derive keys the session was never granted.

## 0.5.0

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

- a9bab21: Carry the declared permissions through the OAuth round trip.

  Signing in with Google is a full page load: the popup navigates away and comes back as a NEW document that remembers nothing, so everything it needs has to be in the callback URL. `permissions` was not, so the returning popup parsed no request at all. It asked for nothing, granted nothing and reported nothing, and the app received an account with no credentials AND no outcomes explaining them, which is precisely the "nobody asked" versus "you declined" ambiguity the per-entry outcomes exist to remove.

  It failed only on OAuth. The same app asking for the same delegation by email worked, which is why this survived: the feature looked implemented, and one mechanism silently dropped it.

  The shape that allowed it is fixed too. The callback URL was assembled by hand-concatenating one string fragment per parameter, so adding a parameter to the popup URL and forgetting it here produced no error anywhere. It is now `buildOAuthCallbackUrl` in `@etherplay/connect-core`, with `CARRIED_THROUGH_OAUTH` naming what survives in one place, and tests covering it. It lives in core rather than in the Openfort provider because what it encodes is the popup URL contract, written by `@etherplay/connect` and read by the host, not anything about Openfort.

  Values are encoded rather than interpolated. Origins, a JSON permissions document and a public key were being concatenated raw, and a value containing `&` or `#` stops being one parameter and becomes several.

## 0.4.0

### Minor Changes

- d03ae39: Answer a permission declaration on the wallet path, and add `getDelegation` for signing one on demand.

  `permissions` is honoured by the host at sign-in, because a hosted account holds its key there and sign-in is the only moment a credential can be minted for it. A wallet-owned connection has no such constraint and no host to reach, so a declaration on one was a no-op: the app got `savedDelegations: []` and no outcomes, which reads as "nobody asked" when it did ask. That is exactly the ambiguity the per-entry outcomes exist to remove, and it is now closed from both ends.

  The types refuse a declaration where nothing could honour it: `permissions` is gone from the `walletOnly: true` overloads, and was never on `targetStep: 'WalletConnected'`. A compile error beats a promise nothing keeps. Pinned in `test/types/permissions.types.ts`.

  The types cannot cover the mixed case, where the app can reach a host but the user picks the injected wallet, so that case answers at runtime instead of ignoring: every declared entry comes back as `{granted: false, reason: 'sign-on-demand'}`, a new outcome reason meaning nothing was pre-generated because this owner is a live signer that can be asked at the moment of use. It is not a refusal, and it is distinguishable from `denied` and from never having asked, so the app calls `getDelegation` rather than offering a pointless re-prompt.

  `getDelegation({chainId, contract, deadline?})` is the one call for both shapes: a stored credential for a hosted account, a live wallet signature for a wallet one. It mirrors `getSignatureForPublicKeyPublication`, which already branches the same way over the sibling message. It returns the whole `SavedDelegation` record rather than the signature alone, because a signature is unusable without the exact `delegate` and `deadline` it was made over, both of which are inside the signed bytes; that also makes it interchangeable with `findSavedDelegation`. On a hosted account a stored credential only answers a request naming the same deadline it was signed with, and a missing one throws, since the remedy there is to sign in again rather than anything the app can do from the page.

  Consent at the point of use is worth more than consent at the door, so for a live wallet this is the better shape outright, not a fallback.

## 0.3.0

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

- Updated dependencies [8ed45d3]
  - @etherplay/delegation@0.1.0

## 0.2.0

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

## 0.1.0

### Minor Changes

- ccb8bdc: Add the Same-Origin Callback Bridge (domain-redirect fallback) for the OAuth-redirection flow.

  When a popup-based OAuth login severs the `window.opener` relationship (due to COOP headers or cross-scheme redirects), the popup can no longer reach the parent via `postMessage` or a same-origin `BroadcastChannel`. This adds a robust, 100% client-side fallback: the popup redirects one final time to a static bridge page (`_etherplay_accounts.html`) served on the parent's own origin, which delivers the result via `window.opener.postMessage` (often re-established once same-origin) or `BroadcastChannel`.

  - `@etherplay/connect-core`: new zero-dependency Web Crypto helpers (ECDH P-256 + AES-GCM) used to encrypt the credential exchange that transits the URL hash fragment.
  - `@etherplay/connect`: new opt-in `domainRedirectBridge` config flag on `createConnection`. When enabled, the SDK generates an ephemeral ECDH keypair, threads its public key through the redirect chain, and decrypts the result on either transport (window `message` or `BroadcastChannel`). Delivery is opportunistic: the direct opener path is used when the link survives, the encrypted bridge only as a fallback.
  - `@etherplay/openfort`: the `domain-redirect-public-key` param is now carried through the Openfort `redirectTo` URL so it survives the full-page OAuth round-trip.

  Integrators opting in must host `_etherplay_accounts.html` at `/_etherplay_accounts.html` on their app's origin. When the bridge is disabled (the default), behavior is unchanged.
