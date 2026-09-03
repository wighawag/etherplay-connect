# `ensureConnected` promises a target, and always answers

Status: accepted

Supersedes the "known limit" recorded in `0002-connect-ensure-connected-and-unlock-are-three-promises.md` for `ensureConnected` only. `connect` and `connectToAddress` keep their semantics (a demand they cannot meet still fails the attempt), with one behavioural exception noted under Consequences: a caller's address is now lowercased at the boundary, so a checksummed address that used to fail against a wallet holding that very account now connects.

## The rule

`ensureConnected(step, mechanism?, options?)` is satisfied when the connection is **at or beyond `step`**, **on the wallet the caller named**, **able to act as the address the caller named**, and, for a `WalletConnected` target, **on the right chain**. Anything the caller did not name is not part of the target, so a bare `ensureConnected()` means exactly what it always meant.

The chain is deliberately scoped to that one target, which is the pre-existing behaviour and is easy to misread from the rule above: a `SignedIn` target does not check it, and `skipChainCheck` does nothing there.

Two supporting rules make that checkable rather than aspirational:

- **The steps are ordered, once.** `SignedIn` implies `WalletConnected` implies `WalletChosen`, and that order lives in a single array (`orderedTargetSteps`) that `isTargetStepReached`, the store's own check, and `ensureConnected` all read. Adding a fourth step is one edit, not three.
- **Waiting is only legitimate while something is in progress.** If the target is not satisfied, nothing is in progress, and nothing can be initiated, that is an answer and it is delivered. The legitimate waits are a closed, positive list, each of which is a state the app renders and the user answers — plus one that no published state can express: an attempt this call started and has not seen come back.

## Why

`ensureConnected` promises a target and the docs said so. The code compared steps.

Four consequences, all hit by one consumer in one flow (recording which signing route produced a transaction, so that replacing it — which reuses the original nonce, so it must be signed by the same key — can reopen that route):

1. **The address argument was silently conditional.** `canResolve` looked at the step only, so a connection already at rest at that step resolved instantly while holding a different account, having done nothing. The address was honoured only on the path where a connect happened to occur, which the caller cannot see from outside.
2. **The order was implemented once and forgotten twice.** `canResolve` did "at or beyond" for `WalletChosen` and then compared the other two exactly. A connection resting at `SignedIn` and asked for `WalletConnected` satisfied nothing, initiated nothing, and waited forever. Not a wrong answer: no answer.
3. **Several entry states could wait forever**, of which (2) was one. A `WalletChosen` connection asked to connect was another: it is a resting step, it is not a picker, nothing was in progress and nothing initiated.
4. **An address the wallet could not offer threw**, which landed in `connect`'s catch and tore the wallet down. The user was left with no wallet at all because their working wallet was on another account.

## Decisions, and what was rejected

### The caller's address is a requirement; a replayed one stays a preference

Unchanged from ADR-0002 in substance, but it now has to survive one more path: the locked-wallet reconnect replaced the caller's mechanism with the stored one, which discarded the requirement at exactly the moment it mattered. The reconnect now reuses the stored WALLET NAME and keeps the caller's address.

### No timeout

Rejected outright, not deferred. A human is in the loop, so a timer long enough not to cut someone off mid-decision is too long to be useful, and it reports "timed out" about a wallet dialog that is open and healthy. The replacement is narrower and testable: waiting requires something in progress, where "in progress" includes a decision the user has on screen.

The list is stated POSITIVELY (`awaitingUserReason`), so a new step or a new resting reason is unreachable-by-default rather than a fresh way to hang, and every resting entry state is crossed with every target and every mechanism kind in `test/ensure-connected-settles.test.ts`. A settle guarantee argued in prose decays; an enumerated one fails.

**An answer can be wrong as well as absent, and that is the harder half.** The first implementation of the rule inferred "nothing is in progress" from the published state, which holds for `connect` (it publishes `WaitingForWalletConnection` before its first await) and not for `selectWallet` (which awaits `getChainId` first) or the popup path (which can await a key generation). In that window the store still showed the entry state, so `ensureConnected('WalletChosen')` from any non-`Idle` state REJECTED with "nothing is in progress" about an attempt that was running and then reached the target. Found in review, after the enumeration passed: the enumeration asserted that every case settled, and a wrong answer settles. So an attempt in flight is now tracked directly rather than inferred, and the enumeration additionally asserts that a "nothing is in progress" rejection is not contradicted by where the connection then comes to rest.

