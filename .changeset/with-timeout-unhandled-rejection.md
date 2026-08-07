---
'@etherplay/connect': patch
---

Stop `withTimeout` emitting an unhandled rejection (and leaking a timer) when the call it wraps fails.

`withTimeout` attaches a side-effect handler to the promise it races, purely to cancel the pending timer once that promise settles. It passed only an `onFulfilled` callback:

```js
promise.then((result) => {
	/* clear the timer */
});
```

A `.then()` with no rejection handler creates a SECOND derived promise, and that one rejects with nobody listening. The caller's own error handling is irrelevant: it is attached to the promise returned by `Promise.race`, not to this derived branch. So every failing call routed through `withTimeout` emitted an unhandled rejection even when fully handled.

`connect()` wraps `getChainId()` and `getAccounts()` in `withTimeout`, so this fired on completely ordinary outcomes: a locked wallet, a wallet that refuses to authorize accounts (EIP-1193 `4100`), a user declining a prompt (`4001`). The visible effects were console noise blaming the app for an error it had handled, a spurious failure in test runs that treat unhandled rejections as errors, and a hard crash under `--unhandled-rejections=strict`.

The same missing handler leaked the timer on the rejection path: after a call failed, its timer stayed pending for the rest of the timeout (5s by default) instead of being cancelled.

Both are fixed by handling both settle paths, since the branch only ever existed for its side effect. The value and the error are still propagated by the `Promise.race`, so timeout semantics are unchanged. `test/utils.test.ts` now pins the rejection is propagated unchanged, that no unhandled rejection is emitted (whether the caller awaits or catches, and also when the wrapped promise fails only after the timeout has already won), and that the timer is cleared on both paths.
