---
'@etherplay/connect': minor
---

A connection failure now says WHY, in a closed vocabulary you can switch on: `reason`.

**Delete your error-classification module.** If your app has one that sniffs `cause` for host refusal shapes, matches on message text, or decides "this was a cancellation" from the ABSENCE of a `cause`, that is now the library's job and it does it from the inside, where the answer is actually known. The one thing left for you is telling one wallet-host refusal from another, and that is `cause.type` (see below).

**This is ADDITIVE.** `message`, `cause` and `code` are unchanged on every single path, including `'Connection cancelled'` for an acknowledged `addressUnavailable`. Code that ignores `reason` behaves exactly as it did today. Nothing is deprecated and nothing moved.

`ConnectionFailure.reason` is one of:

| `reason`                           | What happened                                                              | What to do                                                |
| ---------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `cancelled`                        | the user closed or dismissed the connect flow                              | nothing: they decided                                     |
| `address-unavailable-acknowledged` | the user acknowledged an `addressUnavailable` instruction                  | nothing: also a decision                                  |
| `superseded`                       | a newer `ensureConnected` naming a different address took the account slot | retry if you still want it: your app asked for two things |
| `unreachable`                      | came to rest, nothing in progress, nothing can be initiated                | **report it**: this is an outcome, not a silent no-op     |
| `wallet-rejected`                  | the wallet prompt was declined (EIP-1193 4001)                             | offer a retry                                             |
| `wallet-unavailable`               | the wallet cannot authorise accounts (4100)                                | retrying will not help: unlock or configure the wallet    |
| `no-accounts`                      | the wallet answered with an empty account list                             | report it: it looks like a refusal and is not one         |
| `cross-origin-blocked`             | the wallet host refused a cross-origin request                             | offer the onchain delegate path, not another popup        |
| `host-refused`                     | the wallet host refused for a reason of its own                            | show `message`; read `cause.type` to tell refusals apart  |
| `failed`                           | anything else, with the underlying error on `cause`                        | show `message`, offer a retry                             |

**The same field is on `connection.error`**, which your app renders, and for one event the two carry the same value: the thrown failure copies the resting error's reason rather than re-deriving it, so the banner and the caught error cannot tell the user different stories. Internally the field is REQUIRED on the connection's error type, so the compiler enumerates every producer instead of leaving the next one to remember.

**The two dismissals are told apart by `reason`, not by shape.** An acknowledged `addressUnavailable` still carries `message: 'Connection cancelled'`, exactly as `cancel()` does, so every "a refusal maps to cancelled" path you already wrote stays correct and nobody paints a red error over a decision the user made deliberately. The opposite case is the one that changes what you can do: `unreachable` and `superseded` were already reported honestly (`could not reach ...`) but were indistinguishable from each other and from a cancellation-shaped no-op, so the hang the previous release removed was arriving as silence.

**`superseded` is new information, not just a new label.** Nothing recorded it before: a connection has one wallet, one account and one `addressUnavailable` slot, so a second `ensureConnected` naming a different address supersedes the first, and the first saw exactly what it would have seen if the target were genuinely unreachable. It is now detected from a per-connection registry of live address-bound requests.

**Wallet-host refusals are passed through, deliberately.** The host is deployed separately and picks its own vocabulary, so only the types this library can verify are mapped (`cross-origin-blocked`, from `@etherplay/connect-core`, and its own popup's cancellation). Anything else is `host-refused` with the host's own `type` left intact on `cause`: read `(err.cause as {type?: string})?.type`. Inventing a member per host word would be a claim this package cannot check.

**New members may appear in a MINOR version, so keep a `default` branch.** A union the type system can exhaust is worth having and that is its price. `failed` is a catch-all, so most future causes will need no new member at all, and anything that does get one was indistinguishable from a generic failure before it existed. The trade is written down in `docs/adr/0004-a-failure-says-why-with-a-safe-default-shape.md`.
