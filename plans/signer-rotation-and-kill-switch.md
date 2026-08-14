# Signer rotation and the compromised-key kill switch

**Status**: designed, deliberately not started. Nothing needs to be reserved, stubbed or shipped today to keep the door open; see "Why this can wait", which is the whole reason it is parked rather than built.

Scope: `@etherplay/connect` and `@etherplay/connect-core` own everything here (the derivation and the API). The delegation contract does not change at all, and an adopting app is a consumer with nothing to do until this exists.

Follows on from the delegation work: `jolly-roger`'s `docs/plans/delegation-multi-signer.md`, shipped as `@etherplay/delegation` 0.1.0, `@etherplay/connect-core` 0.3.0 and `@etherplay/connect` 0.4.0.

## The problem

One incident with two halves.

A signer that has been compromised keeps working at every contract that authorised it, and the account has no single place to stop it. Authority is per contract by design, so revocation is per contract too.

And the signer cannot be replaced. It is a pure function of (account key, origin): `originKey = keccak(sign(originKeyMessage(origin)))`. Re-deriving after a compromise hands back the same key, so "get a new one" is not an operation the system has.

## The threat this is designed for

**In scope: a phished `originKeyMessage(origin)` signature.** A hostile site asks the user's wallet to sign that message with somebody else's origin in the first line, and the user accepts. On the wallet path the attacker then holds `originKey`, which is not merely one private key: it is the entropy the whole origin account is derived from (`fromEntropyKeyToMnemonic(originKey)`, then index 0). The blast radius is one origin's signer at the contracts that origin registered at. The account itself is untouched.

**Out of scope: a phished `localKeyMessage()` signature.** That one yields the account seed, and therefore every origin key at every origin, every future version of every one of them, and the account's own signing power, including the ability to authorise the attacker's own delegates. Rotation is theatre against it. The remedy is migration to a new account, which is a different and larger piece of work. Worth recording that nothing protects this today except the shouting in the message text ("DO NOT ACCEPT THIS SIGNATURE REQUEST!"), and that shouting is not a control.

## What is decided

### No withdrawal registry

The tempting shape is a shared `DelegationWithdrawalRegistry`: adopting contracts consult it on every action, so one withdrawal kills a signer everywhere at once.

It deserves a fair hearing, because the delegation plan's argument against a shared registry does not touch it. That argument was that a shared registry puts its own address inside every signature, making one credential valid at every game on it. A registry that only ever stores *revocations* grants nothing, so the objection does not apply. This is the one shared-singleton shape that is not obviously wrong.

It is still rejected, on expected value. `canActFor` today is one cold SLOAD, about 2100 gas. Consulting a registry adds a cold account access (2600) and a cold SLOAD inside it (2100), so the identity check goes to roughly 6.9k on every delegated action, of every user, forever, whether or not anyone is ever compromised. On a 60k move that is about 8%. What it buys is that one rare moment costs one transaction instead of N.

N is the number that decides it, and N is bounded and small: the signer is per origin, so the set is "contracts this one origin registered at", which is one in both templates today and plausibly a handful later, on one chain. A permanent tax on every action to make a rare event cheaper is a bad trade at that N.

The one property N transactions cannot deliver is **atomicity under an active attacker**: with N revokes, an attacker watching the chain has the remaining contracts to act at while the user is still signing. At a handful, on one chain, batched through a multicall from the owner's wallet, the race window is small enough not to buy at that price.

### Per-registration expiry is not the cheap alternative it looks like

The status slot (`mapping(owner => mapping(delegate => Status))`, a `uint8` enum in a full word) has 31 bytes free, so `{uint8 status, uint64 expiry}` packs into the same word and `canActFor` stays one SLOAD plus a timestamp compare. A compromised signer would then die everywhere on its own, with no transaction and no registry.

Rejected anyway, because it is not free, it only moves the cost: the user re-registers every expiry period, which is N transactions per period rather than N transactions once, and re-registration friction is exactly what delegation exists to remove. It also bounds exposure rather than ending it, so it does not replace a kill switch, it delays one.

### Enumeration is already solved, so the kill switch is a client feature

"Which contracts accepted this signer" needs no new machinery. `savedDelegations` lists every (chainId, contract) the app declared, and `DelegationChanged(address indexed owner, address indexed delegate, bool allowed)` is indexed on both addresses, so `eth_getLogs` gives the exact set an account ever authorised, per chain, with no indexer.

