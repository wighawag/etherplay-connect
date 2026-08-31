---
'@etherplay/connect': patch
---

Enforce the wallet-teardown invariant in one place instead of eleven.

No behaviour change: this is the rule that was already written on `teardownWallet` and in the README, moved from eleven hand-written call sites into the one function that publishes state. A state with no `wallet` now tears the live wallet down as it is published, so the always-on wrapper cannot keep routing (or, while its status is `connected`, SIGNING) for a state that shows no wallet. `WaitingForWalletConnection` is the one exception, being `connect`'s own in-progress step, which shows no wallet precisely because it is in the middle of registering one.

Two of those eleven sites were missing until this release, which is the point: an invariant spread across a growing number of call sites is a rule that holds until someone writes the next site. It is the same treatment `pendingRequests` received, and for the same reason.

Established empirically before being changed: asserting the invariant inside the publish function passed the whole suite, so exactly one exception exists. Removing the enforcement afterwards fails five tests across two files, so it is pinned by behaviour rather than by shape.
