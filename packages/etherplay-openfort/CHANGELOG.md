# @etherplay/openfort

## 0.3.0

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

- a9bab21: Carry the declared permissions through the OAuth round trip.

  Signing in with Google is a full page load: the popup navigates away and comes back as a NEW document that remembers nothing, so everything it needs has to be in the callback URL. `permissions` was not, so the returning popup parsed no request at all. It asked for nothing, granted nothing and reported nothing, and the app received an account with no credentials AND no outcomes explaining them, which is precisely the "nobody asked" versus "you declined" ambiguity the per-entry outcomes exist to remove.

  It failed only on OAuth. The same app asking for the same delegation by email worked, which is why this survived: the feature looked implemented, and one mechanism silently dropped it.

  The shape that allowed it is fixed too. The callback URL was assembled by hand-concatenating one string fragment per parameter, so adding a parameter to the popup URL and forgetting it here produced no error anywhere. It is now `buildOAuthCallbackUrl` in `@etherplay/connect-core`, with `CARRIED_THROUGH_OAUTH` naming what survives in one place, and tests covering it. It lives in core rather than in the Openfort provider because what it encodes is the popup URL contract, written by `@etherplay/connect` and read by the host, not anything about Openfort.

  Values are encoded rather than interpolated. Origins, a JSON permissions document and a public key were being concatenated raw, and a value containing `&` or `#` stops being one parameter and becomes several.

- Updated dependencies [f1b1f0f]
- Updated dependencies [a9bab21]
  - @etherplay/connect-core@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [d03ae39]
  - @etherplay/connect-core@0.4.0

## 0.2.0

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

## 0.1.1

### Patch Changes

- Updated dependencies [57e3773]
  - @etherplay/connect-core@0.2.0

## 0.1.0

### Minor Changes

- ccb8bdc: Add the Same-Origin Callback Bridge (domain-redirect fallback) for the OAuth-redirection flow.

  When a popup-based OAuth login severs the `window.opener` relationship (due to COOP headers or cross-scheme redirects), the popup can no longer reach the parent via `postMessage` or a same-origin `BroadcastChannel`. This adds a robust, 100% client-side fallback: the popup redirects one final time to a static bridge page (`_etherplay_accounts.html`) served on the parent's own origin, which delivers the result via `window.opener.postMessage` (often re-established once same-origin) or `BroadcastChannel`.

  - `@etherplay/connect-core`: new zero-dependency Web Crypto helpers (ECDH P-256 + AES-GCM) used to encrypt the credential exchange that transits the URL hash fragment.
  - `@etherplay/connect`: new opt-in `domainRedirectBridge` config flag on `createConnection`. When enabled, the SDK generates an ephemeral ECDH keypair, threads its public key through the redirect chain, and decrypts the result on either transport (window `message` or `BroadcastChannel`). Delivery is opportunistic: the direct opener path is used when the link survives, the encrypted bridge only as a fallback.
  - `@etherplay/openfort`: the `domain-redirect-public-key` param is now carried through the Openfort `redirectTo` URL so it survives the full-page OAuth round-trip.

  Integrators opting in must host `_etherplay_accounts.html` at `/_etherplay_accounts.html` on their app's origin. When the bridge is disabled (the default), behavior is unchanged.

### Patch Changes

- Updated dependencies [ccb8bdc]
  - @etherplay/connect-core@0.1.0
