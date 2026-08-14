---
'@etherplay/connect-core': minor
'@etherplay/openfort': minor
'@etherplay/connect': minor
---

Refuse cross-origin account requests by default, and let a signing origin opt in.

A page passing `signingOrigin` asks for the account of an origin that is not itself, which is the whole of that account's authority there. That was answered by one prompt naming two domains, and a prompt is the wrong instrument: nothing on that screen tells the person whether the two sites belong together, so the click carries no information. The wallet host now decides it, and the decision defaults to no.

The reason default-deny is affordable now is delegation, which authorizes MANY delegates at a contract. A third-party site can bring its own origin signer and have the user register it onchain, which costs a transaction and in exchange gives that site authority that is bounded to the contract, separately revocable, and not a copy of somebody else's signer. Refusing is therefore no longer refusing the use case.

A signing origin that wants to be requested says so in the host's `CROSS_ORIGIN_ALLOWLIST`, either by naming requesters or with `'*'`. Consent makes the request ASKABLE, not granted: the human is still asked, and under `'*'` (or the loopback allowance below) they are asked twice, because nobody vouched for the site in particular. A blocked request never derives, signs or delivers anything.

Blocking is reported as `{type: 'cross-origin-blocked', windowOrigin, signingOrigin}` rather than as a cancellation, and the popup's refusals now reach the app instead of being swallowed on the way back to `Idle`. An app cannot offer the right remedy without that distinction: closing a popup is retried, a block is a misconfigured `signingOrigin` or a prompt to register a delegate onchain. Closing the popup stays silent, as before, and where a failed attempt comes to rest is unchanged; only the reason travels with it, so `ensureConnected` rejects with what happened instead of "Connection cancelled".

`OriginApprovalRequest.requestingAccess` is gone. It was the same two origins compared a second time, by a second rule, for a question `resolveAccess` is the only one allowed to answer.

Auto-signing follows the same rule. A pair may be minted with nobody in the loop cross-origin only when BOTH origins list it and the consent named the requester, since once access is granted the requester holds exactly the signer the signing origin holds, so the credential is one that origin's own flow would have minted. Under a wildcard the host knows nothing about who is asking, so nothing is auto-signed.

Local development pages (`http://localhost:*`, `127.0.0.1`, `[::1]`) can be admitted as requesters, but only by a development build of the host, or explicitly via `VITE_ALLOW_LOOPBACK_CROSS_ORIGIN`. A remote site cannot claim a loopback origin, so what the allowance admits is untrusted code the user runs locally, asking for their real account behind a prompt that reads harmless. The match parses the origin rather than looking for a substring, because `https://localhost.evil.example` is a domain anyone can register.

PUBLISH BEFORE DEPLOYING THE HOST. An app on an older `@etherplay/connect` talking to an updated host is told it was blocked and drops the reason on the way back to `Idle`, so the user sees "Connection cancelled" and is invited to retry something that cannot succeed. Ship the packages first, or accept that older clients read a block as a cancellation.

BREAKING for apps that pass a `signingOrigin` differing from their own origin: they now need an entry at the wallet host, or should drop the option and sign for themselves. This is a rule about what the HOST hands over, so it covers hosted accounts. In the wallet-only shape the page asks the user's own wallet to sign the origin message with no host in the loop, and the wallet's own dialog remains the only gate.
