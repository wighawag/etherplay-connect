---
'@etherplay/connect': minor
---

Add `targetStep: 'WalletChosen'` — let the user pick a wallet via EIP-6963 and read through its provider without going through the connect/accounts flow.

## What this adds

A new `TargetStep: 'WalletChosen'` and a new `selectWallet(name?: string)` method on the connection store. When the user picks a wallet, the wallet's provider is set on the always-on wrapper so reads route through it (when `prioritizeWalletProvider` is true), but **no accounts are requested** and **signing is refused** (status: `'disconnected'`). The wallet is in the `WalletChosen` step — chosen but unconnected.

The motivating consumer is a blockchain indexer that only calls `eth_chainId`, `eth_blockNumber` and `eth_getLogs`: it wants the user's own wallet as its node (a genuinely decentralised read path) but has no need for accounts or signing, so requiring `eth_requestAccounts` is friction that buys nothing.

## How a consumer opts in

```typescript
import {createConnection} from '@etherplay/connect';

const connection = createConnection({
	targetStep: 'WalletChosen',
	chainInfo,
	prioritizeWalletProvider: true, // route reads through the wallet
	autoConnect: true, // restore the last choice on reload
});

// Let the user pick a wallet (or auto-select if only one is installed):
await connection.selectWallet();

// Reads now route through the wallet's provider:
const blockNumber = await connection.provider.request({method: 'eth_blockNumber'});

// Signing is refused with code 4001:
// await connection.provider.request({method: 'personal_sign', ...}); // → rejected

// Later, if the user wants to sign (upgrade to WalletConnected):
await connection.connect({type: 'wallet'});
```

## Design decisions

**New `TargetStep` rather than just setting the provider at selection time.** The state machine needs a new resting point (`WalletChosen`) between `WalletToChoose` and `WalletConnected`. None of the existing steps fit: `WalletConnected` requires `account: {address}`, which we don't have. The new step gives the consumer a clean `isTargetStepReached` and auto-connect that restores the choice without requesting accounts.

**`prioritizeWalletProvider` controls read routing, unchanged.** When `true`, all reads route through the wallet (the decentralised read path). When `false`, reads fall through to the configured endpoint and the wallet is only used for signing (rejected when not connected). The concern about bulk `eth_getLogs` backfill through a relay (Coinbase Wallet relays over wss) is a consumer-level performance decision: a consumer who wants identity reads through the wallet but bulk reads through the configured endpoint can use the wallet's provider directly for identity reads and the always-on provider for bulk reads. Introducing a third routing mode would be a side effect, not a deliberate design.

**Disconnecting must not silently deselect.** If the user upgrades from `WalletChosen` to `WalletConnected` (by calling `connect()`) and the connection fails (e.g., the user rejects the accounts prompt), the `WalletChosen` state is restored — the wallet provider stays set and reads keep routing through it. The choice is not thrown away. `disconnect()` still fully clears the wallet (including the persisted choice) and transitions to `Idle`; that is the explicit "I don't want any wallet" action.

**Signing is still refused when not connected.** The existing rejection with code 4001 for signing methods on an unconnected wallet is unchanged.

## Real-wallet verification

MetaMask, Rabby and Coinbase Wallet all allow `eth_chainId` and `eth_getLogs` from an unconnected EIP-6963 provider without prompting. Only account-revealing methods (`eth_accounts`, `eth_requestAccounts`) and signing methods require authorization. The feature is viable for all three wallets.

## Picker guidance

With several wallets installed, `selectWallet()` (or `ensureConnected()`) lands on `WalletToChoose`. On a WalletChosen-target store, wire that picker's handler to `connection.selectWallet(name)`, not `connection.connect({type: 'wallet', name})` — `connect` is the deliberate **upgrade** path and pops `eth_requestAccounts`, the friction this feature exists to remove. (An upgrade still satisfies the target; it is just not what a read-path user clicked for.)

## Review fixes folded in

- **Failed upgrade keeps routing.** The WalletChosen-restore path in `connect()` now re-registers the wallet on the provider wrapper and the chain watcher, and restores the wallet that was CHOSEN — even when the failed upgrade targeted a different one. An early failure (`eth_chainId` throwing mid-upgrade) used to restore a `WalletChosen` state that had silently stopped routing reads through the wallet and stopped tracking its chain, and a late failure on a DIFFERENT wallet used to leave that wallet as the read path: a refused accounts prompt on wallet B must not silently move the read path the user had chosen on wallet A.
- **Empty accounts answer restores too.** A wallet answering `eth_requestAccounts` with `[]` restores `WalletChosen` — exactly like a rejected prompt — instead of dropping the choice.
- **No wallet routing outside wallet-bearing states.** `cancel()`, `back()`, failure rests and auto-connect failures now tear the live wallet down (provider unregistered, signing refused, watchers stopped). Before, an `Idle`/picker state could keep reads — and, with a previously connected wallet, even signing — routed through a wallet the state no longer showed.
- **`ensureConnected` typing.** The WalletChosen store overloads now expose `ensureConnected('WalletChosen', mechanism?, options?)` and declare the honest `Promise<ChosenOrBetter>` resolution (a wallet already connected or signed in satisfies the lower target).
- **Persistence consent.** `selectWallet(name, {doNotStoreLocally: true})` keeps the choice out of storage, matching `connect()`; an unknown wallet name reports the error on the current state without throwing an existing choice away.
