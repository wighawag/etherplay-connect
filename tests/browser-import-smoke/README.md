# browser-import-smoke

Asserts that `import('@etherplay/connect')` **settles** in a real browser, within a timeout.

## Why this exists

Every other test in this repo runs in node, under `happy-dom`. That environment cannot observe the one failure mode this test guards: module evaluation that blocks only under a genuine browser. A module that hangs while evaluating produces no exception, no console output, and no rejected promise. The page simply stays at `document.readyState === 'interactive'` forever and the app never starts. Type checks cannot see it either, because the types are fine.

The test covers both import shapes, because they fail differently:

- **static** (`static.html`): the entry module cannot run until the package has evaluated, so a hang also stops the document from ever reaching `readyState === 'complete'`. This is the shape that matches a real app.
- **dynamic** (`dynamic.html`): exposes both outcomes, so a hang (never settles) is distinguishable from a failure (rejects).

## The harness must be exonerated first

A browser reports these two situations identically, with total silence:

1. the imported module blocked while evaluating, and
2. the module's **response body never completed**, even though the response began with `200 OK`.

Case 2 is a property of the static server, not of the package, and it is easy to hit: a `Content-Length` larger than the bytes actually written, a response that is never ended, or a `.js` served under a MIME type the browser refuses to execute. Diagnosing case 2 as if it were case 1 sends you hunting for a hang in code that never ran.

So the first test asserts the harness is healthy before any test is allowed to blame the package:

- every request finished (`unfinishedRequests` is empty),
- the origin is a secure context, so `crypto.subtle` is defined exactly as in production.

`src/static-server.ts` is deliberately strict for the same reason: it always sends a `Content-Length` matching the bytes it writes, and refuses to serve an extension it has no MIME type for rather than falling back to `application/octet-stream`.

## Running it

```sh
pnpm --filter @etherplay/browser-import-smoke install:browsers   # once, downloads Chromium
pnpm --filter @etherplay/browser-import-smoke test
```

The test builds the fixture app from the **workspace** packages, so it exercises whatever is currently in each package's `dist/`. Run `pnpm build:packages` from the repo root first if those are stale.

Bundles are built unminified with sourcemaps on purpose: when this test does fail, the next step is loading `dist-app/` in a headed browser and pausing on module evaluation, and minified output makes that far harder.

## Reading a failure

The assertion messages carry the discriminating evidence:

- `unfinishedRequests` non-empty: the server stalled. Fix the harness, not the package.
- `readyState=unresponsive (main thread blocked)`: the thread is **spinning**, so look for a runaway loop, not for something being awaited.
- `readyState=interactive` with the thread still answering: something is being **awaited** that never arrives. Look for a handshake, a message reply, or a discovery step with no timeout.
- the dynamic import rejected with an error: an ordinary failure, and the message says what it was.
