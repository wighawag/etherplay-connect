import type {Readable} from 'svelte/store';

export function createStorePromise<U, T, V extends Readable<T>>(
	store: V,
	executor: (resolve: (value: U | PromiseLike<U>) => void, reject: (reason?: any) => void) => void,
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

/**
 * Wraps any promise with a timeout
 * @param promise The promise to wrap with a timeout
 * @param timeoutMs Timeout in milliseconds
 * @param timeoutMessage Optional custom error message for timeout
 * @returns A new promise that resolves/rejects with the original promise result or times out
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000, timeoutMessage?: string): Promise<T> {
	// Create a promise that rejects after the specified timeout
	let id: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		id = setTimeout(() => {
			if (id !== undefined) {
				// console.log(`time out reached`);
				clearTimeout(id);
				id = undefined;
				reject(new Error(timeoutMessage || `Promise timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);
	});

	// Cancel the pending timer as soon as the raced promise settles, EITHER WAY.
	//
	// This branch exists only for that side effect: the value and the error are propagated by the
	// `Promise.race` below, which attaches its own handlers to `promise`. But a `.then(onFulfilled)`
	// with no rejection handler creates a SECOND derived promise that rejects with nowhere to go, so
	// every rejecting call wrapped in `withTimeout` used to emit an unhandled rejection: noise in the
	// console, a crash under `--unhandled-rejections=strict`, and a spurious error in test runs that
	// treat unhandled rejections as failures. A wallet refusing to authorize accounts (EIP-1193 4100)
	// or a user declining a prompt (4001) is an ordinary, fully handled outcome and must stay quiet.
	//
	// Handling both settle paths also stops the timer leaking on the rejection path: it used to stay
	// pending for the full `timeoutMs` after the promise had already failed.
	const clearPendingTimeout = () => {
		if (id !== undefined) {
			clearTimeout(id);
			id = undefined;
		}
	};
	promise.then(clearPendingTimeout, clearPendingTimeout);

	// Race the original promise against the timeout
	return Promise.race([promise, timeoutPromise]);
}