So: **one button, N transactions**. Cost at rest zero, cost at compromise a progress bar. Worth building when an app declares more than one pair; while N is 1 it is indistinguishable from the revoke button that already exists.

The known wart, inherited from the delegation plan: public and wallet-supplied RPCs cap `eth_getLogs` ranges, so a fresh browser reconstructing the set needs a stored deployment block and paging.

### Rotation is an explicit action, never an inference

The decision that a key is compromised comes from the user, behind a confirmation, and is never inferred from a revoke: people revoke for boring reasons, and a compromise does not always come with one.

Rotation and revocation are then presented as **one incident with two transactions**: rotate to the next version, then retire the old signer.

### A new signed message per version, not an HD index

The cheap-looking option is to derive version n as an HD index off the origin seed, or as `keccak(originKey, n)`. Both are worthless here, and the reason is the threat model: what the attacker phished IS the seed. Hardened derivation protects a leaked child from exposing its siblings; it does nothing when the parent is what leaked.

So each version must come from a fresh signature by the account key over a message the attacker has not been given:

- **Version 0 is today's `originKeyMessage(origin)`, byte for byte.** No existing signer moves, and the delegation plan's "do not change `originKeyMessage`" constraint is respected in full.
- Version n > 0 uses a distinct message, keeping the `Origin:` first line, because that convention is what makes a conforming wallet compare the claimed origin against the true origin of the requesting page, and that comparison is the defence against the exact phishing being rotated for. The version is its own labelled line, in the shape of the delegation message's field block.

The cost of this choice is that versions are not enumerable without a signature each, which for a wallet account is a prompt each. That is what makes the cross-device signal below matter.

### `keyVersion` in the API

- Named `keyVersion`, not `index`: `index` already means `localAccount.index` and the HD position in `fromMnemonicToHDKey(mnemonic, index)`, which stays 0. A third meaning would be actively confusing.
- Default 0.
- Settable on `createConnection` and overridable per `connect` / `ensureConnected`. Both, because the app discovers a rotation *after* signing in, from the chain, while `autoConnect: true` reconnects on load with nobody calling `connect`.
- An integer, not an arbitrary discriminator. Ordering is what lets a client reason about "the next one" and derive older versions for the encryption identity below.

**Exactly one version's key leaves a session, ever.** The obvious optimisation, deriving 0..k in one popup and handing them all back so a fresh device needs one authentication, puts the rotation targets into the storage of an origin we are assuming may be compromised. That defeats the entire mechanism. This rule is the security-carrying part of the API and should be stated wherever the API is documented.

If the second authentication proves painful there is a safe version of that optimisation, and it is worth knowing the door exists: the popup derives *addresses* 0..k, which are public, hands only those back, the app checks the chain, and asks the still-open session for the single key it needs. One authentication, one private key. Not now.

### Rotation rotates the encryption identity too

The origin signer is not only a transaction signer. `originPublicKeyPublicationMessage` publishes its public key with "others can use this key to write encrypted messages to you securely", and `savedPublicKeyPublicationSignature` ships on the account. Two consequences:

- A random per-device key is not an available alternative to versioning: mail encrypted to device A could not be read on device B. Determinism is load-bearing for a reason unrelated to delegation.
- Rotation must re-publish for the new version, and a client must be able to derive *older* versions on demand to read old mail. With an integer version and the account key in hand, it can.

### The cross-device signal is `withdrawn`

A second device must not silently derive and use a key the account has already burned.

`delegationStatus(owner, delegate)` returns `(allowed, withdrawn)` from a single SLOAD, in a call the app already makes to answer "may this browser act". `withdrawn` is set only by an owner-sent `revokeDelegate` for that exact delegate, so it is the account's own statement, onchain, in a transaction only the owner could send, that this signer is dead. A device derives version 0, reads `withdrawn`, and knows to derive version 1 rather than to offer registration.

This is not the inference that was rejected above. The rotation decision is still explicit and taken by a human; the second device is reading a decision that was already made and published.

The signal is present exactly when it matters. Rotation without revocation leaves the old signer authorised, so the attacker can still act and the compromise was not handled; and if the old signer was never registered anywhere there is nothing to revoke, but also nothing another device could do with it, since an unregistered signer cannot act.