Two entries on that list are worth naming because they look like hangs and are not:

- **`WalletConnected` under a `SignedIn` target.** With the default `requestSignatureAutomaticallyIfPossible: false`, the app renders its own "sign in" button and prompting over the top of it would ask for a signature the app deliberately deferred. `{requestSignatureRightAway: true}` (or the store setting) opts in, and `ensureConnected` then requests the signature itself rather than reconnecting, which would prompt twice.
- **A wallet on the wrong chain.** Reconnecting does not move the chain, so initiating there would prompt for nothing and rebuild a wallet that was fine. The remedy is `switchWalletChain()` or the user's own switch, and `wallet.invalidChainId` is what the app renders meanwhile.

### An unavailable address is a resting state, not a failure and not a throw

**Chosen: connect to what the wallet offers, and publish `connection.addressUnavailable`** carrying the requested address, the wallet, the account it is on instead, every account it offers, and a renderable sentence. The user either switches account in their wallet — in which case the original request proceeds, with no further click in the app — or acknowledges it, which settles the promise as `ConnectionFailure('Connection cancelled')`, the shape consumers already treat as "the user chose not to".

Considered and rejected:

- **Keep throwing.** It is not a failure: the wallet works. And the throw's real cost was not the message but the teardown, since every failure state carries `wallet: undefined`. Ending "connected as somebody else, and saying so" beats ending "not connected at all".
- **A new step (`AddressUnavailable`).** Every consumer's `switch` on `step` would have to learn it, and it would say the connection is somewhere it is not: it IS connected. The state is a reason beside `error`, not a place.
- **Reuse `error`.** An app that renders `error` paints it red and offers "retry", and neither is right for "your wallet is on a different account, switch it". It is an instruction, so it gets its own field with its own dismissal.
- **Ask the picker instead** (`ChooseWalletAccount`). The caller named an account; offering a list is answering a different question. The available accounts are on the resting state, so an app that wants to offer a choice still can.
- **Ask the wallet to open its own account picker** (EIP-2255 `wallet_requestPermissions`). The best remedy where it works, and the natural pairing with `switchWalletChain()`. Deferred rather than dismissed: it needs a new optional capability on `WalletProvider` (two packages), and support varies per wallet with no way to detect it before asking, so the button would silently do nothing on the wallets that lack it. Worth doing once support can be established; the resting state and its message work everywhere meanwhile, and adding it later changes nothing about the state itself.

### `available` is what the wallet exposes, not what the user owns

Worth stating because the field name invites the opposite reading, and because the difference decides whether the remedy is a list or a sentence. MetaMask answers `eth_accounts` with every account the user permitted; Rabby answers with the one it is currently on. So `available` frequently holds a single entry that does not contain `requested`, while the user is holding `requested` the whole time.

This is why the instruction, not the list, is the primary affordance: "switch to that account in your wallet" is the only remedy that works on a wallet exposing one account at a time, and it is carried by `accountsChanged`, which every wallet emits. An app should render the list only as detail, and only when it has more than one entry. Pinned by the one-account case in `test/ensure-connected-target.test.ts` ("carries on with the original request when the user switches to that account in the wallet"), whose fixture exposes exactly one account and swaps it on switch.

The loop this could have introduced — ask, the wallet answers with another account, ask again — is bounded at **one attempt per wallet announcement**. Our own attempts do not count as announcements, so an attempt can never start another off its own result, however the wallet answers; anything beyond that requires the user to act in their wallet again, which is a person rather than a loop.

Two earlier formulations are recorded because both read better than they measured, and the second is the subtler trap:

- **"One attempt per distinct wallet ANSWER."** Measured false: repeating the same announcement three times produced three attempts, because the reset that stopped the rule suppressing legitimate retries forgot the answer every time.
- **"One attempt per distinct STATE"** (a fingerprint of step, account, status and accounts). Provably terminating, and wrong: it refuses the retry when the user switches BACK to an account they were on before, which is an ordinary thing for a person to do, and leaves them following an instruction that has stopped having any effect.

