---
'@etherplay/connect-core': minor
'@etherplay/connect': minor
---

Stop persisting the origin account's entropy key, and strip it from storage that already has it.

`OriginAccount.signer.mnemonicKey` held `originKey`, which is not one derived key: it is the entropy the entire origin account is derived from. The session signer is index 0 of the mnemonic built from it, and every other key that origin could ever derive is index 1, 2, 3 and onward. The whole account object is written to both `localStorage` and `sessionStorage` at the app's origin, so anything that got at an app's storage (an XSS, a hostile extension, a malicious front-end build) walked away with the seed rather than with the single key the session was actually using.

The field is REMOVED, not deprecated. A deprecated field is one that keeps being written, and being written to disk is the entire problem: a `@deprecated` tag would have left every future sign-in producing the same seed at rest while telling readers not to mind. Nothing read it, in this repo or in the apps built on it, so there is nothing to migrate to. `originKey` is still computed at both derivation sites, since the mnemonic and the account come from it; it is now local to those functions and never leaves them.

Removing the writes does nothing for the users who already have a seed on disk, which is the half that carries the security, and it does nothing about the other direction an account arrives from: the wallet host popup, which is deployed independently of the version an app ships and can still be running an older `deriveOriginAccount`. An app on this version talking to a host that has not been redeployed would otherwise receive an account still carrying the entropy key and write it straight into both storages, planting a fresh seed at rest from the release that removed it.

So the cleanup is in three places. Every connection strips both storages in place at construction, which is what reaches apps that pass `autoConnect: false` and therefore never read their stored account at all. `saveOriginAccount` strips whatever it is handed, so nothing carrying entropy is ever persisted whoever produced it: an invariant about the storage rather than a statement about today's call sites. And the popup result is stripped as it arrives, so the account handed to the APP is clean too, whether or not it is remembered.

The storage cleanup needs no version flag, since the field's presence is the trigger, and it is idempotent: a clean account is left byte-identical with no write at all. Each storage is cleaned WHERE IT LIES rather than by reading one and re-saving both. The two do not expire together (Safari's ITP evicts `localStorage` after seven days of no interaction while an open tab keeps its `sessionStorage`), so a cleanup that wrote both from one of them would resurrect an account into a storage it had already left. It stays behind the same `typeof window` guard as the rest, so SSR and prerender construction remains storage-inert.

This also matters ahead of any key-rotation or kill-switch work. Rotation is defeated in advance if the seed it is meant to rotate away from is sitting in the same storage the attacker just read, because the rotated keys derive from it too.

BREAKING for any consumer reading `account.signer.mnemonicKey`: the field is gone from the type and from the object at runtime, including for sessions restored from storage written by an older version. A consumer that needs to sign for the origin should use `signer.privateKey`, which is what signing has always used. Nothing that needed the entropy itself exists; if something did, it would have been holding the ability to derive keys the session was never granted.
