import {describe, it, expect, vi} from 'vitest';
import {writable} from 'svelte/store';
import {createStorePromise, withTimeout} from '../src/utils.js';

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
