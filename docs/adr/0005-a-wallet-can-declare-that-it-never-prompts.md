# A wallet can declare that it never prompts, and an app can bring its own

Status: accepted

## The rules

1. **A wallet says whether it asks the user anything.** `WalletInfo.autoApproves` sits beside the wallet's name and icon. Absent means it prompts, which is what every wallet this library discovers does and what every wallet UI ever written assumes.
2. **`@etherplay/connect` acts on that declaration in exactly one way: it does not announce a `PendingRequest` for such a wallet.** Neither on `connection.pendingRequests` nor through `connection.onRequest`. Nothing else in the flow changes.
3. **An app can supply the wallets a connection is about** (`wallets: WalletHandle[]`), which replaces discovery for that connection. Bringing a wallet does not require subclassing a connector.

## What happened

A consumer built an app with a second WORLD: a chain that runs in the browser tab (webevm) with a wallet it generates itself, alongside the app's ordinary remote chain. It builds a second `createConnection` for that world. Two things in this library were wrong for it, and both are about TYPES rather than behaviour: the library did the right thing and could not be told, or asked, the right thing.

**It could not hand over the wallet.** `createConnection` had one source of wallets, EIP-6963 discovery on `window`, so the app subclassed `EthereumWalletConnector` and overrode `fetchWallets` to announce exactly one handle. The subclass inherited `createAlwaysOnProvider` and `accountGenerator` unchanged: a class whose entire content was a list.

**It could not say that the wallet is silent.** The world's wallet holds its own key, signs with no dialog, and has exactly one account. Every "your wallet is asking you something" surface in the app was therefore wrong: a connect prompt for a wallet that cannot refuse, an account picker over one account, and a modal reading "your wallet will ask you to confirm it in a moment" when nothing would ever ask. The app's workaround was to mount no wallet UI at all on that route. That is right for the route and wrong as a general answer, because the fact is not the app's to know: it has to be re-derived, identically, by every consumer that renders such a surface.

## Why the declaration lives on `WalletInfo`

Because it is the same kind of fact as the name and the icon: something only the wallet knows, which every consumer would otherwise infer. Inference is not available here in any case. A generated in-tab key and a browser extension expose the same provider surface, and the app can only tell them apart by knowing which one it constructed, which is knowledge no shared UI component has.

It is also the reason this is not a `createConnection` setting. A connection can hold several wallets, and "does this wallet prompt" is a property of each one, not of the connection: a list containing both an embedded wallet and MetaMask must answer differently per entry. A setting would force the app to be right about the wrong unit.

### `autoApproves`, not `prompts`

Polarity was the only real decision. The field has to default to the loud behaviour, so the question is which spelling makes the safe reading also the natural one.

`autoApproves` is the exceptional claim, so `if (info.autoApproves)` is correct when the field is missing, which it will be for every wallet in existence except the handful an app constructs. `prompts` inverts that: the common case becomes the value nobody writes, and `!info.prompts` reads "never prompts" about every ordinary wallet. The mistake would be silent, and its symptom would be a wallet UI that never appears.

`walletPrompts(info)` is exported for the other direction, so consumers that prefer the positive question do not each re-derive the default.

## Why the library stops announcing, and what that costs

`pendingRequests` is the answer to "is something outstanding with your wallet right now". ADR 0001 exists because that list going quiet during a real prompt left users holding a wallet popup the app believed did not exist. The mirror image is this one: the list speaking for a wallet that asks nobody anything. Consumers render it as a modal, a cancel affordance and an unload guard, and all three describe an event that does not occur.

Nothing can be outstanding with a wallet that answers synchronously, so the honest list is the empty one.

**Where the suppression lives.** At the connection, not in the always-on wrapper. The wrapper's bookkeeping is what tells a request's start from its end, and it is per connector, so silencing there would have to be implemented again by every connector that ever exists. The connection is the surface that CLAIMS a user is being asked, so it is the surface that stops claiming it. `getPendingRequests()` on the wrapper is unchanged and still complete.