The rule that survived is pinned the hard way: delete the guard and the settle enumeration does not fail, it HANGS, which is the honest signature of the bug it prevents.

### Attempts are started out of the publish

A connection attempt decided on inside `evaluate` is scheduled on a microtask rather than started there. `evaluate` runs inside `set`, and a single wallet event does not produce a single state: `onAccountChanged` publishes the new status first and the new accounts second. Starting an attempt from inside the first of those re-enters the store while the handler is still mid-way through its own transitions, which then continue on top of a state the attempt has already replaced. The decision stays synchronous, which is what keeps the one-attempt-per-announcement accounting honest; only the work is deferred.

### A dismissal is counted per address, not inferred

`ensureConnected` reads "the user dismissed the address-unavailable state" from a count that only `acknowledgeAddressUnavailable()` increments, kept PER ADDRESS. It used to infer it from the state DISAPPEARING, which is true of that method and of nothing else — while the app calling `connect()`, a `useCurrentAccount` store following the wallet onto another account, and the reason simply ceasing to be true all clear the same field. Each of those was reported to the caller as `Connection cancelled`, the shape consumers are told to treat as "the user chose not to", so an event the user never caused was invisible to them.

Per address rather than per connection for the same reason one step further out: the dismissal answers one request, and a count kept per connection cancelled every address-bound call on it — including one that was at that moment waiting on a wallet prompt the user had not touched. The dismissal is also checked BEFORE the in-progress branch, since a decision is an answer whatever else the connection is doing, and the dismissing call publishes even when the field was already cleared, so that a click landing in that window still wakes the calls that need to hear about it.

**One address-bound request at a time.** A connection has one wallet, one account and one such state, so two calls naming different accounts cannot both stand: the newer supersedes and the older is answered with an honest `could not reach ...`, never with a cancellation the user did not make. Two accounts ready at once is what two connections with different `storagePrefix`es are for.

That answer is honest but was not IDENTIFIABLE: from outside it looked like every other "came to rest, nothing in progress". `0004-a-failure-says-why-with-a-safe-default-shape.md` labels it `superseded`, using a registry of live address-bound requests, because the distinguishing fact lives in another call rather than in the state this one can see.

### `canActAs(connection, address)`

Added because a consumer needed to RENDER readiness and wrote the comparison itself, against `connection.account.address`, which is the address the connection agreed on rather than the one that can sign now. Its check passed for a locked wallet, so it skipped the `ensureConnected` call, let the send out, and reported the provider's `{code: 4001}` as "transaction rejected by user" about a prompt nobody was shown. A predicate that initiates nothing is what that code wanted; without one, every consumer writes an approximation of it.

## Consequences

- **Resolution is stricter, and can turn an instant resolve into a wallet prompt.** Only for callers that pass a mechanism naming an address or a wallet name, which is the point: it was already what the docs promised. Every `ensureConnected` call site in this repo passed no mechanism at all before this change (the demo now has one, added here to exercise it), and across the consumer tree only one passes an address: jolly-roger's `ensureCanSignAs`, which documented this exact gap as an upstream limitation.
- `connect` grew a third meaning for an address, kept internal: demand, preference, or reported demand. The public surface is unchanged.
- A caller's address is lowercased at the boundary. It was compared case-sensitively against lowercased wallet accounts, so a checksummed address (anything from viem) failed to match a wallet holding that very account. Latent while that merely failed an attempt; with the address a requirement it would have told the user to switch to the account they were already on.
- A `SignedIn` connection asked for a DIFFERENT account necessarily re-runs the wallet flow, which costs the session: being signed in as A is not a way of being signed in as B.
- `ensureConnected('WalletChosen')` on a locked `WalletConnected` wallet now resolves as it stands instead of reconnecting. That target never needed accounts, so a locked wallet satisfies it, and prompting for one would be work nobody asked for. It is a narrowing of ADR-0002's "`ensureConnected` is the one that reconnects", and the narrowing is the accurate statement: it reconnects when the target needs the wallet to ACT.
- `ensureConnected(step, undefined, options)` now honours `options`. The third argument used to be dropped whenever the second was an explicit `undefined` mechanism, which is how a caller with options and no wallet to name writes the call. Found by writing the test for `requestSignatureRightAway`, which could not pass until this was fixed.
