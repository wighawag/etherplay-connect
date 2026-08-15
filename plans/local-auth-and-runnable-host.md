# A local auth provider, and a host you can run yourself

**Status**: steps one to three built and unit-tested; step four not started, and until it is, none of this is known to work in an adopter's hands.

**Amendments made while building, recorded here so the next reader does not think they were oversights:**

- **The local provider went into `@etherplay/connect-core`, not a package of its own** (Scope, below, says "one new provider package"). Everything it needs is already in `connect-core`, so it adds no dependency there, and it is consumed by exactly one thing, the host, which ships as a prebuilt bundle rather than as a source dependency. A separate package would mainly be a second version to keep in lockstep, and skew between the two produces two copies of the derivation in one tree, which is the failure this plan invokes as its reason for making mnemonic a MOVE rather than a copy.
- **The provider-agnostic approval gate moved too.** `approvalRequired()` is now `originApprovalRequired` in `connect-core`, called by both providers, rather than copied into the new one. The plan calls it provider-agnostic; a second copy of a gate that has already drifted once between paths was not worth having.
- **The build flag is `import.meta.env.MODE === 'development'`, not `import.meta.env.DEV`.** Vite pins `NODE_ENV=production` for every `vite build`, so `DEV` is false even under `--mode development`, and the two artefacts came out byte for byte identical.
- **The published artefact is `@etherplay/dev-wallet-host`**, and which build a directory holds is answered by a `build-info.json` the build emits, not by grepping the bundle.

Scope: `web/login` (the host), `packages/etherplay-openfort`, one new provider package, and one new published artefact. `@etherplay/connect` changes only in documentation. Adopters (`jolly-roger`, `template-commit-reveal`) are consumers, and the last step of this plan is one of them proving it works.

**This is a development service first, and a test fixture second.** The shape to copy is the faucet: something a developer starts alongside their app, so the sign-in flow is there while they work, and which their e2e run also starts because it is the same thing. Building it as a test-only artefact would produce something exercised once per CI run and never used by a person, which is how a fixture drifts from the product it stands in for. A host a developer looks at every day does not drift.

Follows on from the delegation work: `@etherplay/delegation` 0.1.0, `@etherplay/connect-core` 0.3.0 and `@etherplay/connect` 0.4.0, and everything the hosted side of it gained since.

## The problem

The hosted half of the delegation design has never been executed end to end, anywhere.

Credentials minted at sign-in, the permission section with its per-entry outcomes, approval enforced by withholding the result, and the app-side routes that follow from all three (`pre-signed`, `re-authorise`, and the `sign-on-demand` outcome) exist on both sides and are unit-tested on both sides. No test drives them together. `jolly-roger`'s e2e builds wallet-only, pinning `PUBLIC_WALLET_HOST` empty, so the paths it covers end to end are exactly the ones a WALLET owner takes: the live signature, and nothing else.

That is the wrong half to have covered. The wallet path can be asked to sign again at any moment, so its failure modes are recoverable and visible. The hosted path mints a credential once, at a moment the user cannot return to, and every one of its failure modes is silent: a credential for the wrong pair, a deadline that does not match, an approval that was reported but not honoured. None of them throws. They produce a signature that recovers a different address, or a result the app never receives.

The same gap is felt daily rather than only in CI. A developer working on anything downstream of sign-in today needs either a deployed host or a checkout of this monorepo, so the ordinary local loop stops at the wallet path and the hosted one is something you go and set up specially. Every app in this ecosystem already solves this shape for money, by running a faucet locally; sign-in deserves the same treatment.

Two things stand in the way, and neither of them is the mechanism:

1. **The host can only construct one provider.** `createAuthProvider` (`web/login/src/lib/handler.ts`) throws for anything but `openfort`, so a test needs a vendor SDK and a publishable key on the path, even though the mnemonic mechanism uses neither.
2. **The host is a static site configured at build time.** Serving it is trivial; obtaining one configured for somebody else's test is not, because `VITE_*` values and the allowlist tables are baked into the bundle.

## What is decided

### Mnemonic is not hosted authentication, and leaves the Openfort provider

It is already local in everything but where it lives. The branch in `packages/etherplay-openfort/src/index.ts` uses `settings.accountGenerator`, `mnemonicToEntropy` and `approvalRequired()`, and touches `openfortInstance` nowhere. `approvalRequired()` is itself provider-agnostic: two origins, the declared permissions, and `normalizeOrigin` from `connect-core`. `provideMnemonicIndex` re-enters `connect`. The account it produces has a fabricated user (`orgId: 'mnemonic'`, `userId: '<index>@mnemonic.id'`), which is the clearest statement available that there is no Openfort-side account behind it.

