// @vitest-environment node
//
// SSR / construction-inertness regression test for @etherplay/connect.
//
// This file deliberately runs in vitest's `node` environment: no `window`,
// `document`, `localStorage`, `sessionStorage` globals exist. It asserts that
// `createConnection(...)` — for BOTH supported configurations
// (`targetStep: 'WalletConnected'` and `targetStep: 'SignedIn'` with a
// `walletHost`) — constructs synchronously without throwing, without touching
// storage, and without leaving any timers/intervals pending.
//
// No DOM shim (jsdom / happy-dom / polyfill) is used. The point is genuine
// environment independence: the package must be constructable in bare Node,
// exactly as an SSR / prerender build would do.
//
// See the "Server-side rendering (SSR)" section of the package README for the
// contract this test pins down.

import {describe, it, expect} from 'vitest';
import {createConnection, type ChainInfo} from '../src/index.js';

const chainInfo: ChainInfo<any> = {
	id: 1,
	name: 'Ethereum',
	rpcUrls: {default: {http: ['http://127.0.0.1:8545']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
};

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

/**
 * Assert that the environment really is DOM-free. Run this before installing
 * any tripwires.
 *
 * We check the DOM-defining globals (`window`, `document`) plus the
 * browser-only storage globals the package must never touch off-browser
 * (`localStorage`, `sessionStorage`). We deliberately do NOT assert on
 * `navigator`, `crypto` or `fetch`: Node >= 21 exposes those as real Node
 * globals (not DOM injections), and the package never reads them at
 * construction — it only ever reaches `window.crypto` / `window.*` behind a
 * `typeof window` guard.
 */
function assertNoDomGlobals() {
	expect(typeof globalThis.window, 'window must be undefined in this test').toBe('undefined');
	expect(typeof globalThis.document, 'document must be undefined in this test').toBe('undefined');
	expect(typeof globalThis.localStorage, 'localStorage must be undefined in this test').toBe('undefined');
	expect(typeof globalThis.sessionStorage, 'sessionStorage must be undefined in this test').toBe('undefined');
}

type StorageTripwire = {
	/** `true` if construction touched the named storage. Construction must keep this `false`. */
	wasAccessed: () => boolean;
	cleanup: () => void;
};

/**
 * Install a throw-on-access getter for a global that must NOT exist during
 * construction. This is a tripwire, not a shim: it can only make the test FAIL
 * louder (by throwing if the value is read), never make it pass. The package
 * never does `typeof <storage>` — it accesses `localStorage.getItem(...)`
 * directly inside helpers that are only callable from browser-guarded flows —
 * so a throwing getter is a fair "accessed during construction ⇒ fail"
 * detector. It is removed again in `cleanup`.
 */
function installStorageTripwire(name: 'localStorage' | 'sessionStorage'): StorageTripwire {
	let accessed = false;
	Object.defineProperty(globalThis, name, {
		configurable: true,
		get() {
			accessed = true;
			throw new Error(`SSR contract violation: globalThis.${name} was accessed during createConnection() construction`);
		},
	});
	return {
		wasAccessed: () => accessed,
		cleanup: () => {
			delete (globalThis as any)[name];
		},
	};
}

type TimerTracker = {
	/** Number of timer/interval ids created during the tracked window but never cleared. */
	pending: () => number;
};

/**
 * Wrap the global timer scheduling functions for the duration of a synchronous
 * construction and record any timer that is created but not cleared. The
 * contract is that construction leaves no timers or intervals pending. The
 * wrappers are restored immediately after construction (in `finally`) so
 * vitest's own timers are unaffected.
 */
function trackTimersDuring(construct: () => void): TimerTracker {
	const pending = new Set<unknown>();
	const origSetTimeout = globalThis.setTimeout;
	const origClearTimeout = globalThis.clearTimeout;
	const origSetInterval = globalThis.setInterval;
	const origClearInterval = globalThis.clearInterval;

	globalThis.setTimeout = function (...args: any[]) {
		const id = origSetTimeout(...(args as [any, ...any[]]));
		pending.add(id);
		return id;
	} as typeof setTimeout;
	globalThis.clearTimeout = function (id: any) {
		pending.delete(id);
		origClearTimeout(id);
	} as typeof clearTimeout;
	globalThis.setInterval = function (...args: any[]) {
		const id = origSetInterval(...(args as [any, ...any[]]));
		pending.add(id);
		return id;
	} as typeof setInterval;
	globalThis.clearInterval = function (id: any) {
		pending.delete(id);
		origClearInterval(id);
	} as typeof clearInterval;

	try {
		construct();
	} finally {
		globalThis.setTimeout = origSetTimeout;
		globalThis.clearTimeout = origClearTimeout;
		globalThis.setInterval = origSetInterval;
		globalThis.clearInterval = origClearInterval;
	}

	return {pending: () => pending.size};
}

/** Construct via `createConnection`, capturing any throw so we get a clear failure message. */
function constructSafely(settings: Parameters<typeof createConnection>[0]) {
	let store: ReturnType<typeof createConnection> | undefined;
	let thrown: unknown;
	try {
		store = createConnection(settings);
	} catch (err) {
		thrown = err;
	}
	expect(thrown, 'createConnection() must not throw when constructed off-browser').toBeUndefined();
	return store as ReturnType<typeof createConnection>;
}

/** Capture the first value emitted by a store subscription (synchronously). */
function snapshot<T>(store: {subscribe: (run: (v: T) => void) => () => void}): T {
	let value: T | undefined;
	const unsubscribe = store.subscribe((v) => {
		value = v;
	});
	unsubscribe();
	return value as T;
}

// -------------------------------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------------------------------

describe('SSR / construction inertness (no DOM globals)', () => {
	it('runs in an environment with no DOM globals', () => {
		// Guards the whole file: if someone changes the vitest config to inject a
		// DOM, this stops the suite from silently passing for the wrong reason.
		assertNoDomGlobals();
	});

	it('constructs `targetStep: "WalletConnected"` without throwing, touching storage, or leaving timers', () => {
		assertNoDomGlobals();

		const localStorageTrip = installStorageTripwire('localStorage');
		const sessionStorageTrip = installStorageTripwire('sessionStorage');

		let store: ReturnType<typeof createConnection>;
		const timers = trackTimersDuring(() => {
			store = constructSafely({
				targetStep: 'WalletConnected',
				chainInfo,
				autoConnect: true,
			});
		});

		// Exact initial store value off-browser. This is the SSR contract: the
		// store rests at Idle with loading:true, identical to the browser's very
		// first render, so a server-rendered app hydrates without a mismatch.
		// (See README: changing this value is a hydration-visible breaking change.)
		//
		// `pendingRequests` is part of the shape and is empty on BOTH sides: a server
		// has no user wallet to hold anything, and a browser's first render is before
		// anything could have been asked. So it is in the value without being a
		// hydration difference.
		const value = snapshot(store);
		expect(value).toEqual({step: 'Idle', loading: true, wallets: [], pendingRequests: []});
		expect(value.step).toBe('Idle');
		expect(value.loading).toBe(true);
		expect(value.wallets).toEqual([]);
		expect((value as any).wallet).toBeUndefined();

		// Storage must never have been read or written during construction.
		expect(localStorageTrip.wasAccessed(), 'localStorage was touched during construction').toBe(false);
		expect(sessionStorageTrip.wasAccessed(), 'sessionStorage was touched during construction').toBe(false);

		// No setTimeout / setInterval may survive construction.
		expect(timers.pending(), 'construction left a timer/interval pending').toBe(0);

		localStorageTrip.cleanup();
		sessionStorageTrip.cleanup();
	});

	it('constructs `targetStep: "SignedIn"` with a walletHost without throwing, touching storage, or leaving timers', () => {
		assertNoDomGlobals();

		const localStorageTrip = installStorageTripwire('localStorage');
		const sessionStorageTrip = installStorageTripwire('sessionStorage');

		let store: ReturnType<typeof createConnection>;
		const timers = trackTimersDuring(() => {
			store = constructSafely({
				targetStep: 'SignedIn',
				walletHost: 'https://wallet.example.com',
				chainInfo,
				autoConnect: true,
			});
		});

		const value = snapshot(store);
		expect(value).toEqual({step: 'Idle', loading: true, wallets: [], pendingRequests: []});
		expect(value.step).toBe('Idle');
		expect(value.loading).toBe(true);
		expect(value.wallets).toEqual([]);
		expect((value as any).wallet).toBeUndefined();

		expect(localStorageTrip.wasAccessed(), 'localStorage was touched during construction').toBe(false);
		expect(sessionStorageTrip.wasAccessed(), 'sessionStorage was touched during construction').toBe(false);

		expect(timers.pending(), 'construction left a timer/interval pending').toBe(0);

		localStorageTrip.cleanup();
		sessionStorageTrip.cleanup();
	});

	it('keeps loading:true off-browser because the auto-connect block is window-guarded (matches first browser render)', () => {
		assertNoDomGlobals();

		// autoConnect defaults to true. Off-browser the `typeof window !== 'undefined'`
		// guard skips the auto-connect branch entirely, so the store keeps its
		// initial `loading: true`. With autoConnect:false the explicit else branch
		// sets loading:false — documenting the difference to make the contract explicit.
		const onStore = constructSafely({
			targetStep: 'WalletConnected',
			chainInfo,
			// autoConnect defaults to true
		});
		expect(snapshot(onStore).loading).toBe(true);

		const offStore = constructSafely({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
		});
		expect(snapshot(offStore).loading).toBe(false);
	});
});
