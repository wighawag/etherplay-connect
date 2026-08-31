// Cancelling a sign-in popup has to SETTLE the promise the app is awaiting.
//
// `connect({type: 'email'})` returns a promise, and an app that awaits it will usually also render
// a cancel button, because a popup can sit there indefinitely. `PopupPromise.cancel()` was an empty
// `TODO`, so `connection.cancel()` returned the STORE to `Idle` while leaving that promise pending
// for good: the caller waited forever on a flow the store had already abandoned, and the popup
// window stayed open behind it.
//
// The awkward part is not the cancelling, it is that settling the promise wakes `connect`'s own
// failure handler, which lands the flow on `Idle`. That handler must not overrule the caller who
// just chose where to come to rest, which is what the `back()` test below is really about.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const PAGE_ORIGIN = 'http://localhost:3000';

describe('cancelling a sign-in popup', () => {
	let originalOpen: typeof window.open;
	let opened: {closed: boolean; close: ReturnType<typeof vi.fn>};

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		originalOpen = window.open;
		opened = {closed: false, close: vi.fn()};
		(window as any).open = vi.fn(() => opened as unknown as Window);
	});

	afterEach(() => {
		(window as any).open = originalOpen;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function launched() {
		const connection = createConnection({
			walletHost: 'https://wallet.example.com',
			chainInfo,
			autoConnect: false,
		});
		const snapshot = () => {
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			})();
			return state as any;
		};
		return {connection, snapshot};
	}

	/** Resolve to 'settled' if the promise has settled by now, or to 'pending' if it has not. */
	async function settles(promise: Promise<unknown>) {
		let done = false;
		void promise.then(
			() => (done = true),
			() => (done = true),
		);
		// Enough turns for a rejection to travel through `connect`'s own catch and finally.
		await vi.advanceTimersByTimeAsync(10);
		return done ? 'settled' : 'pending';
	}

	it('settles the promise connect() returned, and closes the window', async () => {
		const {connection, snapshot} = launched();

		const connecting = connection.connect({type: 'email', email: 'user@example.com'});
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().step).toBe('PopupLaunched');

		connection.cancel();

		expect(await settles(connecting)).toBe('settled');
		// The popup window is closed too: leaving it open is how a cancelled sign-in ends up with an
		// orphaned window the user has to find and close.
		expect(opened.close).toHaveBeenCalled();
		expect(snapshot().step).toBe('Idle');
		// A cancellation is not a failure and has nothing to report.
		expect(snapshot().error).toBeUndefined();
	});

	it('back() settles it too, and keeps the step back() chose', async () => {
		// The regression that settling the promise could have introduced: `connect`'s catch lands on
		// `Idle`, so a naive fix would send `back('MechanismToChoose')` to `Idle` one microtask
		// later, undoing the navigation the caller just asked for.
		const {connection, snapshot} = launched();

		const connecting = connection.connect({type: 'email', email: 'user@example.com'});
		await vi.advanceTimersByTimeAsync(50);
		expect(snapshot().step).toBe('PopupLaunched');

		connection.back('MechanismToChoose');

		expect(await settles(connecting)).toBe('settled');
		expect(snapshot().step).toBe('MechanismToChoose');
		expect(snapshot().error).toBeUndefined();
	});

	it('a replaced popup does not drag the new attempt back to Idle', async () => {
		// Launching a second popup rejects the first ('popup closed so new one can take over'). That
		// rejection belongs to an attempt nobody is following any more, so it must not touch a state
		// the second attempt now owns.
		const {connection, snapshot} = launched();

		const first = connection.connect({type: 'email', email: 'first@example.com'});
		await vi.advanceTimersByTimeAsync(50);
		const second = connection.connect({type: 'email', email: 'second@example.com'});
		await vi.advanceTimersByTimeAsync(50);

		expect(await settles(first)).toBe('settled');
		// Still waiting on the popup the user is actually looking at.
		expect(snapshot().step).toBe('PopupLaunched');
		expect(snapshot().mechanism).toMatchObject({type: 'email', email: 'second@example.com'});

		connection.cancel();
		expect(await settles(second)).toBe('settled');
	});
});
