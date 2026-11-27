---
'@etherplay/connect-core': minor
---

BREAKING: the public-key publication names a key set. `deriveOriginAccount` derives, beside the origin signer (unchanged, still the delegate of `savedDelegations`), `delegated-identity` 0.2.0's `deriveKeySet(signer.privateKey)`: an Ed25519 signing key and an X25519 encryption key, returned as `OriginAccount.keySet`. `savedPublicKeyPublicationSignature` is now over `originPublicKeyPublicationMessage(origin, keySet)` instead of the old message naming `signer.publicKey`. `originPublicKeyPublicationMessage` (now taking a key set), `deriveKeySet` and the `KeySet` type are re-exported from `delegated-identity`. The wallet host builds its result with `deriveOriginAccount`, so a redeployed host returns the key set and the new signature.
