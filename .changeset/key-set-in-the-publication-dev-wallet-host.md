---
'@etherplay/dev-wallet-host': minor
---

Rebuilt on `@etherplay/connect-core` 0.8.0: the dev wallet host returns the account's key set (`keySet`, an Ed25519 signing key and an X25519 encryption key) and a publication signature over the message naming it. Required by `@etherplay/connect` 0.19.0, which refuses an account from an older host with "the wallet host is out of date".
