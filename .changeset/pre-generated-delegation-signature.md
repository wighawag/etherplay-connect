---
'@etherplay/connect-core': minor
'@etherplay/connect': minor
---

Pre-generate a second signature at derivation time, `savedDelegationSignature`, authorizing the derived session signer to act onchain on the account's behalf.

`deriveOriginAccount` already pre-generated `savedPublicKeyPublicationSignature`, which authorizes the signer's public key to receive encrypted messages. This adds a sibling in the same style, over the new `originDelegationMessage(origin, signer.address)`, so a contract can verify "account A delegates to signer S" and attribute S's transactions to A. It is a separate message rather than a reuse of the existing one because a user who authorized a key so that "others can use this key to write encrypted messages to you securely" has not thereby authorized a key that spends gas and posts in their name: different risk, different consent, different text.

It has to be pre-generated. A hosted account (email / OAuth) holds its key at the wallet host, not in the app, and no live arbitrary-signing capability is exposed, so sign-in is the only moment this signature can be produced. The registration transaction is submitted and paid for by a different wallet, so the account itself never needs gas or a wallet: it signs, somebody else submits.

Two details are consensus rather than style, because the verifying contract reproduces them literally:

- the delegate is the signer's **address**, not its public key, and it is rendered **lowercase**. The lowercasing happens inside `originDelegationMessage` rather than at the call site, so no caller can hand it an EIP-55 checksummed spelling (which is what viem returns) that then fails to verify onchain.
- the message wording is fixed. `test/origin-delegation.test.ts` pins the exact bytes; changing them invalidates every signature ever generated and has to happen on both sides at once.

The signature carries no nonce, index, expiry, chainId or contract address, because it asserts a permanent fact rather than a scoped authorization. The signer is derived as `keccak256(sign(originKeyMessage(origin)))` through a mnemonic, and ECDSA signing is deterministic (RFC 6979), so the same account on the same origin always derives the same signer, on every device and after any storage wipe. There is exactly one delegate per account per origin and it can never legitimately change, so replay is harmless: it re-asserts something already true, and the value forwarded in the registration transaction comes from the submitter, so a replayer spends their own gas to change nothing. Each omitted field would also require knowledge the host does not have at sign-in, turning one permanent signature into a stream it cannot generate. The accepted consequence is that one signature is valid on every chain and in every contract implementing the scheme, which is what its text says. Revocation is handled onchain by a withdrawal flag the account sets itself.

`originKeyMessage` is untouched, and the new signature is purely additive: it does not feed back into the derivation. Both facts are pinned by tests, because any change there re-derives every existing user onto a different signer address, orphaning funds and onchain state attached to the old one with no migration path.

On the wallet mechanism the field is `undefined`, matching `savedPublicKeyPublicationSignature`: the connected wallet is live and can sign the same message on demand. `originDelegationMessage` is re-exported from `@etherplay/connect`.
