---
'@etherplay/wallet-connector': minor
'@etherplay/connect': minor
---

An app can BRING its own wallet, and a wallet can declare that it NEVER PROMPTS.

**This is additive.** No existing setting, state or behaviour changes: a caller that supplies neither gets today's library exactly. Discovery is still the default, and a wallet that says nothing about prompting is still treated as one that prompts.

## `wallets`: hand the connection the wallets it is about

```typescript
const world = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: {id: 31337, name: 'World', provider: worldChainProvider},
	storagePrefix: 'world:',
	wallets: [{info: {uuid: 'world:1', name: 'World Wallet', icon: '', rdns: 'io.example.world', autoApproves: true}, walletProvider}],
});

await world.ensureConnected(); // one wallet, so no picker is ever shown
```

`createConnection` could only DISCOVER wallets, over EIP-6963 on `window`, so an app with a wallet of its own (a chain running in the tab with a generated key, a burner signer, a custodian over RPC, a test double) had to subclass its connector and override `fetchWallets` to announce a single handle, inheriting `createAlwaysOnProvider` and `accountGenerator` unchanged. **Delete that subclass.**

**Supplying `wallets` replaces discovery for that connection**: no `eip6963:requestProvider` is dispatched, no announcement is listened for, and `connection.wallets` is exactly your list. That is the point rather than a side effect. A wallet your app constructed belongs to ONE connection, while EIP-6963 is page-wide, and conflating the two populations is not something a consumer can undo afterwards. To offer both, run two connections (each with its own `storagePrefix`) or pass a list containing both.

`wallets: []` means "no wallets", NOT "discover some": an empty list is still a supplied list, because `wallets: maybeList ?? []` is an ordinary thing to write and falling back to discovery there would quietly enrol every extension in the page into a connection you meant to keep to itself. Pass `undefined`, or omit the key, to ask for discovery.

`walletConnector` is unchanged and remains what it was for: a different CHAIN FAMILY, where the provider type, the always-on provider and account derivation change together.

## `autoApproves`: a wallet that asks the user nothing

```typescript
info: {uuid, name, icon, rdns, autoApproves: true}
```

`WalletInfo.autoApproves` says there is no dialog to wait for. **Absent means it prompts**, which is every wallet discovered over EIP-6963. Read it with the exported `walletPrompts(info)` so the default is not re-derived per consumer.

**The library acts on it in exactly one way: it announces no `PendingRequest` for such a wallet.** `connection.pendingRequests` stays empty and `connection.onRequest` emits nothing for it, because that list means "your wallet is holding something and is waiting for you", and nothing can be outstanding with a wallet that answers synchronously. A modal saying "your wallet will ask you to confirm this in a moment" is describing an event that never happens, and previously every consumer had to re-infer that from a fact only the wallet knows. The decision is made when a request STARTS and kept for its lifetime, so switching wallet mid-request neither silences a prompt that is on the user's screen nor announces one that never was.

Nothing else in the flow changes: the connect flow, `WaitingForSignature` and the account picker behave as they do for any other wallet. `requestSignatureAutomaticallyIfPossible`, `useCurrentAccount` and your own rendering remain the controls, and `walletPrompts` is how you decide. Reasoned through in `docs/adr/0005-a-wallet-can-declare-that-it-never-prompts.md`.

If you consume `pendingRequests` as a general activity indicator rather than as "the user is being asked", note that it now reports nothing for such a wallet. That is the intended meaning of the list; your own provider calls are yours to track.

## `connection.wallet.info`

The connected wallet state now carries the `info` of the handle it came from (name, icon, `autoApproves`), stamped by the library. "Which wallet am I connected to" and "does it ask the user anything" no longer require matching `mechanism.name` against `connection.wallets` by hand.

## `walletConnector` and `wallets` do not select an overload

`walletConnector` used to discriminate between two `createConnection` overloads, one requiring it and one requiring its absence. That made three ordinary call shapes fail or misfire: a settings object spread in with the key conditionally present matched NEITHER overload, a value typed `WalletConnector<P> | undefined` matched neither, and `walletConnector: undefined` written out compiled while silently selecting the other one.

Only `targetStep` and `walletOnly` select an overload now, so all three shapes compile and mean what they look like, and `wallets` did not arrive as a second such trap:

```typescript
createConnection({...base, walletConnector: maybeConnector});
createConnection({...base, walletConnector: undefined});
createConnection({...base, ...(useCustom ? {walletConnector} : {})});
```

The provider type is inferred from whatever mentions it (`walletConnector`, `wallets`, or a `chainInfo` carrying a `provider`) and defaults to `UnderlyingEthereumProvider` when nothing does, which is exactly what the removed overloads said. `walletHost` is still required precisely when a popup is reachable. Both settings are declared `?: T | undefined`, so the explicit-`undefined` form also compiles in an app using `exactOptionalPropertyTypes: true`. One deliberate loosening: a `chainInfo.provider` of a non-Ethereum type now infers that type instead of failing to match, which can only reach a caller who was already pairing it with the wrong connector.
