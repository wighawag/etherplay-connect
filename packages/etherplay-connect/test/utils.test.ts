import {describe, it, expect, vi} from 'vitest';
import {writable} from 'sveltore';
import {createStorePromise, withTimeout} from '../src/utils.js';

/**
 * Run `fn` and report the rejections Node considered UNHANDLED while it ran.
 *
 * Node decides that at the end of a macrotask, once the microtask queue has drained, hence the two
 * real-timer ticks. The runner's own `unhandledRejection` listeners are detached for the duration
 * and restored afterwards: leaving them attached would make an expected-and-captured rejection also
 * fail the surrounding test run.
 */
async function unhandledRejectionsDuring(fn: () => Promise<void>): Promise<unknown[]> {
	const captured: unknown[] = [];
	const runnerListeners = process.listeners('unhandledRejection');
	for (const listener of runnerListeners) {
		process.off('unhandledRejection', listener);
	}
	const capture = (reason: unknown) => captured.push(reason);
	process.on('unhandledRejection', capture);
	try {
		await fn();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		process.off('unhandledRejection', capture);
		for (const listener of runnerListeners) {
			process.on('unhandledRejection', listener as never);
		}
	}
	return captured;
}

describe('withTimeout', () => {
	it('should resolve when promise resolves before timeout', async () => {
		const promise = Promise.resolve('success');
		const result = await withTimeout(promise, 1000);
		expect(result).toBe('success');
	});

	it('should reject when promise takes longer than timeout', async () => {
		const slowPromise = new Promise((resolve) => setTimeout(() => resolve('success'), 200));

		await expect(withTimeout(slowPromise, 50)).rejects.toThrow('Promise timed out after 50ms');
	});

	it('should use custom timeout message when provided', async () => {
		const slowPromise = new Promise((resolve) => setTimeout(() => resolve('success'), 200));

		await expect(withTimeout(slowPromise, 50, 'Custom timeout error')).rejects.toThrow('Custom timeout error');
	});

	it('should use default timeout of 5000ms', async () => {
		vi.useFakeTimers();

		const slowPromise = new Promise((resolve) => setTimeout(() => resolve('success'), 6000));
		const timeoutPromise = withTimeout(slowPromise);

		// Fast-forward 5 seconds
		vi.advanceTimersByTime(5001);

		await expect(timeoutPromise).rejects.toThrow('Promise timed out after 5000ms');

		vi.useRealTimers();
	});

	it('should resolve with the original value when successful', async () => {
		const complexValue = {key: 'value', nested: {a: 1, b: [1, 2, 3]}};
		const promise = Promise.resolve(complexValue);

		const result = await withTimeout(promise, 1000);
		expect(result).toEqual(complexValue);
	});

	it('should propagate the original rejection', async () => {
		const failure = Object.assign(new Error('User rejected the request.'), {code: 4001});

		await expect(withTimeout(Promise.reject(failure), 1000)).rejects.toBe(failure);
	});

	// Regression: the internal `promise.then(...)` used to pass no rejection handler, so the derived
	// promise rejected with nobody listening. Every rejecting call wrapped in `withTimeout` (a locked
	// wallet, a declined prompt) emitted an unhandled rejection even though the caller handled it.
	it('should not emit an unhandled rejection when the wrapped promise rejects', async () => {
		const captured = await unhandledRejectionsDuring(async () => {
			await expect(withTimeout(Promise.reject(new Error('wallet is locked')), 1000)).rejects.toThrow(
				'wallet is locked',
			);
		});

		expect(captured).toEqual([]);
	});

	it('should not emit an unhandled rejection when the caller catches instead of awaiting', async () => {
		// The same guarantee for the other common calling style, where nothing ever `await`s the
		// returned promise directly.
		const captured = await unhandledRejectionsDuring(async () => {
			let caught: unknown;
			await withTimeout(Promise.reject(new Error('boom')), 1000).catch((err) => {
				caught = err;
			});
			expect((caught as Error).message).toBe('boom');
		});

		expect(captured).toEqual([]);
	});

	// Regression: the timer was only cleared on the fulfilled path, so a rejection left it pending
	// for the full timeout. That keeps the event loop (and fake-timer assertions) dirty long after
	// the call has already failed.
	it('should clear the pending timer when the wrapped promise rejects', async () => {
		vi.useFakeTimers();
		try {
			await expect(withTimeout(Promise.reject(new Error('boom')), 5000)).rejects.toThrow('boom');

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should clear the pending timer when the wrapped promise resolves', async () => {
		vi.useFakeTimers();
		try {
			await expect(withTimeout(Promise.resolve('ok'), 5000)).resolves.toBe('ok');

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('should still time out, and stay quiet, when the wrapped promise rejects only afterwards', async () => {
		// The awkward ordering: the timeout wins the race, and the slow call fails later with nobody
		// left interested in it. `Promise.race` has already attached a rejection handler to it, so the
		// late failure must not resurface as an unhandled rejection either.
		const captured = await unhandledRejectionsDuring(async () => {
			const slowFailure = new Promise((_, reject) => setTimeout(() => reject(new Error('too late')), 60));

			await expect(withTimeout(slowFailure, 10)).rejects.toThrow('Promise timed out after 10ms');
			await new Promise((resolve) => setTimeout(resolve, 80));
		});

		expect(captured).toEqual([]);
	});
});

describe('createStorePromise', () => {
	it('should create a promise that also acts as a store', async () => {
		const store = {
			subscribe: writable('initial').subscribe,
			customMethod: () => 'custom',
		};

		const storePromise = createStorePromise<string, string, typeof store>(store, (resolve) => {
			setTimeout(() => resolve('resolved'), 10);
		});

		// Verify it works as a store
		let storeValue: string | undefined;
		const unsubscribe = storePromise.subscribe((value) => {
			storeValue = value;
		});
		expect(storeValue).toBe('initial');
		unsubscribe();

		// Verify it has custom methods
		expect(storePromise.customMethod()).toBe('custom');

		// Verify it works as a promise
		const result = await storePromise;
		expect(result).toBe('resolved');
	});

	it('should reject properly when executor calls reject', async () => {
		const store = {
			subscribe: writable('initial').subscribe,
		};

		const storePromise = createStorePromise<string, string, typeof store>(store, (_, reject) => {
			setTimeout(() => reject(new Error('rejected')), 10);
		});

		await expect(storePromise).rejects.toThrow('rejected');
	});

	it('should throw error if store has a "then" field', () => {
		const store = {
			subscribe: writable('initial').subscribe,
			then: () => {},
		};

		expect(() =>
			createStorePromise<string, string, typeof store>(store, (resolve) => {
				resolve('test');
			}),
		).toThrow('then field is not allowed');
	});

	it('should throw error if store has a "finally" field', () => {
		const store = {
			subscribe: writable('initial').subscribe,
			finally: () => {},
		};

		expect(() =>
			createStorePromise<string, string, typeof store>(store, (resolve) => {
				resolve('test');
			}),
		).toThrow('finally field is not allowed');
	});

	it('should work with chained promises', async () => {
		const store = {
			subscribe: writable(0).subscribe,
		};

		const storePromise = createStorePromise<number, number, typeof store>(store, (resolve) => {
			resolve(5);
		});

		const result = await storePromise.then((value) => value * 2);
		expect(result).toBe(10);
	});

	it('should work with catch and finally', async () => {
		const store = {
			subscribe: writable('initial').subscribe,
		};

		let finallyCalled = false;
		const storePromise = createStorePromise<string, string, typeof store>(store, (_, reject) => {
			reject(new Error('test error'));
		});

		await storePromise
			.catch((err) => {
				expect(err.message).toBe('test error');
				return 'caught';
			})
			.finally(() => {
				finallyCalled = true;
			});

		expect(finallyCalled).toBe(true);
	});
});
