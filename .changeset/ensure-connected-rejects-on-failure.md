---
'@etherplay/connect': patch
---

Fix `ensureConnected` never settling when a connection attempt fails.

When the user rejected the wallet prompt (EIP-1193 code 4001), the store went `Idle -> WaitingForWalletConnection -> MechanismToChoose` with an `error` set. `ensureConnected` only rejected when the store returned to `Idle`, so the returned promise neither resolved nor rejected and every `await` on it hung forever, leaving downstream UI wedged with no error to react to.

`ensureConnected` now rejects with a `ConnectionFailure` when an attempt ends without reaching the target step:

- a fresh `error` appearing in the store (one that was not already there when `ensureConnected` was called) rejects with that error's `message`, and propagates the underlying wallet error as both `cause` and a convenience `code`, so callers can tell a user rejection (`code === 4001`) from a genuine failure,
- an attempt that falls back to a resting step (`Idle`, `MechanismToChoose`, `WalletToChoose`) after having started rejects with `Connection cancelled`.

Being at a resting step is never a failure by itself: `ensureConnected` is routinely called while the picker is showing (including with a stale error banner from a previous attempt), and those calls still wait for the user's choice and resolve normally.

New export: `ConnectionFailure` (an `Error` subclass with `cause` and `code`).

Downstream cleanup: the `_ensureConnected` workaround in `mandalas` (`web/src/lib/ui/purchaseFlow.ts`), which races `ensureConnected` against the store returning to a resting step, can be deleted once this is released; its call sites can simply catch the rejection. `template-onchain-app` awaits `ensureConnected` too and was exposed to the same hang.
