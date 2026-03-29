# @etherplay/connect

## 0.0.48

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.9

## 0.0.47

### Patch Changes

- allow provide nodeURL different from chainInfo (for wallets)

## 0.0.46

### Patch Changes

- 46e8b4e: fixes

## 0.0.45

### Patch Changes

- useCurrentAccount

## 0.0.44

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.8

## 0.0.43

### Patch Changes

- Updated dependencies [1b727a2]
  - @etherplay/wallet-connector-ethereum@0.0.7

## 0.0.42

### Patch Changes

- 331f862: implement tx/signature wallet request
- Updated dependencies [331f862]
  - @etherplay/wallet-connector-ethereum@0.0.6
  - @etherplay/wallet-connector@0.0.5

## 0.0.41

### Patch Changes

- 9e89c58: connect-core and remove alchemy dependencies of @etherplay/connect

## 0.0.40

### Patch Changes

- bumo

## 0.0.39

### Patch Changes

- 5dcb07c: unified account WalletConnected + SignedIn

## 0.0.38

### Patch Changes

- AnyConnectionStore

## 0.0.37

### Patch Changes

- walletOnly auto chose wallet type on connect

## 0.0.36

### Patch Changes

- better support for wallet-only connections

## 0.0.35

### Patch Changes

- allow to pass a provider instead of an http endpoint
- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.5
  - @etherplay/wallet-connector@0.0.4
  - @etherplay/alchemy@0.0.15

## 0.0.34

### Patch Changes

- support different origin
- Updated dependencies
  - @etherplay/alchemy@0.0.14

## 0.0.33

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.4

## 0.0.32

### Patch Changes

- fix ChainInfo, make it readonly

## 0.0.31

### Patch Changes

- use viem chainInfo

## 0.0.30

### Patch Changes

- export UnderlyingEthereumProvider

## 0.0.29

### Patch Changes

- Updated dependencies
  - @etherplay/wallet-connector-ethereum@0.0.3
  - @etherplay/wallet-connector@0.0.3
  - @etherplay/alchemy@0.0.13

## 0.0.28

### Patch Changes

- support multiple blockchain wallet
- Updated dependencies
  - @etherplay/alchemy@0.0.12
  - @etherplay/wallet-connector@0.0.2
  - @etherplay/wallet-connector-ethereum@0.0.2

## 0.0.27

### Patch Changes

- debug pass through
- Updated dependencies
  - @etherplay/alchemy@0.0.11

## 0.0.26

### Patch Changes

- watch for lock + unlock

## 0.0.25

### Patch Changes

- alwaysUseCurrentAccount auto switch account

## 0.0.24

### Patch Changes

- keep updating accounts list

## 0.0.23

### Patch Changes

- cancel remove last wallet

## 0.0.22

### Patch Changes

- try catch some connection error

## 0.0.21

### Patch Changes

- handle timeout + signature rerequest

## 0.0.20

### Patch Changes

- update deps
- Updated dependencies
  - @etherplay/alchemy@0.0.10

## 0.0.19

### Patch Changes

- ensureConnect WalletConnected option type

## 0.0.18

### Patch Changes

- ensureConnected

## 0.0.17

### Patch Changes

- fix settings

## 0.0.16

### Patch Changes

- 40a0c5c: accounts list choice

## 0.0.15

### Patch Changes

- locked/disconnected

## 0.0.14

### Patch Changes

- save last wallet + disconnected support for metamask

## 0.0.13

### Patch Changes

- show invalid chain as long as we get wallet connected

## 0.0.12

### Patch Changes

- Updated dependencies
  - @etherplay/alchemy@0.0.9

## 0.0.11

### Patch Changes

- requestSignatureAutomaticallyIfPossible + unlock + better handling of web3 wallet + fixes

## 0.0.10

### Patch Changes

- provide a always on provider + allow switching chain on wallet provider
- Updated dependencies
  - @etherplay/alchemy@0.0.8

## 0.0.9

### Patch Changes

- add wallet provider + chainId
- Updated dependencies
  - @etherplay/alchemy@0.0.7
