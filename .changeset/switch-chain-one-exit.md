---
'@etherplay/connect': patch
---

`switchWalletChain` now has one exit instead of eight, and says what state it refuses from.

No behaviour change beyond one message. The function ended with eight `set` calls doing the same two things in different orders, each repeating an `if ($connection.wallet)` guard and each free to decide for itself whether to attach an error. That freedom is what produced the stale-banner bug fixed alongside this: an error set on the way past a recovery that then succeeded.

There are now two named exits, "a prompt is up, and which one" and "the prompt is over, with or without an error", so the rule is visible in the shape rather than remembered at each site: **the error is set by whoever gives up, and by nobody on the way past.** When there is no error, the field is omitted rather than set to `undefined`, so a successful switch does not silently clear an unrelated one the app has not shown yet.

The message when there is no wallet was `invali state`, and is now `invalid state: no wallet to ask`. If you were matching on that string, which the typo made unlikely, it has changed.

`wallet.switchingChain` still publishes `'switchingChain'` and then `'addingChain'`, and a test now pins that ORDER. The distinction is not cosmetic: "add this network" is a different question from "switch network", and it is what ADR-0001 lets these two calls bypass the always-on wrapper for, so collapsing the two values into a boolean would be a decision to announce them through the wrapper instead.
