---
'@etherplay/connect-core': minor
'@etherplay/connect': minor
---

Answer a permission declaration on the wallet path, and add `getDelegation` for signing one on demand.

`permissions` is honoured by the host at sign-in, because a hosted account holds its key there and sign-in is the only moment a credential can be minted for it. A wallet-owned connection has no such constraint and no host to reach, so a declaration on one was a no-op: the app got `savedDelegations: []` and no outcomes, which reads as "nobody asked" when it did ask. That is exactly the ambiguity the per-entry outcomes exist to remove, and it is now closed from both ends.

The types refuse a declaration where nothing could honour it: `permissions` is gone from the `walletOnly: true` overloads, and was never on `targetStep: 'WalletConnected'`. A compile error beats a promise nothing keeps. Pinned in `test/types/permissions.types.ts`.

The types cannot cover the mixed case, where the app can reach a host but the user picks the injected wallet, so that case answers at runtime instead of ignoring: every declared entry comes back as `{granted: false, reason: 'sign-on-demand'}`, a new outcome reason meaning nothing was pre-generated because this owner is a live signer that can be asked at the moment of use. It is not a refusal, and it is distinguishable from `denied` and from never having asked, so the app calls `getDelegation` rather than offering a pointless re-prompt.

`getDelegation({chainId, contract, deadline?})` is the one call for both shapes: a stored credential for a hosted account, a live wallet signature for a wallet one. It mirrors `getSignatureForPublicKeyPublication`, which already branches the same way over the sibling message. It returns the whole `SavedDelegation` record rather than the signature alone, because a signature is unusable without the exact `delegate` and `deadline` it was made over, both of which are inside the signed bytes; that also makes it interchangeable with `findSavedDelegation`. On a hosted account a stored credential only answers a request naming the same deadline it was signed with, and a missing one throws, since the remedy there is to sign in again rather than anything the app can do from the page.

Consent at the point of use is worth more than consent at the door, so for a live wallet this is the better shape outright, not a fallback.
