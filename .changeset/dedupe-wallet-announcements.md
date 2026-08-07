---
'@etherplay/connect': patch
'@etherplay/wallet-connector-ethereum': patch
---

Deduplicate EIP-6963 wallet announcements so several connections in one page are safe.

EIP-6963 discovery is page-wide. Unless a `walletConnector` is passed in, each `createConnection` builds its own connector, which attaches an `eip6963:announceProvider` listener and dispatches `eip6963:requestProvider`. Two connections constructed close together overlap in that window: the second one's request makes every installed wallet announce itself again while the first is still listening, and the first appended the repeat. With exactly one wallet installed, `connection.wallets` ended up with two entries for the same `info.uuid`, which took the `wallets.length > 1` branch and stopped the flow at a `WalletToChoose` picker listing that wallet twice, with the entry button degraded from "Connect \<WalletName\>" to "Connect a Wallet".

Announcements are now deduplicated on `info.uuid`, falling back to `info.rdns` for wallets that regenerate their uuid. This is done where the list is built in `@etherplay/connect`, so it holds for any connector, and also inside `createWalletFetcher` in `@etherplay/wallet-connector-ethereum`, so the connector never records the same wallet twice either. Creating any number of connections is safe by default, with no need to share an `EthereumWalletConnector` between them.

Unchanged, and still a known limitation: the Ethereum connector stops listening for announcements 100 ms after construction, so a wallet that announces later is not listed.
