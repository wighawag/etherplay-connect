---
'@etherplay/connect': minor
---

Announce wallet requests on the connection rather than on the wallet, so the announcement survives a state that has no wallet at all.

The same class of bug as the erasure fixed in 0.10.0, found from the consumer side, and reached through a `wallet` object that is not rebuilt but REMOVED.

**`connection.pendingRequests` is where the list lives now. `wallet.pendingRequests` is deprecated.**

0.10.0 taught every `wallet: {...}` rebuild to copy the live list from the wrapper. That does nothing for the paths that build no wallet at all, and they are on the same road: `connect` sets `wallet: undefined` on entry, and `setConnectionFailure` tears the wallet down entirely so that a failed attempt cannot keep routing requests (including read-only `eth_call`) through the failed wallet. That reasoning is right for reads and wrong for the announcement: the user's wallet is still holding the prompt, the wrapper still has it, and there was nowhere left to read it from. On the success path the gap is transient. After a FAILED reconnect it is not: the flow rests on a step with `wallet: undefined` while the request sits in the wallet, unannounced, for as long as the user leaves it there — the original bug's symptom by a different route.

A field whose value must be copied at every construction of its container is a field in the wrong container. The list describes what the always-on wrapper is holding, and the wrapper outlives any particular wallet state. It is now stamped in the store's single `set`, so every published state reports what the wallet is actually holding, including states that carry no wallet. That is the single state-construction point ADR-0001 recorded as the durable fix and left open.

The rule is carried by the type rather than by discipline: `set` accepts the published shape _minus_ `pendingRequests`, so a construction site cannot supply the field at all, and the ten copies the previous release added are gone. `set` also preserves the identity of `pendingRequests` and of `wallet` when the list has not changed, so an unrelated publish no longer invalidates `derived` stores, `{#key}` blocks or effect dependencies on request churn.

**Migration**: read `connection.pendingRequests` instead of `connection.wallet.pendingRequests`. Nothing else changes. `PendingRequest` is byte-for-byte the same type: same `kind` union, same optional `purpose`, same `account`. The deprecated mirror is still populated, from the same read in the same statement, so the two cannot disagree; it will be removed in a later major.

Not breaking for a consumer that READS the state. It IS breaking for one that CONSTRUCTS a `Connection` object (a test fixture, a mock store): the type has a new required `pendingRequests` property, so such a literal needs `pendingRequests: []` added. The server-rendered initial value gains the same empty list, which is identical on both sides and so is not a hydration difference.

**No behaviour change to `connect()`. The asymmetry with `ensureConnected()` is documented rather than removed.**

On a locked wallet the two differ: `ensureConnected()` reconnects, while a bare `connect()` opens the wallet picker, which drops the current wallet. That reads as a bug from outside, and was reported as one, because a consumer's navbar calls `connect()` while its Send path calls `ensureConnected()`. It is intended. `connect()` starts the flow from the USER'S CHOICE: with nothing naming a wallet it opens the picker, from any state, which is what makes a switch-wallet button work, and it does not acquire a second meaning based on `wallet.status`. `ensureConnected()` promises a usable connection at a target step, so it must repair one. `unlock()` is the narrow remedy in between and is the call to reach for on a locked wallet: it prompts and keeps the step, the account, the mechanism and the wallet. `wallet.status` is published so a UI can route on it and offer "Unlock" rather than "Connect"; for `status: 'disconnected'` the equivalent is `connectToAddress(wallet.accountChanged)`.

What made that asymmetry look destructive was the announcement bug above rather than the routing: the picker's teardown also erased whatever the wallet was still holding, so a parked transaction vanished from the app's view while sitting on the user's screen. It no longer does. The difference now costs a click, not a transaction the app can no longer see. All three behaviours are pinned side by side in `test/locked-wallet-reconnect.test.ts`, each with a transaction parked throughout, so collapsing any one of them into another fails.

Known limit, in the README and pinned by a test: `ensureConnected()`'s reconnect reuses the connected address as a demand, so unlocking with a _different_ account selected fails the attempt and tears the wallet down. The announcement survives it, and `unlock()` is unaffected.

**Also fixed, same rule, found while in here:** two paths inside `connect` dropped the wallet from the state without tearing it down, leaving the wrapper holding it with its status still `connected` — so it would keep SIGNING for a state that showed no wallet. They are the bare `connect()` that lands on `MechanismToChoose`, and the launch of a sign-in popup by a user who was already wallet-connected. (Under `prioritizeWalletProvider`, the popup teardown also stops reads routing through that wallet for the popup's duration; they fall back to the configured endpoint, which is the same trade `back()` and `cancel()` already make.) And `disconnect()` no longer unsubscribes from the wrapper's request events: nothing re-subscribed, so a disconnect silenced request announcements for the rest of the connection's life.
