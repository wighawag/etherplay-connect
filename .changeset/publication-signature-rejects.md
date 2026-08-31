---
'@etherplay/connect': patch
---

`getSignatureForPublicKeyPublication` now reports its failures as a rejection, like `getDelegation` does.

It was declared `(): Promise<`0x${string}`>` but was not `async`, so its two failure paths (`Not signed in`, and a hosted account with no stored signature) left the function **synchronously**. `getDelegation` beside it is async, so its identical-looking `throw` became a rejection: two siblings on the same object, both typed as returning a promise, failing in two different ways, with nothing in either signature to warn a caller.

The cost was silent for the usual `try { await ... } catch`, which catches both, and real for `getSignatureForPublicKeyPublication().catch(showTheReason)`, which never ran its handler and let the exception escape instead.

If you are one of the rare callers that wrapped the CALL rather than the await in `try`/`catch`, that `catch` no longer fires; move it to the promise. Both methods now behave the same way, which is the point.
