import type { Readable } from 'svelte/store';

export function createStorePromise<U extends T, T>(
	store: Readable<T>,
	executor: (resolve: (value: U | PromiseLike<U>) => void, reject: (reason?: any) => void) => void
): Promise<U> & Readable<T> {
	const storePromise = new Promise<U>(executor) as Promise<U> & Readable<T>;

	storePromise.subscribe = store.subscribe;

	return storePromise;
}
