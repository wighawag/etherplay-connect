---
'@etherplay/wallet-connector-ethereum': minor
'@etherplay/connect': minor
---

**eip-1193 0.7, declared as a dependency.** `@etherplay/wallet-connector-ethereum` publishes types that import `eip-1193` (`EIP1193WindowWalletProvider`, `EIP1193ChainId`, `Methods`), but listed it only as a devDependency, so an app type-checked them against whichever eip-1193 its package manager happened to hoist, and broke as soon as something else (webevm 0.9, through `@eip-1193/over-port`) brought 0.7 in. It now depends on `eip-1193` `^0.7.3` directly. Apps can drop the `packageExtensions` entry they added for it.

The types move to the eip-1193 0.7 model, which is why this is a minor:

- `UnderlyingEthereumProvider` (re-exported by `@etherplay/connect`, and the default wallet provider type of `createConnection`) is still `CurriedRPC<Methods>`, but `Methods` is now eip-1193 0.7's browser-wallet surface. Request and result types follow 0.7 (for example `wallet_switchEthereumChain` resolves with `null`, and node-only methods such as `debug_*` are not in the table).
- `EthereumWalletProvider`'s constructor takes eip-1193 0.7's `EIP1193WindowWalletProvider`.

No runtime change.
