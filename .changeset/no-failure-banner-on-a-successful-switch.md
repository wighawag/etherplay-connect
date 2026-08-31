---
'@etherplay/connect': patch
---

Stop reporting a failure after a chain switch that succeeded.

`switchWalletChain` set `error: 'Failed to switch to <chain>'` on the connection before throwing, and that throw lands in the function's own `catch`, which recovers by adding the chain through `wallet_addEthereumChain`. When the add succeeded, the recovery path spread `...$connection` on its way out and carried the stale error with it, so the user ended up on the requested chain with a banner saying it had failed. Consumers render `error` as exactly that.

The rule now: whoever gives up sets the error, and nothing sets one on the way past. A non-null result from `wallet_switchEthereumChain` is still a failure rather than a value, and is still reported by throwing, which is what triggers the recovery.

The give-up branch also keeps what the wallet actually said as `error.cause`. `Chain "X" is not available on your wallet` is this library's summary, reached both from a refusal and from a wallet reporting its error as a result, and the underlying reason used to be dropped.
