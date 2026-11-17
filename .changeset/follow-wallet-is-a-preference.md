---
'@etherplay/connect': patch
---

With `useCurrentAccount`, following the wallet to another account no longer fails when the user moves again before the follow has read the wallet's accounts. The follow demanded the address it started for, so switching to B and straight back to A ended with no account and no wallet while the wallet sat on A. It now treats that address as a preference and connects to whatever the wallet offers by then. An explicit `connectToAddress` still demands its address.
