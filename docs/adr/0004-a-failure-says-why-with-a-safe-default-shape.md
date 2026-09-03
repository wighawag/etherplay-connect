# A failure says why, and keeps the safe shape while it says it

Status: accepted

Extends `0003-ensure-connected-promises-a-target-and-always-answers.md`, which made `ensureConnected` always answer. This one is about the answers being **told apart**. Nothing here changes what any existing path does; it adds a field.

## The rule

**Every connection failure carries a `reason`: a closed union of string literals, on the `ConnectionFailure` a caller catches AND on the `connection.error` an app renders, with the same value for the same event.**

Three supporting rules make that checkable rather than aspirational:

- **The internal error type requires it.** `connection.error` is `{message, cause?, reason}` and `setConnectionFailure` / `setError` take exactly that, so the COMPILER enumerates the producers. Nothing has to be remembered by the next person to add a failure path.
- **The thrown failure COPIES the resting reason, never re-derives it.** One event, one label. Re-deriving from `message` or from `cause` at the throw site is how the banner and the caught error come to disagree.
- **One construction site.** All four `ConnectionFailure`s in `ensureConnected` go through one local `failWith(reason, message, cause?)` that takes the reason first. This codebase has twice fixed bugs whose root cause was an invariant maintained at N call sites instead of one (`pendingRequests`, wallet teardown, both in `work/notes/observations`); this is the third such invariant and it gets one site from the start.

## Why

`ensureConnected` answers, but several of its answers were indistinguishable from outside. Four `new ConnectionFailure(...)` sites, two of which passed a `cause`, so consumers classified by the ABSENCE of a cause, because that was the only signal there was.

The cost lands precisely where ADR-0003's value was: the settle guarantee's own answer ("the connection is at X and nothing is in progress") arrived looking exactly like "the user closed the dialog", which every consumer maps to "say nothing". **The hang ADR-0003 removed came back as a silent no-op** rather than as a reported outcome, which gives away most of the fix at the last step.

Downstream, a consuming app carries a module whose whole job is recovering intent this library already knew: it sniffs `cause` for host refusal shapes, falls back to matching message text, and its own comment admits that `could not get any accounts` aliases onto the cancellation branch. Every consumer that cares writes that module, and each gets it differently wrong. The library is the only place that knows, so it is the only place that can say.

## Decisions, and what was rejected

### `reason`, not `code`

`ConnectionFailure.code` is taken: it carries the EIP-1193 code copied off `cause`. The two answer different questions ("what did the wallet say" versus "what happened to my call") and both are worth having, so the new one gets its own name rather than overloading a field consumers already switch on.

### The safe default keeps its shape; the discriminant says which one it is

The open question this change was asked to settle: how should an acknowledged `addressUnavailable` be told apart from the user closing the connect dialog?

**By the discriminant, and not by the shape.** `message` stays `'Connection cancelled'` on both, exactly as ADR-0003 left it. That shape is what every consumer already maps to "the user chose not to", so keeping it means every existing refusal path stays correct, untouched, and nobody paints a red error over a decision. Making the dismissal a distinct _shape_ would have changed behaviour on a path that is currently right, to fix a problem that is one field wide.

The same logic runs the other way for the answers that were WRONGLY safe: `unreachable` and `superseded` keep the honest `could not reach ...` message they already had, and now carry a reason that stops a consumer filing them under "the user decided".

### The host's vocabulary is passed through, not modelled

"A required permission was declined by the host" was on the requested list of members. It is not in the union.

The wallet host is deployed separately and chooses its own words. This library can verify exactly two refusal types: `'cancelation'`, which its own popup raises (`src/popup.ts`), and `'cross-origin-blocked'`, minted by `@etherplay/connect-core` in this repo (`src/access.ts`). Everything else arrives as an arbitrary `{type, message}` the host picked, on a schedule this package does not control.

So known types are mapped and everything else passes through as `host-refused` with the host's own `type` intact on `cause`. A member per host word would be a claim this package cannot check, it would go stale the day the host shipped a new one, and the false confidence is worse than the missing member: a consumer that switches on `reason === 'permission-denied'` and silently never matches is harder to debug than one told to read `cause.type`. The README says exactly that, and says what to read instead.

### Members added beyond the brief, and one left out

Added: **`wallet-rejected` (4001)** and **`wallet-unavailable` (4100)**, because they are the most common failures in this library and consumers already sniff `err.code === 4001` for the first. Without them, the downstream module this change exists to delete only half goes away, which is most of the value gone. Added: **`no-accounts`**, cited in the brief as the case that aliases onto cancellation in a real consumer, and the honest description of "the wallet answered, with nothing" — it looks like a refusal from outside and is not one.

Left out: a member for **a wallet name that matches nothing announced** (a typo, an extension uninstalled between render and click). It lands on `failed` with a message naming the wallet. It is verifiable, unlike the host types, so this one is a judgement rather than a principle: it is not a state the user can answer in a dialog, no consumer sniffs for it today, and the catch-all exists precisely so that a cause with no distinct remedy needs no member. If a consumer turns out to want "that wallet is not installed" as its own branch, it can be added exactly as the forward-compatibility rule below describes.

