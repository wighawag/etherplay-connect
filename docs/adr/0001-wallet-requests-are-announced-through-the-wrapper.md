# Wallet requests are announced through the always-on wrapper

Status: accepted

## The rule

**Every request this library sends to the user's wallet goes through `alwaysOnProviderWrapper`, so that it is observable.** `onRequest` fires, `getPendingRequests()` lists it, and the store publishes it as `wallet.pendingRequests` for the whole time the wallet is holding it.

There is exactly one exception, sign-in, and it is written down below so that it stays the only one.

## Why

A wallet popup carries no provenance. It does not say which app asked, which line of code asked, or what the signature is for. Everything that explains a wallet request to the user lives on our side of the popup, and it can only be rendered if the app knows the request exists.

So a request the user must answer and the app cannot see is a request that nothing can explain, cancel, or recover from. Worse, the failure is silent by construction: the request still works, returns the right bytes, and every test about *what* was signed still passes. The only symptom is an unexplained popup, which is exactly the shape a phishing prompt takes, and a careful user is right to refuse it.

This is not hypothetical. `getDelegation` and `getSignatureForPublicKeyPublication` signed through `_wallet.provider`, one level above the wrapper. In reveal-or-die, pressing "Buy an avatar" opened MetaMask asking for a signature with no dialog behind it and no way to tell what had asked, for a request that grants a browser key authority to act for the user's account. That is the worst request in the library to present unexplained.

The gap was incidental rather than designed. `plans/rpc-request-tracking.md` decided not to track "Path 2", the `WalletProvider.signMessage` path, reasoning that it "already has its own `WaitingForSignature` step". That reasoning was true of `_requestSignature`, the only Path 2 caller at the time. It was then inherited by two functions written later that have no step and no other signal, so they were covered by nothing at all.

That is the failure mode this ADR exists to stop: the exemption was attached to a *mechanism* (`signMessage`) when it was only ever justified for a *caller* (sign-in). Stating the rule at the level of "reaches the user's wallet" removes the room for the next such function to inherit an exemption it was never granted.

## Considered options

**Give the wrapper a `signMessage` surface (chosen).** One funnel, and the existing consumer logic becomes correct rather than gaining a second mechanism beside it. Every consumer reading `pendingRequests` gets the fix on a version bump with no code change.

**Send the request down the wrapper's generic `provider.request` path.** It already tracks `personal_sign`, so this looked like the smaller change, and it is what an outside reader would assume. It is wrong for two reasons, both worth recording because both are invisible from the call site:

1. `executeRequest` refuses signing methods when the wallet is on a chain other than the connection's. A text signature is chain-independent, and `getDelegation` is explicitly allowed to mint a credential for a chain the connection is not on: `getDelegation({chainId: 31337, ...})` on a chain-1 connection is a supported, tested case. Routing it through the generic path would reject requests that are correct.
2. `@etherplay/connect` is deliberately chain-agnostic over `WalletProviderType`. Building a `personal_sign` call means knowing about `personal_sign` and about hex-encoding the message, which is precisely what `WalletProvider.signMessage` abstracts and what a non-Ethereum connector would implement differently.

So announcing and routing are separate jobs, and the wrapper's `signMessage` does the first without the second. Delivery is byte-for-byte what `EthereumWalletProvider.signMessage` did, so routing a signature through it changes **who can see it** and nothing else.

**Emit a second signal beside `pendingRequests`.** Rejected: consumers already read `pendingRequests`, and a parallel channel would need every consumer to learn about it, then need the two kept in agreement forever.

## The two open questions, decided

### `WaitingForSignature` stays, and sign-in stays on it

Sign-in is the single exception to the rule above: `_requestSignature` still signs through `_wallet.provider`, and `step: 'WaitingForSignature'` remains its signal.

Not for purity, but because announcing it as well would break consumers on a version bump, which is the thing this change is supposed to avoid. jolly-roger opens a "please sign" dialog from `step === 'WaitingForSignature'` (`ConnectionFlow.svelte`) *and* a pending-request modal from `hasPendingWalletRequest` (`connection-flow.ts`). Covering sign-in twice would open both at once.

`WaitingForSignature` is also the better signal for sign-in on its own merits: it is a *step*, so it says the connection is blocked and cannot proceed, which a list of in-flight requests cannot express. A pending request is something the user is being asked; a step is where the flow is stuck.

The cost is that the rule has an exception, and exceptions are how this bug happened. The mitigations are that it is written here, that it is pinned by a test (`test/announced-requests.test.ts`, "leaves the sign-in signature to its own step"), and that the exception is attached to one named caller rather than to a mechanism anyone can reach for. **If `WaitingForSignature` is ever removed, sign-in moves onto the wrapper in the same change.**

### A consumer can tell which request is pending

"Your wallet is asking for something" is much weaker than naming what, and `kind: 'signature'` was all a consumer had, so the two signature kinds were indistinguishable from outside. Since the reported symptom was a user unable to tell what had asked, reporting the request without saying what it is would only half fix it.

`PendingRequest` therefore carries an optional `purpose`: `'delegation' | 'public-key-publication'`. It is optional, and **absent means the app asked directly through `connection.provider`**, where the app already knows what it sent and does not need to be told. Only requests this library originates carry a purpose.

Optional rather than required so that adding it is not a breaking change, and so that the union can grow: a consumer that does not recognise a `purpose` falls back to `kind`, which is exactly what it does today.

## Consequences

- A new function that needs a wallet signature calls `alwaysOnProviderWrapper.signMessage` and gives it a `purpose`. Reaching for `_wallet.provider.signMessage` is the bug this ADR describes.
- `_wallet.provider` remains correct for everything that does not ask the user anything: `watchForChainIdChange`, `watchForAccountChange`, their stop counterparts, identity comparisons, and `setWalletProvider(_wallet.provider.underlyingProvider)`.
- `requestAccounts`, `switchChain` and `addChain` also reach the user and also bypass the wrapper. They are not covered here because each already publishes a dedicated state the consumer renders (`connecting`, `unlocking`, `switchingChain`), which is the same justification sign-in gets. If any of those states is removed, that call moves onto the wrapper.
- A known weakness this ADR does not fix: several wallet-state rebuilds in `createConnection` reset `pendingRequests` to `[]` while a request is still outstanding, so the announcement can vanish mid-request. jolly-roger already works around it (`wallet-activity.ts`). The wrapper is the authoritative source, so the fix is for those sites to read `getPendingRequests()` instead of hardcoding `[]`. Recorded in `work/notes/observations/`.
