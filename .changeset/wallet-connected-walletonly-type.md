---
'@etherplay/connect': patch
---

Type a `targetStep: 'WalletConnected'` connection as `walletOnly: true`, which is what it already is at runtime.

The runtime computes `walletOnly = settings.walletOnly || targetStep === 'WalletConnected'`, so a `WalletConnected` store always exposes `walletOnly === true`. The two `WalletConnected` overloads disagreed about that: the default-Ethereum-connector one returned `ConnectionStore<..., 'WalletConnected', true>` while the custom-connector one returned `ConnectionStore<..., 'WalletConnected'>`, leaving the parameter at its `false` default. So `store.walletOnly` was typed `false` on a store that reports `true`, and the two overloads contradicted each other for no reason.

Both now say `true`. Only the `walletOnly` property changes type: every other member of `ConnectionStore` ignores the `WalletOnly` parameter once `Target` is `'WalletConnected'`, so `connect`, `ensureConnected` and `isTargetStepReached` are unaffected. Code that read `store.walletOnly` on such a connection was reading a value the types described wrongly; code that compared it against `false` was already dead at runtime and now fails to compile, which is the point.

`AnyConnectionStore` deliberately keeps its `ConnectionStore<..., 'WalletConnected', false>` member even though `createConnection` no longer produces one: the type is exported, and narrowing the union would break consumers that spelled that member out explicitly.