**When the decision is made.** Once, when the request starts, and then remembered by id. A request can outlive the wallet state that started it (ADR 0001, "Known limit"): the user may switch wallet while one is outstanding, and the request stays with the wallet actually holding it. So "was anybody ever going to be asked about this" is a fact about the wallet that TOOK the request, not about whichever wallet is current when it ends. Deciding again at the end would erase a prompt that is genuinely on a user's screen, and that is the ADR 0001 bug reached by a new route. Both directions are pinned in `test/auto-approving-wallet.test.ts`.

**Both answers are recorded, not just the silencing one.** The store's own subscription and every consumer subscription ask the same function, and the store's one calls `set` in between, which runs consumer subscribers synchronously: the live wallet is therefore reachable for change while the remaining handlers have yet to ask. Nothing reachable today flips it in that window (every wallet registration sits after an `await`, and the one synchronous mutation a subscriber can cause, `teardownWallet`, moves the answer toward "not silenced"), but a half-silenced request is exactly the split this feature exists to avoid: announced on `pendingRequests` and absent from `onRequest`, or the reverse. Recording the negative answer too makes the order irrelevant instead of merely harmless, which is the difference between an invariant and a coincidence.

**The declaration is read from the handle that was CHOSEN, not looked up from the provider.** `_wallet` carries the chosen handle's `info`. The alternative, scanning `connection.wallets` for the provider, treats provider identity as a wallet identity, and it is not one: a caller supplying two handles over the same provider object (the same in-tab chain under two names, a reused test double) makes the scan answer with whichever comes first. A wrong name is cosmetic; inheriting the wrong handle's `autoApproves` would hide a prompt the user is looking at. The scan survives only as the fallback for a provider this library did not register itself, and it answers with NOTHING when the match is ambiguous, so an unsure lookup fails toward the loud default.

**Both halves or neither.** `connection.onRequest` is filtered by the same decision, because a consumer handed the END of a request whose START it never saw is being asked to close a dialog it never opened.

**The cost.** A consumer that used `pendingRequests` as a general activity indicator (a spinner, a metric) sees nothing for such a wallet. That is accepted: the list has one meaning, it is about the USER being asked, and an app that wants to know what its own provider is doing has `connection.provider` and knows what it sent. It is also opt-in twice over, since only a wallet an app constructed can make the declaration at all.

### Considered and rejected

**Telling the wrapper, through a new `AlwaysOnProviderWrapper` method.** It would make "does not announce" literally true at the source. Rejected on two counts: `AlwaysOnProviderWrapper` is an interface others implement, so even an optional method is a thing every connector must reimplement to get a fix that is not connector-specific; and the call would have to be made at each of the eight sites that register a wallet on the wrapper, where missing one gives a connection that announces for a silent wallet with nothing to catch it. The connection already knows which handle a provider came from, in one place.

**Letting the app pass a flag to `createConnection` instead.** Wrong unit, as above.

**Acting on the declaration elsewhere in the flow** (skipping `WaitingForSignature`, auto-requesting the sign-in signature, suppressing the account picker for a one-account wallet). Deliberately not done. Each is a behaviour change with its own reasoning, and the declaration is new: an app can already reach all three through `requestSignatureAutomaticallyIfPossible`, `useCurrentAccount` and its own rendering. Rule 2 says exactly one thing so that what this field does stays legible.

## Why supplied wallets replace discovery

`wallets` is not only a convenience that removes a subclass. A wallet an app constructs is not a member of the same population as the extensions a user installed: it belongs to ONE connection, whereas EIP-6963 is page-wide by design, with any code able to make every installed wallet re-announce itself to every listener. Discovering the world's wallet from `window` would conflate those populations in both directions, and no consumer can un-conflate them afterwards, because `WalletHandle` does not say where a handle came from.

