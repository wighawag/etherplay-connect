---
'@etherplay/connect': minor
---

Fix two ways a flow could strand the user: a reconnect that failed on the wrong account, and a sign-in popup nothing could cancel.

**A replayed address is a preference; an address you named is a demand.**

`ensureConnected()` reconnects a locked wallet by replaying the mechanism the connection already had, address included, which is what keeps an ordinary unlock from bouncing a multi-account user into `ChooseWalletAccount`. But the user is free to unlock on a DIFFERENT account, and the replayed address was treated as a demand: `connect` threw `could not find address 0x...`, which landed in the catch and tore the wallet down. The reconnect performed the very teardown it exists to prevent, one step later, on the ordinary "locked my screen, came back on my other account" path.

A replayed address now degrades to an ordinary connect, landing on the account the wallet actually offers with `mechanism.address` and `account` updated to say so, which is what the caller asked for: it asked to be connected and named no account. An address YOU name (`connectToAddress(a)`, `connect({type: 'wallet', address: a})`) is unchanged and still fails the attempt, because connecting to a different account would answer a question nobody asked.

**`connection.cancel()` now actually cancels a sign-in popup.**

`PopupPromise.cancel()` was an empty `TODO`, so cancelling returned the store to `Idle` while leaving the promise `connect()` returned pending for good, with the popup window still open behind it. An app doing `await connection.connect({type: 'email'})` and offering a cancel button waited forever. It now closes the window and settles the promise, rejecting internally with `type: 'cancelation'`, which `connect` already reads to tell a cancellation (nothing to report) from a refusal (a reason the app must surface).

Settling that promise wakes `connect`'s own failure handler, which rests on `Idle`, so it now only acts when it still owns the flow: `cancel()` and `back(step)` have already chosen where to come to rest, and `back('MechanismToChoose')` during a popup would otherwise have bounced the user to `Idle` a microtask later. The same ownership check fixes a latent bug where launching a second popup rejected the first, whose handler then landed on `Idle` on top of the second attempt.
