---
'@etherplay/connect': patch
---

Fix a dead end after a rejected wallet prompt in wallet-only mode.

In wallet-only mode (`walletOnly: true`, or `targetStep: 'WalletConnected'`) the mechanism picker is never shown, because `connect` always defaults the mechanism to `{type: 'wallet'}`. The wallet failure handlers still rested on `MechanismToChoose`, a step such an app has no reason to render, so a rejected wallet prompt left the user with nothing on screen and no way to retry or cancel. `ensureConnected` only ever initiated from `Idle`, so the next call neither prompted the wallet nor settled: it hung silently.

Two changes:

- A failed attempt now rests on the step that offers the user a real next decision: `MechanismToChoose` when the app is multi-mechanism, `WalletToChoose` when the app is wallet-only and several wallets are detected, and `Idle` when it is wallet-only with a single (or no) wallet. The `error` is kept in every case so the UI can explain the failure. This rule now covers all three wallet failure paths, which is also what makes them consistent with the auto-connect paths that already reset to `Idle`.
- `ensureConnected` now also initiates from a picker step that still carries the `error` of a previous failed attempt, so a retry prompts again instead of waiting forever. It still refuses to initiate from a picker step without an error, since that means the user is mid-choice and connecting would hijack it. The new `{forceConnect: true}` option opts into initiating from a resting step regardless. Rejection on a fresh error is now checked before the return-to-`Idle` cancellation, so a wallet-only failure that rests on `Idle` still rejects with the real cause (and `code === 4001` for a user rejection) rather than a generic `Connection cancelled`.

Downstream cleanup: the `MechanismToChoose`/`WalletToChoose` -> `connection.back('Idle')` workaround in `mandalas` (`web/src/lib/ui/purchaseFlow.ts`) can be deleted once this is released, and `_ensureConnected` reduced to `ensureConnected` plus a catch.
