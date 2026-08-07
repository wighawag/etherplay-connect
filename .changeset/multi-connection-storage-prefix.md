---
'@etherplay/connect': minor
---

Add `storagePrefix` so several connections in one page keep separate persisted state.

A page can legitimately run more than one connection: a player connection (hosted sign-in, `targetStep: 'SignedIn'`) plus a separate payment connection (`targetStep: 'WalletConnected'`, `autoConnect: false`) so whoever pays need not be the account the player signed in as. Until now both wrote the same two module-level keys, `__origin_account` and `__last_wallet`, in both `localStorage` and `sessionStorage`, so they silently overwrote and deleted each other's state: connecting the payment wallet made the player connection auto-reconnect as the payer on the next page load, `disconnect()` on either connection wiped the other's stored identity, and `cancel()` wiped the other's last-wallet hint.

`storagePrefix` is available on every `createConnection` overload and namespaces both keys in both storages, so the effective keys are `${storagePrefix}__origin_account` and `${storagePrefix}__last_wallet`. It defaults to `''`, which keeps the keys byte-identical for existing single-connection apps: no migration, no lost sessions. `disconnect()` and `cancel()` now only clear their own connection's namespace, which falls out of the prefixing.

What `doNotStoreLocally` covers is unchanged: it still gates saving the origin account and nothing else. `saveLastWallet` stays unconditional on purpose, since remembering the last wallet is wanted for every connection, including the payment one, and namespaced it no longer collides.
