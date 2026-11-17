---
title: 'An accountsChanged that arrives while a connect is in flight is dropped, so a useCurrentAccount store can end with no wallet'
slug: a-wallet-announcement-during-a-connect-is-dropped
type: observation
status: fixed
fixed: 2026-11-02, by making the `useCurrentAccount` follow pass `addressIsPreference` (the first direction below); pinned by `test/stale-wallet-answers.test.ts`, "following the wallet (useCurrentAccount)"
created: 2026-11-02
source: probing for siblings of the late auto-connect bug (fixed alongside `test/late-auto-connect.test.ts` and `test/overtaken-attempts.test.ts`), with `holdNext('eth_accounts')` on the lockable-wallet fixture
note: filed beside `work/notes/observations`, which is a FILE in this repo, as the earlier note here was.
---

# A wallet announcement during a connect is dropped

Not the same defect as the late-attempt one, which is why it was left alone: nothing publishes over a newer state here. The announcement itself is lost.

Reproduction, on a store with `useCurrentAccount: 'always'`, connected as A on a wallet whose `eth_accounts` is slow:

1. The user switches the wallet to B. `onAccountChanged` follows it with `connectToAddress(B)`, which publishes `WaitingForWalletConnection` (no `wallet`) and waits on `eth_accounts`.
2. The user switches back to A before that answers. `onAccountChanged` runs, but it only acts `if ($connection.wallet)`, and the in-progress step carries none, so the announcement is ignored.
3. `eth_accounts` answers `[A]`. The attempt DEMANDS B (`connectToAddress` names the address), so `resolveRequestedAddress` throws `could not find address`, and the failure path rests the flow with `wallet: undefined`.

Observed end state: no account and no wallet, while the wallet is sitting on A, the account the user was connected as before they started.

Two possible directions were considered: let the `useCurrentAccount` follow pass a preference rather than a demand (`addressIsPreference`, which already exists for the `ensureConnected` replay), so a vanished address degrades to an ordinary connect on whatever the wallet now offers; or have `onAccountChanged` remember an announcement that arrives with no wallet in the state and replay it when the attempt lands. The first is the smaller change, and is the one taken. The announcement itself is still not replayed, which is fine under `useCurrentAccount` since the attempt reads the wallet's accounts after the second switch.
