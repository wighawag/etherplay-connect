# @etherplay/openfort

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
