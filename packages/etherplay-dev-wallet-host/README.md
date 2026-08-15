# @etherplay/dev-wallet-host

The Etherplay sign-in host, prebuilt, so you can run it next to your app the way you already run a faucet.

**Development and e2e only.** This build takes its configuration at runtime, which makes it unfit for real accounts by construction. That is the point: everything in it is injectable precisely because none of it guards anything. Do not deploy it. The host that holds real accounts is a different build of the same source, with every value baked in and no runtime document honoured.

## Why

Without it, anything downstream of hosted sign-in needs either a deployed host or a checkout of the `etherplay-connect` monorepo, so the ordinary local loop stops at the wallet path. This is a dependency, a version in your lockfile, and a directory to serve. No build step, no publishable key, no sibling checkout.

It is one artefact for two jobs on purpose: what you want running while you work and what your e2e run starts are the same thing configured the same way, and splitting them gives you a fixture nobody looks at standing in for a service everybody uses.

## Install and run

```sh
npm install --save-dev @etherplay/dev-wallet-host
npx dev-wallet-host --port 50000
```

```jsonc
{
	"scripts": {
		"dev": "dev-wallet-host --port 50000 & vite dev",
		"test:e2e": "dev-wallet-host --port 50000 & playwright test",
	},
}
```

Then point your app at exactly that origin:

```ts
createConnection({walletHost: 'http://localhost:50000' /* ... */});
```

With no configuration at all it serves a working sign-in. The mnemonic mechanism needs no key, no account and no network: it defaults to the standard hardhat test phrase, so the only input is which account index to use, and the accounts it derives are the ones your local chain already funded.

### Options

| option                 | what it does                                                |
| ---------------------- | ----------------------------------------------------------- |
| `-p, --port <number>`  | port to listen on (default `50000`)                         |
| `-H, --host <address>` | address to bind (default `127.0.0.1`)                       |
| `-c, --config <file>`  | serve this file as `/config.json`, re-read on every request |
| `-d, --dir <path>`     | serve a different directory instead of the bundled one      |
| `-v, --version`        | print the version                                           |
| `-h, --help`           | print the usage                                             |

## Configuring it

Optional. Write a JSON file anywhere in your project and pass `--config`; it is re-read on every request, so editing it and reloading the popup is the whole loop. Copy `node_modules/@etherplay/dev-wallet-host/config.example.json` to start from.

| field                       | what it is                                                                     |
| --------------------------- | ------------------------------------------------------------------------------ |
| `hostedAuthProvider`        | which provider answers email and OAuth (never consulted for mnemonic)          |
| `devMnemonic`               | the phrase the mnemonic mechanism signs in with                                |
| `openfort`                  | `publishableKey`, `shieldPublishableKey`, `encryptionSessionEndpoint`          |
| `allowLoopbackRequesters`   | whether a page on this machine may ask for another origin's account            |
| `originAllowlist`           | requester origin to the (chainId, contract) pairs it may have without a prompt |
| `crossOriginAllowlist`      | origin whose account is at stake, to who may ask for it                        |
| `autoSignedLifetimeSeconds` | how long an auto-signed credential may be presented for                        |
| `promptedLifetimeSeconds`   | the same for one a human granted; `0` means no expiry                          |

A field of the wrong type is refused out loud in the console rather than silently dropped.

The two lifetimes are the ones people forget and then need. An auto-signed credential's deadline is the only lever an allowlist entry has once that entry turns out to be wrong, so a test that cannot set it cannot exercise expiry at all, and nobody can watch a credential expire without waiting three months. Set `autoSignedLifetimeSeconds` to something small and you can.

Example, for an app on `http://localhost:5173` testing the auto-signed path against a local chain:

```json
{
	"originAllowlist": {
		"http://localhost:5173": [{"chainId": 31337, "contract": "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"}]
	},
	"autoSignedLifetimeSeconds": 120
}
```

## The one thing that wastes an afternoon

**The origin must match exactly.** The host delivers its result with `postMessage`, using the origin your app declared as `targetOrigin`. If that is not the origin your app is really at, the browser drops the result: the sign-in visibly completes in the popup and your app receives nothing, with no error of its own. `http://127.0.0.1:5173` and `http://localhost:5173` are the same machine and not the same origin.

The host checks for this and says so in the popup's console, but it can only warn. Whatever this server prints on startup must be exactly what you pass as `walletHost`.

## Plain http is fine

The flow is a popup plus `postMessage`, and neither needs a secure context. `http://localhost` and `http://127.0.0.1` are potentially trustworthy origins anyway, so even the APIs that do require one are available there.

One edge: binding with `--host 0.0.0.0` so a phone on your network can reach `http://192.168.x.x` gives up secure-context status, and with it `crypto.subtle`. The ordinary popup flow still works; the opt-in domain-redirect bridge does not, and testing that path from a device needs https.

## Serving it yourself

The bundle is a plain static directory (`node_modules/@etherplay/dev-wallet-host/site`), so any static server will do. One requirement: it must **not** fall back to `index.html` for missing paths. The host asks for `/config.json` and treats an HTML answer as "no document", so a fallback turns a mistyped path into a configuration that silently did nothing. The bundled server answers 404, on purpose.

## Which provider answers which sign-in

By mechanism. `mnemonic` is derived in the browser with nothing behind it; email and OAuth go to the hosted provider named by `hostedAuthProvider`, which needs that provider's own credentials to do anything. This is why a mnemonic sign-in works here with no keys at all.

## Checking it from the outside

```sh
node scripts/verify-adopter-install.mjs   # needs Chrome; CHROME=<path> if not on PATH
```

Packs the tarball, installs it with `npm` into a throwaway project with no workspace and no path back to this checkout, starts the bin the way a dev script would, and completes a mnemonic sign-in in a real browser, asserting that the credential and deadline came from the config file.

Not part of `pnpm test` and not in CI, because it needs a browser. Run it before publishing, or when the bundle, the bin or the popup contract changes: the unit tests cannot fail for the reasons this package actually fails for. The first run of it found two such reasons.

## License

MIT