### Forward compatibility: the union may grow in a minor, so keep a `default`

Stated rather than left implicit, because it is a real trade with a real cost on the consumer's side.

A union the type system can exhaust is what makes `reason` worth more than a string. The cost is that adding a member later breaks an exhaustive `switch` with no default. Both halves are taken deliberately:

- **the union ships closed**, so a consumer gets completion and exhaustiveness today;
- **new members may appear in a MINOR version**, because a reason this library cannot yet tell apart is a reason it may learn to tell apart, and holding those back for a major would mean shipping known-wrong labels for months;
- **`failed` is a catch-all**, so most future causes need no new member at all, and anything that does get one was indistinguishable from a generic failure before it existed: nobody's working branch changes meaning, a case merely moves out of `default`;
- **consumers are told, in the README, to keep a `default` branch.**

The alternative, a plain `string`, was rejected: it makes every consumer invent its own constants and gives back the string-matching this change exists to delete.

### Supersession is registered, not inferred

The one part of this that is not plumbing. ADR-0003 already established that a connection has one wallet, one account and one `addressUnavailable` slot, so a second `ensureConnected` naming a different address supersedes the first, and that the older call is answered honestly rather than as a cancellation the user never made.

That answer could not be LABELLED from the connection state, and no amount of looking harder would have helped: the newer request takes the slot with it, so what the older call sees at the moment it is answered is exactly what it would see if the target were genuinely unreachable. The distinguishing fact lives in another call, not in the state.

So `createConnection` keeps a small registry of live address-bound requests, mirroring the per-address acknowledgement map beside it: a monotonic id per call, released when the call settles. An older call that comes to rest with nothing in progress is `superseded` when a LATER live request names a DIFFERENT address, and `unreachable` otherwise. Ordered ids rather than a set, because the question is ordered; per address rather than per count, because two calls for the SAME account do not compete for the slot and neither supersedes the other.

The distinction is worth the ten lines because the remedies differ: `superseded` means retry, it was your own app's doing, where `unreachable` means this connection cannot get there from here and a retry mostly repeats itself.

**What the label actually asserts, stated exactly**, because the honest version is weaker than "the newer request displaced me": it asserts that a later live request names another account. If some third thing (the app's own `connect()`, a disconnect) ends both at once, the older is still labelled `superseded`. That is an over-approximation in the harmless direction, since the newer request was going to take the slot anyway and the remedy the label implies is the same. The opposite error cannot happen by construction: a call that resolves without ever waiting returns before it registers, so it never claims a slot it did not need.

One consequence of releasing on settle rather than on displacement: an entry lives exactly as long as its promise is unsettled, so an abandoned call holds one map entry for as long as it holds the promise. The registry is bounded by the pending calls themselves.

**Not proven by a test, and said so in the code:** deleting the release leaves the whole suite green. For it to change an observable label, a NEWER address-bound call would have to settle while an OLDER one stays live, and every way a newer call can settle publishes a state that also ends an older call resting on it, while an older call still waiting is waiting on something in progress that publishes again in its turn. That is an argument, not a test, and the comment at the release site says as much rather than claiming coverage it does not have.

## Consequences

- **Additive.** `message`, `cause` and `code` are unchanged on every path, including `'Connection cancelled'` for an acknowledged `addressUnavailable`. A consumer that ignores `reason` behaves exactly as before.
- **A type-level requirement inside the library.** `connection.error` now requires `reason`, so any new code that sets an error must say which failure it is. That is the enforcement, and it is why the field was put on the internal type first rather than only on the thrown failure.
- **`ConnectionFailure`'s third constructor argument is optional**, defaulting to `'failed'`, so a consumer (or a test double) that constructs one keeps compiling. Inside the library it is never defaulted: one site supplies it always.
- **The settle enumeration checks the labelling, within a measured limit.** `test/ensure-connected-settles.test.ts` asserts that every rejection the matrix produces carries a reason from the set, that a `cancel()` produces exactly `cancelled`, and that it saw at least 100 rejections do it — the last because a check that runs zero times passes, and this suite has shipped two assertions that held against broken code. The limit, measured rather than assumed: of the 180 combinations, 66 resolve and all 114 rejections come from this test pressing `cancel()`, so the population is one reason deep. It is therefore NOT a safety net that catches a new failure path shipping unlabelled — an earlier version of that comment claimed it was, and counting the reasons is what disproved it. Each of the ten members is pinned individually in `test/failure-reasons.test.ts`, which is where a new path needs its own test.
- **The exhaustiveness of the vocabulary is pinned by `tsc`, not by the runtime suite.** `tsconfig.types.json` deliberately excludes `test/**/*.test.ts` and vitest transpiles without type-checking, so a type-level guard written in a `.test.ts` file is inert. It lives in `test/types/failure-reason.types.ts`, where adding, renaming or removing a member fails `pnpm test:types` — and where the consumer's side of the promise (an exhaustive `switch` reaching `assertNever`) is compiled too.
- **Consumers can delete their error-classification module**, which is the point. What is left that this library cannot answer is telling one host refusal from another, and that is `cause.type`, documented as such.