So supplying the list says which population this connection is about, and discovery is not run at all: no `eip6963:requestProvider` is dispatched and no announcement is listened for. An app that wants both runs two connections (which `storagePrefix` already supports) or supplies a list containing both.

**An EMPTY list is still a supplied list.** `wallets: []` is a connection about no wallets, not a connection that falls back to discovery. `wallets: maybeList ?? []` and `wallets: list.filter(...)` are ordinary things for a caller to write, and reading `[]` as "never mind, take the page's" would enrol every installed extension into a connection meant to be kept to itself, silently, which is precisely the conflation this setting exists to prevent. The other reading fails loudly instead: an empty picker, visible immediately. Discovery is asked for with `undefined`, which is also what omitting the key means.

Discovery remains the default, untouched, for every caller that supplies nothing.

`walletConnector` stays what it was for: a DIFFERENT CHAIN FAMILY, where the provider type, the always-on provider and the account derivation all change together. Replacing a list was never that, and the subclass that did it is the evidence.

## The settings object stopped discriminating

`walletConnector` used to select between two overloads per configuration: one requiring it, one requiring its ABSENCE. That made an ordinary optional setting into a discriminant, and the consumer hit all three failure modes of that: a settings object spread in with the key conditionally present matched neither overload, a value typed `WalletConnector<P> | undefined` matched neither, and `walletConnector: undefined` written out compiled while silently selecting the other overload.

Adding `wallets` as a second such discriminant would have shipped the same trap again, so the split was removed instead. The provider type is now a defaulted type parameter (`= UnderlyingEthereumProvider`) and both settings are ordinary optional ones: with nothing mentioning the provider type there is nothing to infer and the default applies, which is exactly what the removed overloads said, and with a connector, supplied wallets or a `chainInfo` carrying a `provider` it is inferred from those.

`targetStep` and `walletOnly` still select the overload, which is the split that carries a promise (`walletHost` is optional exactly when no popup can be reached, see ADR-adjacent `test/types/wallet-only-no-host.types.ts`). The new shape is pinned by `test/types/connection-settings.types.ts`, including the three call shapes above.

Both settings are spelled `?: T | undefined` rather than `?: T`. The two are identical under this repo's compiler settings and differ in a consumer's: with `exactOptionalPropertyTypes: true`, `?: T` rejects an explicitly passed `undefined`, which is the very shape an app normalising its options arrives at. A promise that holds only for apps sharing our tsconfig is not one, so it is spelled out. The flag cannot be enabled for this package yet: `src/index.ts` has unrelated violations of it (optional fields assigned `undefined` in state construction), and fixing those is its own change.

The one deliberate loosening: a `chainInfo.provider` whose type is not the Ethereum one now infers that type instead of failing, so a caller who pairs it with no connector gets a connection whose always-on provider is built by the Ethereum connector. That only reaches callers who were already misconfigured, and the alternative is keeping a discriminant whose failure mode is silent and reaches correct callers.

## Consequences

- `connection.wallet.info` now carries the handle's `info` (name, icon, `autoApproves`), stamped in `set` rather than supplied, for the same reason `pendingRequests` is: a fact every construction site must remember to copy is a fact in the wrong place. A consumer no longer matches `mechanism.name` against `wallets` to find out which wallet it is connected to. It is exact for every state this library builds, can be ABSENT when no announced handle owns the provider or the match is ambiguous, and can be one publish STALE on a state spread from a published one whose handle has since left the list.
- A new site that registers a wallet on the wrapper must say which handle it is registering: `_wallet` carries `info` as a required key (which may hold `undefined`), so the compiler asks.
- A connector that wants to announce an auto-approving wallet sets `autoApproves` on the `info` it announces. Nothing else in the connector interface changes.
- A new behaviour keyed on `autoApproves` needs its own entry here. Rule 2 is a list of one on purpose.
- `walletPrompts` is exported from both `@etherplay/wallet-connector` and `@etherplay/connect`. Consumers should use it rather than reading the field, so the default lives in one place.
