---
'@etherplay/connect-core': minor
'@etherplay/connect': minor
'@etherplay/openfort': minor
---

Add the Same-Origin Callback Bridge (domain-redirect fallback) for the OAuth-redirection flow.

When a popup-based OAuth login severs the `window.opener` relationship (due to COOP headers or cross-scheme redirects), the popup can no longer reach the parent via `postMessage` or a same-origin `BroadcastChannel`. This adds a robust, 100% client-side fallback: the popup redirects one final time to a static bridge page (`_etherplay_accounts.html`) served on the parent's own origin, which delivers the result via `window.opener.postMessage` (often re-established once same-origin) or `BroadcastChannel`.

- `@etherplay/connect-core`: new zero-dependency Web Crypto helpers (ECDH P-256 + AES-GCM) used to encrypt the credential exchange that transits the URL hash fragment.
- `@etherplay/connect`: new opt-in `domainRedirectBridge` config flag on `createConnection`. When enabled, the SDK generates an ephemeral ECDH keypair, threads its public key through the redirect chain, and decrypts the result on either transport (window `message` or `BroadcastChannel`). Delivery is opportunistic: the direct opener path is used when the link survives, the encrypted bridge only as a fallback.
- `@etherplay/openfort`: the `domain-redirect-public-key` param is now carried through the Openfort `redirectTo` URL so it survives the full-page OAuth round-trip.

Integrators opting in must host `_etherplay_accounts.html` at `/_etherplay_accounts.html` on their app's origin. When the bridge is disabled (the default), behavior is unchanged.
