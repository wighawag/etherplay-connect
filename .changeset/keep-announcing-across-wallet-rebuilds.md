---
'@etherplay/wallet-connector': minor
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': minor
---

Stop erasing a wallet request that is still outstanding, and say who must answer it.

Every wallet-state rebuild in `createConnection` asserted `pendingRequests: []`. That erased an outstanding request **permanently**, because the store's mirror of the list is only written on request events and the next event for that request is the one that ends it, which writes an empty list too. Nothing ever put it back, so the user was left holding a wallet popup the app believed did not exist. All nine sites now read `alwaysOnProviderWrapper.getPendingRequests()`, which is authoritative.

The triggering flow is an ordinary one rather than an exotic one: **a send against a locked wallet raises the connection flow**, so `connect()` runs while the wallet is still holding the transaction and rebuilds the state underneath it. Confirmed from a real locked-Rabby session, where the app reported `step: WalletConnected`, `wallet.status: connected`, `pendingRequests: 0` and its own dispatch count at `1` with a transaction genuinely in flight, and now reproduced in `test/announced-requests.test.ts`.

The wallet event handlers were never at fault: `onChainChanged` and `onAccountChanged` spread the existing wallet state and preserve the list. Only the paths that build a wallet object from scratch (`connect`, `restoreWalletChosenAfterFailedConnect`, `selectWallet`) dropped it.

Downstream this cost more than a missing modal. jolly-roger built a parallel `$inFlight.dispatching` ledger that its wallet-action modal, its escape hatch and its unload guard all consult, because all three went silent when the list was emptied. That ledger still earns its place (it also covers sends signed by a local signer, which no wallet is asked about), but the reason it had to outrank `pendingRequests` is now gone.

**New: `PendingRequest.account`**, the address expected to answer: the signer of a signature, the `from` of a transaction. Now that the list survives a rebuild, a request can outlive the wallet state it started under, and the user is free to switch wallet or account while one is outstanding. "Something is pending" therefore has to be answerable with "pending for whom", or a consumer will tell the user to approve in whichever wallet is current, which after a switch cannot answer it. Read per method rather than positionally, because `personal_sign` takes `[data, address]` and `eth_sign` takes `[address, data]`, the reverse; each branch is shape-checked, so an unreadable request loses the address and keeps the announcement rather than reporting a confident wrong answer.

Known limit, recorded in ADR-0001: the list is not per-wallet, so a request outstanding against a wallet the user has switched away from is still reported, under the new wallet's state. `account` makes that detectable. The wrapper does not mark or drop such a request, and if it ever does it should mark rather than drop, since dropping would resurrect the erasure bug in a narrower form.
