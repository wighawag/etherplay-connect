---
'@etherplay/connect-core': minor
'@etherplay/openfort': minor
'@etherplay/connect': patch
---

Mnemonic sign-in becomes a provider of its own, and leaves the Openfort one.

**BREAKING for `@etherplay/openfort`, and it breaks at RUNTIME rather than at type-check.** The
`AuthProvider` shape is unchanged, so a third party calling `connect({type: 'mnemonic', ...})` on
this provider still compiles and now throws, with a message naming `createLocalProvider` as the
replacement and the routing decision that goes with it. `minor` is the right bump because the
version is `0.x`, where `^0.3.1` does not admit `0.4.0`: nobody receives this by upgrading in
place. The host in this repo moves in lockstep.

`createLocalProvider` (in `@etherplay/connect-core`) derives an account from a mnemonic in the
browser: no publishable key, no vendor SDK, no network. It is a MOVE, not a copy:
`@etherplay/openfort` no longer implements the mnemonic mechanism and throws a message naming where
it went, so a vendor SDK is no longer constructed on a path that never called it.

Two provider-agnostic rules move into `connect-core` with it, where they are one implementation
under test rather than one per host or per provider:

- `originApprovalRequired`, the gate deciding what must be settled before a result may be handed to
  the opener. Both providers call it directly.
- `describeOriginMismatch`, which compares the origin a result will be DELIVERED to against the
  origin the opener is really at, and describes the difference. That mismatch is the one failure in
  this system with no error anywhere: the sign-in completes in the popup and the browser silently
  drops the result.

The host picks the provider by MECHANISM. `?provider=` therefore narrows in meaning to "which
HOSTED provider for email and OAuth"; `@etherplay/connect` still forwards it from
`VITE_AUTH_PROVIDER` on every popup URL, unchanged, and it is never required for a mnemonic
sign-in.