So it moves into a provider of its own, named `local` rather than `mnemonic`: what defines it is that the key comes from this browser and no service, and a later local mechanism belongs in the same place.

**A MOVE, not a copy.** `@etherplay/openfort` loses the branch rather than delegating to the new one. Delegation would be a Middle Man that also drags a dependency the wrong way, and it would leave the vendor SDK constructed on a path that does not use it. Two implementations of one derivation is the failure the delegation package was created to end, and it is not worth reintroducing here for a forwarding call.

### The host routes by mechanism, not by a deployment-wide setting

`?provider=` is chosen by the APP, once, at the app's build time: `@etherplay/connect` reads its own `VITE_AUTH_PROVIDER` and appends it to every popup URL, for every mechanism. So "ask for `provider=local` when you want mnemonic" is not available to an app that also wants email or OAuth, which is every app that has both. `jolly-roger` has exactly that shape today.

The alternative, letting `connect` pick the parameter per mechanism, puts host implementation knowledge into the client library, where every third-party client would have to reproduce it and drift from it.

So the host routes. `state.ts` already computes `mechanism` from `?type=` before it calls `createAuthProvider`, and that is where the decision goes: mnemonic to the local provider, everything else to the configured hosted one.

`?provider=` therefore narrows in meaning, to "which HOSTED provider for email and OAuth". It is still honoured as an explicit value, it is simply never required for mnemonic. Say so where it is read, and where `connect` forwards it.

The local provider still has to satisfy `AuthProvider`, so `provideEmail`, `provideOTP` and `confirmOAuth` throw with a sentence naming the reason. Narrowing the interface would touch every consumer for no gain today; see "Parked".

### Two artefacts from one source, and the difference is not cosmetic

The host that holds real accounts keeps every value baked at build time. The development host takes its configuration at runtime.

The reason is the one `allowlist.ts` already argues for itself: hardcoding is the safer end of the design because there is no runtime fetch to poison, and an allowlist entry mints credentials with no human in the loop. Making that table runtime-injectable in the artefact that holds real accounts would undo that argument in one line. The repo already has the pattern for a capability that must not travel into production, in `ALLOW_LOOPBACK_REQUESTERS`, which shouts when it finds itself in a non-dev build rather than quietly allowing itself.

So: one source, two builds, and the flag that marks the test build is the same flag that decides whether the runtime document is honoured at all. A production build that finds a configuration document ignores it and says so.

The development artefact is named so that nobody deploys it by accident. It is unfit for real accounts by construction, and that is the point: everything in it is injectable precisely because it holds nothing worth protecting.

It is one artefact for two jobs, deliberately. What a developer wants running next to their app and what an e2e run wants are the same thing configured the same way, and splitting them would mean a fixture nobody looks at standing in for a service everybody uses.

### The development host takes a runtime configuration document

A document (`config.json`, or a `config.js` setting one global) fetched at boot and merged over the baked defaults, rather than placeholder substitution over the built bundle. Substitution handles strings only and means rewriting minified JavaScript, and the most important knob here is the allowlist, which is an array of objects.

The work is small and countable: eight `import.meta.env` reads, across `handler.ts` (three), `allowlist.ts` (three) and `state.ts` (two), go through one `config.ts` that merges the document over the baked values. Nothing else in the host reads the environment.

What the artefact exposes: the hosted provider name, the dev mnemonic, the Openfort keys, the loopback flag, the origin allowlist, the cross-origin allowlist, and the two deadline lifetimes. The lifetimes matter as much as the allowlist: an auto-signed credential's deadline is the only lever an allowlist entry has once it turns out to be wrong, so a test that cannot set it cannot exercise expiry at all, and a developer who cannot shorten it cannot see expiry happen without waiting three months.

### Distribution is a published prebuilt bundle

An adopter adds a dependency, gets a version pinned in their lockfile, and serves a directory with whatever static server they already run. No build step, no publishable key, no sibling checkout, and no assumption that this repo is present on the machine. A `bin` that serves the directory is worth including for the same reason `faucet-server` has one: the adopter's dev script and CI script then say what they mean in one line.

This is the part that decides whether the plan is worth anything. A host that only works from a checkout of this monorepo serves this monorepo. The whole value is that somebody else, on their own machine and in their own CI, runs a real one.

### Scheme and origin: what running it over http actually costs

Almost nothing, and the thing that does bite is not the one people expect.

