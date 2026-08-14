---
'@etherplay/connect-core': minor
'@etherplay/openfort': patch
---

Carry the declared permissions through the OAuth round trip.

Signing in with Google is a full page load: the popup navigates away and comes back as a NEW document that remembers nothing, so everything it needs has to be in the callback URL. `permissions` was not, so the returning popup parsed no request at all. It asked for nothing, granted nothing and reported nothing, and the app received an account with no credentials AND no outcomes explaining them, which is precisely the "nobody asked" versus "you declined" ambiguity the per-entry outcomes exist to remove.

It failed only on OAuth. The same app asking for the same delegation by email worked, which is why this survived: the feature looked implemented, and one mechanism silently dropped it.

The shape that allowed it is fixed too. The callback URL was assembled by hand-concatenating one string fragment per parameter, so adding a parameter to the popup URL and forgetting it here produced no error anywhere. It is now `buildOAuthCallbackUrl` in `@etherplay/connect-core`, with `CARRIED_THROUGH_OAUTH` naming what survives in one place, and tests covering it. It lives in core rather than in the Openfort provider because what it encodes is the popup URL contract, written by `@etherplay/connect` and read by the host, not anything about Openfort.

Values are encoded rather than interpolated. Origins, a JSON permissions document and a public key were being concatenated raw, and a value containing `&` or `#` stops being one parameter and becomes several.
