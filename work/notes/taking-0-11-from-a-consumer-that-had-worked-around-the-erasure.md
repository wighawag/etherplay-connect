---
title: 'Taking 0.7.1 -> 0.11.2 in jolly-roger: the deprecated mirror hides the fix, and SignedIn does not always mean session-account'
slug: taking-0-11-from-a-consumer-that-had-worked-around-the-erasure
type: observation
status: open
created: 2026-08-31
source: upgrading jolly-roger and its six descendant nodes (website, with/local-signer, with/hosted-account, template-commit-reveal, bleeps, mandalas), with a stalling EIP-6963 wallet parking eth_sendTransaction and a lock/unlock harness driving real wallet-state rebuilds
note: filed beside `work/notes/observations`, which is a FILE in this repo rather than the directory the convention elsewhere in this tree assumes. Move it into `work/notes/observations/` if that file is converted.
---

# What the 0.11 migration looked like from the consumer that reported the erasure

Provenance for everything below: jolly-roger is the app whose console log produced `pendingRequests: 0` with a transaction genuinely in flight, and which had built a parallel in-flight ledger to survive it. It has now taken `0.7.1 -> ^0.11.2` and removed the parts of that workaround the fix made redundant. The fix works. Both halves were verified end to end from this side, by parking a transaction in a wallet that does not answer and then driving the transitions: the request survives a locked-wallet reconnect through `ensureConnected()`, and it survives a bare `connect()` that comes to rest on the picker with no wallet at all. Pinned back to 0.7.1 and 0.10.0 respectively, those two checks fail, so they discriminate rather than merely pass.

Three signals came out of doing it. The first is the one worth acting on.

## 1. The deprecated mirror makes the wallet-less fix opt-in, silently

`wallet.pendingRequests` is kept as a deprecated mirror, stamped from the same read so the two cannot drift while consumers migrate. That is a kindness and it worked: the upgrade from 0.10.0 typechecked with zero changes.

That is also the problem. A consumer who upgrades and runs their suite gets green, sees nothing, and keeps reading the mirror. The mirror is present on every state that HAS a wallet, which is every state they were already testing, so nothing they own can tell them anything is wrong. What they do not get is the actual point of 0.11.0: the list surviving a state with no wallet. A failed reconnect resting on `wallet: undefined`, or a bare `connect()` landing on the picker, still reads `undefined` for a request the user's wallet is genuinely holding, which is the original bug's user-visible symptom.

So the release note is the only thing standing between a consumer and the bug they upgraded to fix. In this app that was caught by accident: the field move was noticed while reading the diff, not while running anything.

Worth considering a DEV-only one-time `console.warn` on first read of `wallet.pendingRequests`, the way `guardDispatch` warns about a client guarded twice. A getter on the wallet object would do it. The deprecation comment is excellent and is in the one place a consumer with a working build never opens.

Recorded as an observation rather than a request because the trade is real: a getter changes the shape of an object consumers spread, and this library has already been bitten by identity churn (the `publishedPendingRequests` cache exists for exactly that reason).

## 2. ADR-0002's `SignedIn` reasoning rests on a premise one consumer breaks

ADR-0002 rejects giving `connect()` a state-dependent meaning, partly on this:

> It also does not survive contact with `SignedIn`. A locked wallet there does not make the target unsatisfied, because a signed-in app acts through its session account, so `ensureConnected` rightly resolves.

The conclusion looks right. The premise is narrower than it reads. "Signed in" and "sends through the user's wallet" are not exclusive: an app can target `SignedIn` for its session identity and still send some transactions from the wallet account.

`template-commit-reveal` is exactly that. `TARGET_STEP` is `SignedIn`, its game actions go through a local signer, and its `/contracts` page sends through the ACCOUNT executor, which is the user's wallet. Measured there, with a transaction parked and the wallet then locked: `ensureConnected()` resolves immediately, because step `SignedIn` already satisfies the target, and the wallet stays `locked`. An inherited test that expected the template's reconnect waited thirty seconds for a status that was never coming, which is how this surfaced.

Nothing is lost by it. The wallet prompts for its password on demand when the next request reaches it, and the app can render the locked state from `wallet.status`. So this is not a bug report and probably not a code change. It is a note that the ADR's sentence will be read as "signed-in implies session-account", that a reader will check it against a consumer where that does not hold, and that they will not be able to tell whether the conclusion survives. It does survive, for a slightly different reason than the one given: the remedy on a locked wallet is `unlock()` whatever the step is, so `ensureConnected` not repairing `SignedIn` costs nothing as long as the consumer routes on `wallet.status`. Worth a clause in the ADR rather than a change to the code.

## 3. The `addingChain` versus `switchingChain` distinction paid off immediately, which is evidence for ADR-0001

Recorded because a design that pays off is as worth knowing as one that does not, and this one was cheap to publish and would have been invisible if nobody looked.

Taking 0.11.2 made this app's network-switch modal wrong in a way it could not previously have detected: it said `Switching...` for both prompts, over one sentence about approving "the network switch", while the wallet was in fact offering to ADD a network the user would keep. That is the same class of untruth as telling someone to confirm a request in a wallet that has not been asked. It was fixed the same day as the upgrade, purely because the state names the two prompts apart.

That is the concrete case for the rule in ADR-0001 that these two calls may bypass the wrapper only while they publish a dedicated state a consumer renders. Collapsing `switchingChain` to a boolean would silently restore the untruth in every consumer that had fixed it.

## What `purpose` and `account` are actually used for downstream, since they were added on argument

Both are wired up rather than ignored, which may be useful when weighing whether to grow either union.

`purpose` selects the modal's words: a delegation is named as granting a browser key authority to act for the account, because an unexplained request for exactly that is the shape a phishing prompt takes. An unrecognised value falls back to `kind` and never throws, so the union can grow without breaking a consumer. Absent is treated as normal rather than as a gap, per the field's own note.

`account` is compared against the connected account, and a mismatch gets different words: the modal names both addresses and tells the user which wallet can actually answer, instead of pointing at whichever wallet is current. That case is only reachable because a request now outlives the wallet state it started under, so the field and the fix that made it necessary arrived together.

## Still unverified from here

The delegation path itself. `getDelegation` and `getSignatureForPublicKeyPublication` going through the wrapper is the half of 0.10.0 this consumer cannot exercise, because it never requests a delegation. The app that reported the unexplained wallet prompt is `reveal-or-die`, which is currently excluded from this tree's cascade, so the `purpose` wording built for it has not yet run anywhere that produces a real delegation request.
