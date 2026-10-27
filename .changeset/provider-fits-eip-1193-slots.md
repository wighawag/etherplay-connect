---
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': minor
---

**`connection.provider` fits eip-1193 0.7 provider slots.** `UnderlyingEthereumProvider`, the provider a connection and its wallets hand out, was remote-procedure-call's `CurriedRPC<Methods>` alone. remote-procedure-call types `request` without distributing a method whose table entry is a union (`eth_getBlockByNumber` with `false` or `true`, for example), which eip-1193 0.7 does, so that type was not assignable to any eip-1193 0.7 provider type: passing `connection.provider` to `@etherkit/tx-observer`'s `createTransactionObserver({provider})`, or to any other slot typed `EIP1193CoreProvider`, failed to compile. It is now `CurriedRPC<Methods> & EIP1193WalletProvider`, so it fits `EIP1193CoreProvider` and `EIP1193WalletProvider` slots, and a type test pins that.

A minor because the type is narrower where an app supplies one: a `WalletHandle` or `walletConnector` typed with a bare `CurriedRPC<Methods>` now needs the `UnderlyingEthereumProvider` type. The `endpoint` of `createProvider` still takes a URL or a bare `CurriedRPC<Methods>`. No runtime change.
