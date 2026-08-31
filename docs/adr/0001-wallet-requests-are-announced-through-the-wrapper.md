# Wallet requests are announced through the always-on wrapper

Status: accepted

## The rule

**Every request this library sends to the user's wallet goes through `alwaysOnProviderWrapper`, so that it is observable.** `onRequest` fires, `getPendingRequests()` lists it, and the store publishes it as `wallet.pendingRequests` for the whole time the wallet is holding it.

There is exactly one exception, sign-in, and it is written down below so that it stays the only one.

The rule has a second half, because announcing a request is worthless if the announcement is then thrown away: **the wrapper owns the list, and the store only mirrors it.** Any code building a `wallet` state object copies the current list from `getPendingRequests()`; nothing asserts an empty one. See "the announcement has to survive" below.

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

It also carries `account`, the address expected to answer: the signer of a signature, the `from` of a transaction. That became necessary rather than merely nice once the list survives a wallet-state rebuild (below), because a request can then outlive the wallet state it started under. The user is free to switch wallet or account while one is outstanding, and the request stays with the wallet actually holding it, so "something is pending" has to be answerable with "pending for whom". Without it a consumer would tell the user to approve in whichever wallet is current, which after a switch is one that cannot answer.

Read per method rather than positionally, because no two of these methods agree on where the address goes: `personal_sign` is `[data, address]` and `eth_sign` is `[address, data]`, the reverse. Each branch is shape-checked, so an unreadable request loses the address and keeps the announcement rather than announcing a confident wrong answer.

## The announcement has to survive, not just be made

Announcing a request and then erasing it is the same failure with extra steps, and that is what happened.

Every wallet-state rebuild in `createConnection` asserted `pendingRequests: []`. That is not a harmless guess: it erases an outstanding request permanently, because the store's mirror is only written on request events, and the next event for that request is the one that ENDS it, which writes an empty list too. Nothing ever puts it back. The user is left holding a wallet popup the app believes does not exist.

The flow that triggers it is ordinary, not exotic: **a send against a locked wallet raises the connection flow**, so `connect()` runs while the wallet is holding the transaction and rebuilds the state underneath it. Confirmed from a real session, where the app reported `step: WalletConnected`, `wallet.status: connected`, `pendingRequests: 0` and its own dispatch count at `1` with a transaction genuinely in flight, and reproduced here (`test/announced-requests.test.ts`, "keeps announcing a request that a reconnect happens on top of").

Notably the wallet EVENT handlers were never the problem: `onChainChanged` and `onAccountChanged` spread the existing wallet state and so preserve the list. It was only the paths that construct a wallet object from scratch.

The cost downstream was not just a missing modal. jolly-roger built a parallel ledger (`$inFlight.dispatching`) that the wallet-action modal, the escape hatch AND the unload guard all consult, because all three went silent when the list was emptied, and its `wallet-activity.ts` exists to reconcile the two sources. That ledger is not purely redundant (it also covers sends signed by a local signer, which no wallet is asked about, and it starts a beat earlier), but the reason it had to OUTRANK `pendingRequests` is this bug.

### Known limit

The list is not per-wallet. A request outstanding against a wallet the user has since switched away from is still reported, now under the new wallet's state. `account` makes that detectable by a consumer, which is why it is part of this change, but the wrapper does not itself mark or drop a request when `setWalletProvider` swaps underneath one. Whether it should is a real question and deliberately not answered here: dropping it would resurrect the erasure bug in a narrower form, so if anything is done it should be marking rather than dropping.

## Consequences

- A new function that needs a wallet signature calls `alwaysOnProviderWrapper.signMessage` and gives it a `purpose`. Reaching for `_wallet.provider.signMessage` is the bug this ADR describes.
- `_wallet.provider` remains correct for everything that does not ask the user anything: `watchForChainIdChange`, `watchForAccountChange`, their stop counterparts, identity comparisons, and `setWalletProvider(_wallet.provider.underlyingProvider)`.
- `requestAccounts`, `switchChain` and `addChain` also reach the user and also bypass the wrapper. They are not covered here because each already publishes a dedicated state the consumer renders (`connecting`, `unlocking`, `switchingChain`), which is the same justification sign-in gets. If any of those states is removed, that call moves onto the wrapper.
- Wallet-state rebuilds read `alwaysOnProviderWrapper.getPendingRequests()`. Writing the literal `[]` into a `wallet` object is the erasure bug above.
- The structural weakness behind that remains: the rule is enforced by nine identical call sites rather than by one state-construction helper, so the next rebuild written by hand can still reintroduce it. The test pins the behaviour, not the shape. Extracting a single builder is the durable fix and is recorded in `work/notes/observations`.
