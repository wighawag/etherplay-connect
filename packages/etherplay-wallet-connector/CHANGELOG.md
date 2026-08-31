# @etherplay/wallet-connector

## 0.1.0

### Minor Changes

- 6acb51a: Announce the two wallet signatures that opened a popup nobody could see.

  `getDelegation` and `getSignatureForPublicKeyPublication` signed through `_wallet.provider`, one level above `alwaysOnProviderWrapper`. The wrapper is what tracks in-flight wallet requests, so `onRequest` never fired for them and `wallet.pendingRequests` stayed empty for their whole duration. Both now go through the wrapper, which makes the consumer logic that already reads `pendingRequests` correct rather than adding a second mechanism beside it. **Consumers get this on the version bump with no code change.**

  The symptom was worst on the request that deserved it least. In reveal-or-die, pressing "Buy an avatar" opened MetaMask asking for a signature with no dialog, no explanation, and no way to tell what had asked, because jolly-roger decides whether to show its "Wallet Action Required" modal from `wallet.pendingRequests`. For a signature that grants a browser key authority to act for the user's account, an unexplained popup is exactly the shape a phishing prompt takes, and a careful user is right to refuse it.

  The gap was incidental rather than designed. `plans/rpc-request-tracking.md` decided not to track the `signMessage` path because it "already has its own `WaitingForSignature` step", which was true of `_requestSignature`, its only caller at the time. Two functions written later inherited that exemption without inheriting the step, so they were covered by nothing at all. The rule is now written down in `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`: every request that reaches the user's wallet goes through the wrapper, so that it is observable, because a request the user must answer and the app cannot see is one nothing can explain, cancel, or recover from.

  **New: `AlwaysOnProviderWrapper.signMessage(message, account, {purpose})`.** A dedicated surface rather than a call through the generic `provider.request` path, for two reasons that are invisible from the call site. The generic path refuses signing methods when the wallet is on a chain other than the connection's, but `getDelegation` is explicitly allowed to mint a credential for another chain (`{chainId: 31337}` on a chain-1 connection is supported and tested), so it would have rejected correct requests. And `@etherplay/connect` is chain-agnostic over `WalletProviderType`, so it cannot build a `personal_sign` call itself. Delivery is byte-for-byte what `EthereumWalletProvider.signMessage` did: routing a signature through it changes who can see it and nothing else.

  **New: `PendingRequest.purpose`**, `'delegation' | 'public-key-publication'`, optional. `kind: 'signature'` only supports "your wallet is asking for something", and the reported problem was a user who could not tell what had asked. Absent means the app asked directly through `connection.provider`, where it already knows what it sent. `PendingRequest`, `RequestEvent`, `RequestEventHandler` and `RequestPurpose` are now re-exported from `@etherplay/connect`, so a consumer naming the request does not need a second dependency.

  Sign-in is deliberately unchanged and remains the one exception: `requestSignature` keeps signing through `_wallet.provider` and keeps `step: 'WaitingForSignature'` as its signal. Announcing it here as well would open two modals at once in consumers that render a dialog from that step and another from `pendingRequests`, which jolly-roger does. The ADR records that if `WaitingForSignature` is ever removed, sign-in moves onto the wrapper in the same change, and a test pins it meanwhile.

  Implementers of `AlwaysOnProviderWrapper` outside this repo must add `signMessage`. The bundled Ethereum connector and the test doubles in this repo are updated.

- a9f3ff2: Stop erasing a wallet request that is still outstanding, and say who must answer it.

  Every wallet-state rebuild in `createConnection` asserted `pendingRequests: []`. That erased an outstanding request **permanently**, because the store's mirror of the list is only written on request events and the next event for that request is the one that ends it, which writes an empty list too. Nothing ever put it back, so the user was left holding a wallet popup the app believed did not exist. All nine sites now read `alwaysOnProviderWrapper.getPendingRequests()`, which is authoritative.

  The triggering flow is an ordinary one rather than an exotic one: **a send against a locked wallet raises the connection flow**, so `connect()` runs while the wallet is still holding the transaction and rebuilds the state underneath it. Confirmed from a real locked-Rabby session, where the app reported `step: WalletConnected`, `wallet.status: connected`, `pendingRequests: 0` and its own dispatch count at `1` with a transaction genuinely in flight, and now reproduced in `test/announced-requests.test.ts`.

  The wallet event handlers were never at fault: `onChainChanged` and `onAccountChanged` spread the existing wallet state and preserve the list. Only the paths that build a wallet object from scratch (`connect`, `restoreWalletChosenAfterFailedConnect`, `selectWallet`) dropped it.

  Downstream this cost more than a missing modal. jolly-roger built a parallel `$inFlight.dispatching` ledger that its wallet-action modal, its escape hatch and its unload guard all consult, because all three went silent when the list was emptied. That ledger still earns its place (it also covers sends signed by a local signer, which no wallet is asked about), but the reason it had to outrank `pendingRequests` is now gone.

  **New: `PendingRequest.account`**, the address expected to answer: the signer of a signature, the `from` of a transaction. Now that the list survives a rebuild, a request can outlive the wallet state it started under, and the user is free to switch wallet or account while one is outstanding. "Something is pending" therefore has to be answerable with "pending for whom", or a consumer will tell the user to approve in whichever wallet is current, which after a switch cannot answer it. Read per method rather than positionally, because `personal_sign` takes `[data, address]` and `eth_sign` takes `[address, data]`, the reverse; each branch is shape-checked, so an unreadable request loses the address and keeps the announcement rather than reporting a confident wrong answer.

  Known limit, recorded in ADR-0001: the list is not per-wallet, so a request outstanding against a wallet the user has switched away from is still reported, under the new wallet's state. `account` makes that detectable. The wrapper does not mark or drop such a request, and if it ever does it should mark rather than drop, since dropping would resurrect the erasure bug in a narrower form.

## 0.0.5

### Patch Changes

- 331f862: implement tx/signature wallet request

## 0.0.4

### Patch Changes

- allow to pass a provider instead of an http endpoint

## 0.0.3

### Patch Changes

- wip: fuel connector

## 0.0.2

### Patch Changes

- support multiple blockchain wallet
