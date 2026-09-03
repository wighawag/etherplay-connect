---
'@etherplay/connect': minor
---

`ensureConnected` delivers the TARGET it documents: the account and wallet you name are part of it, the steps are ordered, it always answers, and an unavailable address becomes a state the user can read and answer.

The docs already said `ensureConnected` "promises a TARGET... so it must do whatever reaching that target takes". The code compared steps. Four things follow from closing that gap; the first is the one to read.

**1. An address or wallet name YOU pass is now part of what satisfies the call — this is the risky change.**

`canResolve` used to look at the step alone, so a connection already at rest at the requested step resolved INSTANTLY while holding a different account, having done nothing: the address was honoured only on the path where a connect happened to occur, which made the argument silently conditional on state you cannot see. It now resolves only when the connection is on the wallet you named and can ACT as the address you named (connected, not locked, actually holding that account), and otherwise initiates an attempt.

**So a call that used to resolve instantly can now raise a wallet prompt.** That is intended, and it is the change to look at when upgrading. It only affects calls that pass a mechanism naming an address or a wallet name; a bare `ensureConnected()` (and `ensureConnected({options})`) is unchanged, which is all but one call site across the consumer tree. It cannot loop: at most one attempt is made per announcement the wallet makes, and an attempt never starts another off its own result.

An address the library REPLAYS from the connection's own state (the locked-wallet reconnect) is still only a preference and still degrades to an ordinary connect. Fixed alongside: that reconnect used to replace your mechanism with the stored one, which discarded your address at exactly the moment it mattered. It now reuses the stored wallet NAME and keeps your address.

**Type change:** the `WalletConnected` overloads now resolve to `ConnectedWithWallet` (`WalletConnected | SignedIn`-with-wallet) rather than `WalletConnected`, because ordering the steps means a signed-in connection satisfies that target and is handed back as itself. `account.address` and `wallet` are on both variants; code that spelled out `WalletConnectedState` for the result, or switched on `step` without a default, needs a look.

**2. The steps are ordered everywhere, from one array.**

`SignedIn` implies `WalletConnected` implies `WalletChosen`. That was implemented for `WalletChosen` and then compared exactly for the other two, so a connection resting at `SignedIn` and asked for `WalletConnected` satisfied nothing, initiated nothing, and HUNG. The order now lives in one place that `isTargetStepReached`, the store's own check and `ensureConnected` all read.

**3. `ensureConnected` always answers, with no timeout.**

No timer, deliberately: a human is in the loop, so any timeout is either too long to be useful or short enough to cut a user off mid-decision, and it would report "timed out" about a wallet dialog that is open and healthy. The rule is narrower: **waiting is only legitimate while something is actually in progress**, where that means an attempt this call started, a wallet prompt, or a decision the user has ON SCREEN (a picker, an account list, a wrong chain on a `WalletConnected` target, the new state below). If the target is unsatisfied, nothing is in progress and nothing can be initiated, the promise settles immediately instead of waiting forever. Two silent hangs are gone with it: the one above, and a connection resting at `WalletChosen` asked to connect, which now upgrades. Every resting entry state is crossed with every target and mechanism in a new enumeration test.

Also fixed, both found by reviewing this change rather than by the tests: `ensureConnected` could REJECT with "nothing is in progress" about an attempt it had just started and which then reached the target (the state cannot show an attempt that has not published yet, so an attempt in flight is now tracked directly); and a `SignedIn` target could wait indefinitely at `WalletConnected` for a signature the user could no longer be asked for, because the wallet had since locked or moved account.

One case worth knowing: with the default `requestSignatureAutomaticallyIfPossible: false`, a `SignedIn` target on an already-connected wallet still rests at `WalletConnected` waiting for YOUR "sign in" button, because prompting over the top of it would ask for a signature you deliberately deferred. `{requestSignatureRightAway: true}` now makes `ensureConnected` request it itself (previously that option was ignored unless a connect happened), and it asks for the signature rather than reconnecting, so the wallet is prompted once.

**`ensureConnected(step, undefined, options)` now honours `options`.** The third argument was dropped whenever the second was an explicit `undefined` mechanism, which is exactly how a caller with options and no wallet to name writes the call.

