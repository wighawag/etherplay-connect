# `connect`, `ensureConnected` and `unlock` are three different promises

Status: accepted

## The rule

Three public methods can put a wallet back in working order, and they are **deliberately not interchangeable**:

- **`connect(mechanism?)` drives the flow from the USER'S CHOICE.** Bare, with nothing naming a wallet, it opens the picker. From any state, including one that already holds a wallet, and regardless of `wallet.status`.
- **`ensureConnected(step?)` promises a TARGET.** It does whatever reaching that target takes, which is why it, and only it, reconnects a `WalletConnected` wallet that has gone `locked` or `disconnected`.
- **`unlock()` is the narrow remedy.** It prompts a locked wallet and keeps the step, the account, the mechanism and the wallet, where re-running the flow rebuilds all four.

`wallet.status` is on the published state so a consumer can route between them: render "Unlock" rather than "Connect" when it says `locked`, and `connectToAddress(wallet.accountChanged)` when it says `disconnected`.

## Why this is written down

Because the asymmetry was reported as a bug, with good reason, and the next reader will reach the same conclusion unless the reasoning is here.

A consumer's navbar calls `connect()` and its Send path calls `ensureConnected()`. On a locked wallet those two did visibly different things: the Send path reconnected, while the navbar button fell through to the wallet picker, and the picker tears the live wallet down. Same user, same locked wallet, two outcomes, nothing anywhere saying which to use. It looked like one of them was simply wrong.

What made it look like data loss rather than a UX difference was a **separate defect**: the teardown also erased the announcement of whatever that wallet was still holding, so a transaction sitting on the user's screen vanished from the app's view. See `0001-wallet-requests-are-announced-through-the-wrapper.md`. Once `pendingRequests` moved onto the connection and survived a state with no wallet, the picker path was measured again: it still reports the parked transaction and the account it waits on, the request still ends when answered, and picking the wallet again costs one password prompt.

So the difference costs a click, not a transaction. **Fixing the erasure turned "which one is wrong" into "which one do we want", which is a design question rather than a defect.**

## Considered options

**Make `connect()` reconnect a locked wallet too, sharing one helper with `ensureConnected` (rejected, and this was built first).** It removes the surprise, and it is what the bug report asked for. Rejected because it gives one method several meanings that depend on state the caller did not mention: bare `connect()` would mean "pick" from a healthy state and "reconnect" from a locked one, and consumers rely on the first for their switch-wallet button. The version that shipped for review needed a four-row table in the README to describe what a no-argument call does, which is the tell.

It also does not survive contact with `SignedIn`. A locked wallet there does not make the target unsatisfied, because a signed-in app acts through its session account, so `ensureConnected` rightly resolves; making `connect()` reconnect would push a signed-in user down to `WalletConnected`, and making it delegate to `unlock()` gives the same method a third meaning. Each state wanted a different remedy, which is the argument for keeping the remedies as separate methods rather than as branches inside one.

**Refuse rather than re-pick: make a bare `connect()` on an unusable wallet set an error and do nothing (rejected).** It removes the destruction without adding a meaning, but it invents a failure where the user did something reasonable, and leaves them on a state with no next step. The picker IS a next step.

**Document it (chosen).** `connect()` keeps one meaning, `ensureConnected()` keeps its repair, `unlock()` is named in the README as the call to reach for on a locked wallet, and `wallet.status` is what a consumer routes on.

## Consequences

- A bare `connect()` on a locked wallet drops the wallet binding, and from `SignedIn` the session with it. That is the cost of the picker and the reason `unlock()` exists. It does **not** drop the announcement.
- `mechanismToReconnect()` has exactly one caller. That is the rule, not an oversight, and the comment on it says so.
- The three behaviours are pinned side by side in `test/locked-wallet-reconnect.test.ts`, each with a transaction parked in the wallet throughout, so that collapsing any one of them into another fails a test rather than quietly changing the contract.
- If `connect()` is ever given a state-dependent meaning after all, this ADR and those tests are what has to change first, and the `SignedIn` case above is the one that will decide it.

### The replayed address is a preference, not a demand

`ensureConnected()`'s reconnect replays the connected mechanism, address included, because that is what keeps an ordinary unlock from bouncing a multi-account user into `ChooseWalletAccount`. The user is free to unlock on a different account, though, and treating the replayed address as a demand failed the attempt, which landed in the catch and tore the wallet down: the reconnect performed the very teardown it exists to prevent, one step later.

So the two kinds of address are distinguished rather than the address being dropped. An address the CALLER named (`connectToAddress`, `connect({type: 'wallet', address})`) is a demand and still fails when the wallet cannot offer it, because connecting to a different account would answer a question nobody asked. An address this library REPLAYED is a preference, and degrades to an ordinary connect, which is what the caller asked for: it asked to be connected and named no account. The distinction is carried by an internal argument to `connect` that no consumer can see, so the public surface stays two parameters.

**Amended by `0003-ensure-connected-promises-a-target-and-always-answers.md`, for `ensureConnected` only.** A caller's address passed to `ensureConnected` is still a requirement, and is now part of what SATISFIES it (a connection at rest on another account attempts rather than resolving). When the wallet cannot offer it, `ensureConnected` no longer fails the attempt: failing tore the wallet down, which is the same defect this section is about, one caller further out. It connects to what the wallet does offer and rests on `connection.addressUnavailable`, a state the user can answer. The reconnect also no longer replaces a caller's address with the replayed one. `connect` and `connectToAddress` are untouched: they have no promise to settle, so a demand they cannot meet is still an error.

### `SignedIn` does not imply session-account

A clause the paragraph above about `SignedIn` needs, reported by a consumer: "signed in" and "sends through the user's wallet" are not exclusive. `template-commit-reveal` targets `SignedIn` for its identity, runs its game actions through a local signer, and still sends some transactions from the wallet account. The conclusion survives anyway, for a slightly different reason than the one given: the remedy on a locked wallet is `unlock()` whatever the step is, so `ensureConnected` resolving at `SignedIn` costs nothing as long as the consumer routes on `wallet.status`. `canActAs(address)` (ADR-0003) is the supported way to ask that question without initiating a flow.
