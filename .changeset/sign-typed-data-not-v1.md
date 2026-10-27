---
'@etherplay/wallet-connector-ethereum': patch
'@etherplay/connect': patch
---

**`eth_signTypedData` is read as `[address, typedData]` again, not as the legacy V1 order.** 0.2.0 started reading the account of a pending `eth_signTypedData` request from its second parameter, following eip-1193 0.7's V1 typing. V1 is not what callers send, so with the usual `[address, typedData]` the announced request lost its account. This restores the 0.1.x behaviour. The legacy V1 shape is not supported.