**It also closes a hazard that exists today.** `Delegation.register` clears `withdrawn` as a fresh decision, and the current client actively steers the user into doing exactly that: `chooseRegistrationRoute` returns `unavailable` for a withdrawn signer with "Re-authorising has to come from your own account, so pay from it rather than from another wallet", and the payment methods disable the signature route with the same story. A user trying to fix an unrelated-looking complaint un-burns the attacker's key with their own transaction. Today that behaviour is correct, because without rotation the app cannot tell a compromise from a tidy-up and re-authorising is the only remedy there is. It becomes wrong the moment there is something better to offer, and this spec is what offers it.

The client may cache the discovered version locally per (origin, account). Tampering with that cache is harmless: lowering it makes the client derive a signer it then reads as `withdrawn` and rotates away from, so the onchain flag stays the authority and the cache is only ever an optimisation.

## Why this can wait

This is the argument for the status at the top, and it is worth contrasting with the deadline in the delegation plan. The deadline had to ship immediately, because adding it later would have been a second silent invalidation of every signature in existence.

Rotation has no such debt:

- Version 0 is the status quo, so no existing signer moves whenever this lands.
- Every higher version is a *different message*, definable whenever it is needed, interacting with nothing that exists.
- The delegation message does not change. The contract does not change at all.
- `keyVersion` is additive to the API.
- `withdrawn` already ships and is already read.

Nothing has to be reserved, hooked or stubbed today. The correct time to build it is when an app declares more than one (chainId, contract) pair, or when the first real compromise report arrives, whichever comes first.

## Costs accepted

- **A second authentication on a fresh device after a rotation.** Sign in at version 0, read `delegationStatus`, see `withdrawn`, tell the user this browser needs its new key, authenticate again to derive version 1. For a hosted account that is a full flow with an OTP, because the account seed generated in the popup is transient and never stored. That cost is proportionate for a rare, deliberate, security-motivated action, and it is the same category the host's planned "send this specific transaction" capability is reserved for.
- **N transactions for the kill switch**, and the race window that implies.

## Facts established along the way

Worth recording so they are not re-litigated.

- `mnemonicKey` on the origin account is `originKey`, the *entropy* of the origin account rather than one derived key, and it is persisted to `localStorage` by `saveOriginAccount` along with everything else. **Nothing reads it**: not `@etherplay/connect` itself, not `jolly-roger`, not `template-commit-reveal`. Dropping it from the persisted object is close to free and is a strict improvement to the compromise blast radius even if rotation is never built. It is the one thing in this document worth doing on its own merits, today.
- The existing HD path `m/44'/60'/0'/0/{index}` is non-hardened at the last element, so a chain code plus one child private key would expose every sibling. The chain code is not published today, only the account public key, so nothing is broken. Moot under message-per-version, but recorded because "safe as long as nobody ever publishes an extended public key" is a landmine to leave for someone else.
- A hosted account with no wallet cannot send transactions today, so it has no kill switch at all: `revokeDelegate` takes `msg.sender` as the owner and there is no signature variant. The planned host-sent transaction capability closes this, and `revokeDelegate` is the obvious first entry on that whitelist. A `revokeDelegateViaSignature` was considered and dropped on the strength of that plan; if the plan changes, it comes back, and it needs the deadline the register path already has, since replaying a revoke after a legitimate re-registration would kill a fresh signer.
- Live signing at the host is not a small step from live transaction sending. The seed generated in the popup or iframe is transient and never stored, so producing any signature means a full connection flow, an OTP round trip for the email mechanism. That is why credentials are minted at connect time, and why deadlines are measured in weeks or months rather than minutes.
- `delegationStatus` answers both halves from one read. There is no separate `withdrawn` poll to add or to weigh.

## Open, deliberately

- **Account migration**, for the phished `localKeyMessage` case. Out of scope here and unaddressed anywhere. The mitigation is unlikely to be cryptographic: it is that a bare wallet should not be the thing asked to produce an account seed.
- **The exact wording of the version > 0 message.** It is consensus material the moment it ships, in the same way the delegation message is, so it should be frozen with the same care and pinned by vectors read from every implementation.
- **Whether the kill switch batches.** A multicall from the owner's wallet closes most of the race window and is available to wallet accounts today; a hosted account depends on what the host will send.
