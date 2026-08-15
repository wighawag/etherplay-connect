# The login host

The popup that hosted sign-in happens in. `login/` is the page that matters: it is where the account is derived, where the permission decisions are made, and where the result is handed back to the app.

## Two artefacts, one source

| build                 | output      | configuration                                     | fit for                           |
| --------------------- | ----------- | ------------------------------------------------- | --------------------------------- |
| `pnpm build`          | `dist/`     | baked at build time, no runtime document honoured | real accounts                     |
| `pnpm build:dev-host` | `dist-dev/` | a `config.json` merged over the baked defaults    | development and e2e, nothing else |

They differ in exactly one boolean, and it is the same boolean twice over: the flag that says "this build is not for real accounts" is the flag that says "honour a runtime configuration document". A production build that finds a document ignores it and says so in the console, which is the pattern `ALLOW_LOOPBACK_REQUESTERS` already sets.

The reason is in `login/src/lib/allowlist.ts` and it is not an implementation detail: the tables there are hardcoded because there is then no runtime fetch to poison, and an allowlist entry mints credentials with **no human in the loop**. Making that injectable in the artefact that holds real accounts would undo the argument in one line. The development artefact can have it because it holds nothing worth protecting.

## Running the development host

Adopters do not build it: it ships prebuilt as [`@etherplay/dev-wallet-host`](../packages/etherplay-dev-wallet-host/README.md), which wraps `dist-dev/` with a server and a `bin`. From a checkout:

```sh
pnpm --filter ./web build:dev-host       # -> web/dist-dev
pnpm --filter ./web preview:dev-host     # or any static server you already have

pnpm build:dev-wallet-host               # -> the publishable package, site/ and all
pnpm --filter @etherplay/dev-wallet-host exec node bin/dev-wallet-host.js --port 50000
```

It is meant to be run next to your app the way you already run a faucet, and to be the same thing your e2e run starts. With no configuration at all it serves a working sign-in: the mnemonic mechanism needs no key, no account, no network, and defaults to the standard hardhat test phrase, so the only input is which account index to use.

On startup it says, in one line, which origin it is serving and which provider it will use for the hosted mechanisms. If that origin is not exactly what your app passes as `walletHost`, that line is the thing to read.

### `config.json`

Optional, at the root of the directory you serve, next to `index.html`. Copy `config.example.json`. Every field is optional and merged over the defaults; a field of the wrong type is refused out loud rather than silently dropped, and a malformed allowlist is refused WHOLE rather than half-applied, because a table that granted only the entries that happened to parse would be a grant nobody wrote.

**The fields are documented once, in [`packages/etherplay-dev-wallet-host/README.md`](../packages/etherplay-dev-wallet-host/README.md#configuring-it)**, which is the copy an adopter reads. Not repeated here: a field list kept in two places is a field list that ends up disagreeing with itself. The shape it has to satisfy is `HostConfig` in `login/src/lib/config.ts`.

The one thing that differs from an adopter's setup: under `vite dev` the document is read from `public/config.json` (gitignored), because that is what the dev server serves at `/config.json`.

## Serving it over plain http

Supported, not a compromise. The flow is a popup plus `postMessage`, and neither needs a secure context; `http://localhost` and `http://127.0.0.1` are potentially trustworthy origins anyway, so even the APIs that do require one are available. Two edges are worth knowing before you meet them:

- **A LAN address is not localhost.** Serving with `--host` so a phone can reach `http://192.168.x.x` gives up secure-context status and with it `crypto.subtle`. The popup flow still works; the opt-in domain-redirect bridge does not, and testing that path from a device needs https.
- **The origin must match exactly.** The host posts its result with `targetOrigin` set to the origin the app declared, so `http` against `https`, `127.0.0.1` against `localhost`, or the wrong port produces a sign-in that visibly completes in the popup and a result the app never receives. The host checks for this and says plainly that the two differ (`login/src/lib/origin-check.ts`), but it can only warn: whatever this is served on must be exactly what your app passes as `walletHost`.

## Which provider answers a sign-in

By MECHANISM, decided in `login/src/lib/handler.ts`:

- `mnemonic` goes to `createLocalProvider` from `@etherplay/connect-core`. Derived in the browser, no service behind it.
- everything else goes to the configured hosted provider.

`?provider=` is honoured as an explicit value and means "which hosted provider for email and OAuth". It is never required for a mnemonic sign-in, because the app chooses that value once at its own build time and sends it for every mechanism, which cannot express "email from the host, mnemonic locally".
