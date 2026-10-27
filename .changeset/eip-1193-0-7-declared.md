---
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': minor
---

**eip-1193 0.7, declared as a dependency.** `@etherplay/wallet-connector-ethereum` publishes types that import `eip-1193` (`EIP1193WindowWalletProvider`, `EIP1193ChainId`, `Methods`), but listed it only as a devDependency, so an app type-checked them against whichever eip-1193 its package manager happened to hoist, and broke as soon as something else (webevm 0.9, through `@eip-1193/over-port`) brought 0.7 in. It now depends on `eip-1193` `^0.7.3` directly. Apps can drop the `packageExtensions` entry they added for it.

The types move to the eip-1193 0.7 model, which is why this is a minor:

- `UnderlyingEthereumProvider` (re-exported by `@etherplay/connect`, and the default wallet provider type of `createConnection`) is still `CurriedRPC<Methods>`, but `Methods` is now eip-1193 0.7's browser-wallet surface. Request and result types follow 0.7. What a consumer is most likely to hit: `eth_signTypedData` (v1) is typed `[typedData, address]`, the reverse of what 0.6 said; `wallet_switchEthereumChain` and `wallet_addEthereumChain` resolve with `null`; `net_version` returns a decimal `string`; and the node-only and pre-merge methods (`eth_getProof`, `eth_syncing`, `eth_coinbase`, `net_listening`, `net_peerCount`, `eth_protocolVersion`, `eth_mining`, `eth_hashrate`, the uncle methods) are no longer in the table.
- `EthereumWalletProvider`'s constructor takes eip-1193 0.7's `EIP1193WindowWalletProvider`.

One runtime fix that follows from the corrected type: the account announced with a pending `eth_signTypedData` (v1) request is now read from its second parameter, where v1 puts it. It was read from the first, which holds the typed data, so the account was dropped.
