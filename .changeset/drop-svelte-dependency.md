---
'@etherplay/connect': minor
'@etherplay/openfort': minor
---

Drop the `svelte` peer dependency in favour of `sveltore`.

Both packages used Svelte only for `svelte/store`, which forced every consumer into a `svelte` peer-dependency negotiation for a library they may not otherwise use. They now depend on [`sveltore`](https://www.npmjs.com/package/sveltore), a standalone dependency-free port of Svelte's store implementation.

Nothing changes for Svelte consumers: the returned stores still satisfy the [Svelte store contract](https://svelte.dev/docs/svelte/stores#Store-contract), so `$store` auto-subscription and `svelte/store`'s own `get` / `derived` / `fromStore` keep working on them unchanged. This is verified by the demo app and the web app, which both still type-check against the real Svelte with zero errors.

A Svelte app that would rather have a single store implementation in its bundle can alias the package away in one line, which is safe because sveltore's API is a strict subset of `svelte/store` with identical signatures:

```js
// vite.config.js
export default {
	resolve: {
		alias: {sveltore: 'svelte/store'}
	}
};
```

`@etherplay/openfort` also moves from `sveltore@^0.0.2` to `^1.0.0`. It already used sveltore, but on a range that could not deduplicate with the one `@etherplay/connect` now uses, so a consumer installing both would have resolved two separate copies.
