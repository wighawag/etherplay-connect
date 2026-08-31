---
'@etherplay/wallet-connector': minor
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': minor
---

Announce the two wallet signatures that opened a popup nobody could see.

`getDelegation` and `getSignatureForPublicKeyPublication` signed through `_wallet.provider`, one level above `alwaysOnProviderWrapper`. The wrapper is what tracks in-flight wallet requests, so `onRequest` never fired for them and `wallet.pendingRequests` stayed empty for their whole duration. Both now go through the wrapper, which makes the consumer logic that already reads `pendingRequests` correct rather than adding a second mechanism beside it. **Consumers get this on the version bump with no code change.**

The symptom was worst on the request that deserved it least. In reveal-or-die, pressing "Buy an avatar" opened MetaMask asking for a signature with no dialog, no explanation, and no way to tell what had asked, because jolly-roger decides whether to show its "Wallet Action Required" modal from `wallet.pendingRequests`. For a signature that grants a browser key authority to act for the user's account, an unexplained popup is exactly the shape a phishing prompt takes, and a careful user is right to refuse it.

The gap was incidental rather than designed. `plans/rpc-request-tracking.md` decided not to track the `signMessage` path because it "already has its own `WaitingForSignature` step", which was true of `_requestSignature`, its only caller at the time. Two functions written later inherited that exemption without inheriting the step, so they were covered by nothing at all. The rule is now written down in `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: every request that reaches the user's wallet goes through the wrapper, so that it is observable, because a request the user must answer and the app cannot see is one nothing can explain, cancel, or recover from.

**New: `AlwaysOnProviderWrapper.signMessage(message, account, {purpose})`.** A dedicated surface rather than a call through the generic `provider.request` path, for two reasons that are invisible from the call site. The generic path refuses signing methods when the wallet is on a chain other than the connection's, but `getDelegation` is explicitly allowed to mint a credential for another chain (`{chainId: 31337}` on a chain-1 connection is supported and tested), so it would have rejected correct requests. And `@etherplay/connect` is chain-agnostic over `WalletProviderType`, so it cannot build a `personal_sign` call itself. Delivery is byte-for-byte what `EthereumWalletProvider.signMessage` did: routing a signature through it changes who can see it and nothing else.

**New: `PendingRequest.purpose`**, `'delegation' | 'public-key-publication'`, optional. `kind: 'signature'` only supports "your wallet is asking for something", and the reported problem was a user who could not tell what had asked. Absent means the app asked directly through `connection.provider`, where it already knows what it sent. `PendingRequest`, `RequestEvent`, `RequestEventHandler` and `RequestPurpose` are now re-exported from `@etherplay/connect`, so a consumer naming the request does not need a second dependency.

Sign-in is deliberately unchanged and remains the one exception: `requestSignature` keeps signing through `_wallet.provider` and keeps `step: 'WaitingForSignature'` as its signal. Announcing it here as well would open two modals at once in consumers that render a dialog from that step and another from `pendingRequests`, which jolly-roger does. The ADR records that if `WaitingForSignature` is ever removed, sign-in moves onto the wrapper in the same change, and a test pins it meanwhile.

Implementers of `AlwaysOnProviderWrapper` outside this repo must add `signMessage`. The bundled Ethereum connector and the test doubles in this repo are updated.