The ordinary flow is a popup plus `postMessage`, and neither needs a secure context. `http://localhost` and `http://127.0.0.1` are potentially trustworthy origins anyway, so even the APIs that do require one are available there. The only WebCrypto in the system is on the opt-in domain-redirect bridge (`generateEcdhKeyPair` in `@etherplay/connect`, and the encrypting half in `Login.svelte`), which a developer running locally has no reason to enable. So plain http is a supported configuration, not a compromise.

Two real edges, both worth writing into the artefact's documentation rather than discovering:

- **A LAN address is not localhost.** Serving with `--host` so a phone can reach `http://192.168.x.x` gives up secure-context status, and with it `crypto.subtle`. The popup flow still works; the domain-redirect bridge does not. If that path ever needs testing from a device, it needs https, which for a static bundle is a certificate concern and nothing else.
- **The origin must match exactly, and this is the one that wastes an afternoon.** The host posts its result with `targetOrigin: windowOrigin`, so `http` against `https`, or `127.0.0.1` against `localhost`, or the wrong port, produces a sign-in that visibly completes in the popup and a result the app never receives, with nothing on either side saying why. Whatever the artefact is served on must be exactly what the app passes as `walletHost`. It deserves a loud check: the host knows both strings and can say plainly that they differ instead of posting into the void.

## Order of work

**Step one: the local provider.** Move the mnemonic branch out of `@etherplay/openfort` into a `local` provider, and route to it by mechanism in the host. Gate: email and OAuth behave exactly as before, and a mnemonic sign-in completes in a host built with no Openfort key set at all.

**Step two: runtime configuration, and the two builds.** One `config.ts`, the eight reads routed through it, and the build flag that decides whether the document is honoured. Gate: a test build takes its allowlist and deadlines from the document; a production build ignores a document that is present and warns that it did.

**Step three: publish the artefact.** Gate: a clean checkout elsewhere, with no access to this repo, can install it, serve it, and complete a mnemonic sign-in against it. BUILT, and the gate is `packages/etherplay-dev-wallet-host/scripts/verify-adopter-install.mjs`, which packs, installs into a throwaway project and drives the sign-in in a browser. NOT PUBLISHED: the first version needs one manual `pnpm publish` before OIDC can take over, and a trusted publisher entry on npmjs.com.

**Step four: an adopter proves it, in both jobs.** `jolly-roger` runs it in the dev session the way it already runs the faucet, so a developer gets the hosted sign-in locally; and its e2e drops the `PUBLIC_WALLET_HOST=` pin in `scripts/run-e2e-tests.sh`, starts the same artefact on a port, and adds a spec that signs in by mnemonic and asserts the `pre-signed` route submits the minted credential. Gate: that spec green, plus one that denies a permission and lands the app on `re-authorise`.

This step is the acceptance test for the whole plan, and it is not optional. Until an adopter has driven it, nothing above is known to work; it is only known to compile.

The e2e mechanics are already available and worth recording so the step is not re-discovered: the app's test hooks expose the connection on `globalThis.context`, so a spec can call `context.connection.connect({type: 'mnemonic', mnemonic, index: undefined})` from `page.evaluate` without depending on the Dev Mode button, which a production bundle does not render. The popup is an ordinary Playwright page event, and the account picker already carries stable ids (`#account-0` through `#account-8`).

## Parked, deliberately

**Narrowing `AuthProvider`.** A provider that implements one mechanism has to stub four methods. Splitting the interface is the honest fix and touches every consumer, for no gain until there is a second local mechanism.

**Runtime configuration for the production host.** Only worth reopening if deployments start differing in ways a rebuild cannot serve, and it would need integrity from something signed rather than from a plain HTTP response.

**Other local mechanisms.** A raw private key, or a key from hardware. The provider is named `local` so they have somewhere to go, and nothing here anticipates them further.

## Facts established along the way

Worth recording so they are not re-derived.

- The Openfort SDK does not touch the network at initialisation: `waitForInitialization` awaits an already-resolved promise and then a localStorage probe, and `SDKConfiguration` stores the publishable key without validating it. So the current arrangement probably does work offline with a dummy key. It is being changed for provenance rather than because it is broken today: a vendor SDK on the test path is a vendor that can break the test path in a version bump, and the failure will look like an application bug.
- The host already hardcodes the standard test mnemonic as its dev default (`state.ts`), so the mnemonic mechanism needs no user input beyond picking an account index. This is deliberate and stays, including in production builds.
- `?provider=` is forwarded by `@etherplay/connect` from the app's own `VITE_AUTH_PROVIDER` at the app's build time, on every popup URL, for every mechanism. That is what makes a deployment-wide provider choice unable to express "email from the host, mnemonic locally".
- The whole environment surface of the host is eight `import.meta.env` reads in three files.