**4. An address the wallet cannot offer is a resting state, not a throw and not a teardown.**

New `connection.addressUnavailable: {requested, walletName, selected, available, message}`, published beside `error` because nothing failed: the wallet works, it is on another account, and only the user can move it. The connection stays CONNECTED, on the account the wallet does offer, rather than being torn down as a failed attempt was (every failure state carries `wallet: undefined`). Render `message` as an instruction, not a red banner. Two ways out, and an app should offer both:

- the user switches account in their wallet, and the original request proceeds on its own — no further click in your app;
- the user acknowledges it with the new `connection.acknowledgeAddressUnavailable()`, which settles the pending `ensureConnected` as `ConnectionFailure('Connection cancelled')`, the same shape you already treat as "the user chose not to", so existing refusal handling covers it. **Only that method means cancelled**, and only for the address it was showing: the state is also cleared by an app calling `connect()` itself, by a `useCurrentAccount` store following the wallet, and by the state ceasing to be true, and none of those is reported as a cancellation.

One address-bound request stands at a time. Two calls naming different accounts cannot both be satisfied by one connection, so the newer supersedes and the older is answered with an honest `could not reach ...` rather than a cancellation. Two accounts ready at once is what two connections with different `storagePrefix`es are for.

Only an address YOU named produces this. `connect({type: 'wallet', address})` and `connectToAddress(address)` still fail the attempt, unchanged: they drive the flow from the user's choice and hold no promise to settle it with.

`selected`, `available` and `message` describe the wallet AS IT IS NOW: they are re-derived when the wallet announces an account change, and the whole state clears itself if the wallet ends up offering `requested`. An instruction that names an account the user has already left is not one they can follow.

`available` is what the wallet is EXPOSING, not what the user owns. MetaMask reports every permitted account; Rabby (among others) reports only the account it is currently on, so the list is often a single entry that does not contain the requested address even though the user is holding it. Render `message` as the instruction and treat the list as detail, worth showing only when it has more than one entry; "absent from `available`" does not mean "the user does not have it". The switch-in-the-wallet path is carried by `accountsChanged`, which every wallet emits, so it works on those wallets too and needs no button in your app. Asking the wallet to open its own account picker (EIP-2255 `wallet_requestPermissions`) is deliberately not added yet: it needs a new optional wallet-provider capability and support varies per wallet, and a button that silently does nothing is worse than a sentence that works everywhere.

**Also new: `canActAs(address)`,** on the store and as a standalone `canActAs(connection, address)`. It answers "can this connection sign as that address right now" and initiates nothing, so it is safe to call while rendering. `connection.account.address` cannot answer it: that is the address the connection AGREED on, and it is deliberately left untouched when the wallet locks, is revoked, or the user switches account behind the connection's back. A consumer that compared it by hand skipped its `ensureConnected` call for a LOCKED wallet, let the transaction out, and reported the provider's `{code: 4001}` as "Transaction rejected by user" about a prompt nobody was shown.

**Fixed in passing:** an address you pass is lowercased at the boundary before it is matched against the wallet's accounts. A checksummed address (anything produced by viem) failed to match a wallet holding that very account. That was a papercut while it merely failed an attempt; with the address now a requirement, it would have told the user to switch to the account they are already on.

**Your UI has more to render now, and the README says which.** With no timeout, a state where `ensureConnected` waits is a state your app must show, and the list is cross-cutting rather than per-step: `wallet.status === 'locked'` (remedy `unlock()`), `disconnected` with `wallet.accountChanged` (`connectToAddress`), `wallet.invalidChainId` (`switchWalletChain`), `connection.addressUnavailable` (its message), `connection.pendingRequests`, and `error`. A locked wallet is the one most often missed, because `step` stays `WalletConnected` and `account.address` is unchanged: only `wallet.status` and `canActAs` know. See "What your UI has to render" in the README, and the demo's `NeedsTheUser.svelte`, which renders all of them above the step switch in one component; the wallet demo also shows the named-account flow end to end (purchase, then replace it as the same account).

Reasoned through in `docs/adr/0003-ensure-connected-promises-a-target-and-always-answers.md`, which amends ADR-0002 for `ensureConnected` only.
