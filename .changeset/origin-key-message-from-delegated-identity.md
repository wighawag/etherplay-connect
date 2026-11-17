---
'@etherplay/connect-core': patch
'@etherplay/connect': patch
---

`originPublicKeyPublicationMessage` now comes from `delegated-identity` (`^0.1.1`), which holds the ownership proof that other services verify, so one copy of that message exists instead of two that could drift. `@etherplay/connect-core` re-exports it, and `@etherplay/connect` re-exports it from there, so every existing import keeps working. The text is unchanged, byte for byte, and is pinned in connect-core's tests. `delegated-identity` depends only on `@noble/hashes` and `@noble/secp256k1`, which connect-core already depended on. No API change.
