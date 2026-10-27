---
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': patch
---

**`UnderlyingEthereumProvider` is a plain `CurriedRPC<Methods>` again**, on remote-procedure-call `^0.2.0`, whose request typing is eip-1193 0.7's, so it still fits `EIP1193CoreProvider` and `EIP1193WalletProvider` slots (the type test in `@etherplay/connect` pins it). The `EIP1193WalletProvider &` half added in 0.3.0 is gone, and so is its cast.

The `endpoint` of `createProvider` and the connector's `createAlwaysOnProvider` now takes a URL or any object with an async `request` (remote-procedure-call's `RequestEndpoint`), so any EIP-1193 provider works there whatever method table it is typed with.

A minor because remote-procedure-call 0.2 removed the untyped `request({method: string, ...})` catch-all overload from `CurriedRPC`: a call to a method outside `Methods` through `connection.provider.request` now needs `callUnknown`, an extended table, or eip-1193's `EIP1193GenericRequestProvider`. Every published package now ships a LICENSE file (MIT, as declared).
