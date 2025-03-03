import type { Readable } from 'svelte/store';

export function createStorePromise<U, T, V extends Readable<T>>(
	store: V,
	executor: (resolve: (value: U | PromiseLike<U>) => void, reject: (reason?: any) => void) => void
): Promise<U> & V {
	const storePromise = new Promise<U>(executor) as Promise<U> & V;

	for (const key of Object.keys(store)) {
		if (key === 'then') {
			throw new Error(`then field is not allowed`);
		}
		if (key == 'finally') {
			throw new Error(`finally field is not allowed`);
		}
		(storePromise as any)[key] = (store as any)[key];
	}

	return storePromise;
}
