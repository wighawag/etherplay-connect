# @etherplay/wallet-connector-ethereum

## 0.0.12

### Patch Changes

- e75e69a: Deduplicate EIP-6963 wallet announcements so several connections in one page are safe.

  EIP-6963 discovery is page-wide. Unless a `walletConnector` is passed in, each `createConnection` builds its own connector, which attaches an `eip6963:announceProvider` listener and dispatches `eip6963:requestProvider`. Two connections constructed close together overlap in that window: the second one's request makes every installed wallet announce itself again while the first is still listening, and the first appended the repeat. With exactly one wallet installed, `connection.wallets` ended up with two entries for the same `info.uuid`, which took the `wallets.length > 1` branch and stopped the flow at a `WalletToChoose` picker listing that wallet twice, with the entry button degraded from "Connect \<WalletName\>" to "Connect a Wallet".

  Announcements are now deduplicated on `info.uuid`, falling back to `info.rdns` for wallets that regenerate their uuid. This is done where the list is built in `@etherplay/connect`, so it holds for any connector, and also inside `createWalletFetcher` in `@etherplay/wallet-connector-ethereum`, so the connector never records the same wallet twice either. Creating any number of connections is safe by default, with no need to share an `EthereumWalletConnector` between them.

  Unchanged, and still a known limitation: the Ethereum connector stops listening for announcements 100 ms after construction, so a wallet that announces later is not listed.

## 0.0.11

### Patch Changes

- fix

## 0.0.10

### Patch Changes

- fix walletFetcher being a module level var that keep old conncetion

## 0.0.9

### Patch Changes

- stop listening eip6963 after 100ms

## 0.0.8

### Patch Changes

- assume if 693 events are emitted, then window.ethereum is not needed

## 0.0.7

### Patch Changes

- 1b727a2: support wallet that use window.ethereum but not ERC-6963

## 0.0.6

### Patch Changes

- 331f862: implement tx/signature wallet request
- Updated dependencies [331f862]
  - @etherplay/wallet-connector@0.0.5

## 0.0.5

### Patch Changes

- allow to pass a provider instead of an http endpoint
- Updated dependencies
  - @etherplay/wallet-connector@0.0.4

## 0.0.4

### Patch Changes

- global wallet fetcher

## 0.0.3

### Patch Changes

- wip: fuel connector
- Updated dependencies
  - @etherplay/wallet-connector@0.0.3

## 0.0.2

### Patch Changes

- support multiple blockchain wallet
- Updated dependencies
  - @etherplay/wallet-connector@0.0.2
