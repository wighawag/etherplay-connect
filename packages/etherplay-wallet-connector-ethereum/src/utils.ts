import {bytesToHex} from '@noble/hashes/utils';

/**
 * Wraps any promise with a timeout
 * @param promise The promise to wrap with a timeout
 * @param timeoutMs Timeout in milliseconds
 * @param timeoutMessage Optional custom error message for timeout
 * @returns A new promise that resolves/rejects with the original promise result or times out
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000, timeoutMessage?: string): Promise<T> {
	// Create a promise that rejects after the specified timeout
	let id: number | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		id = setTimeout(() => {
			if (id) {
				// console.log(`time out reached`);
				clearTimeout(id);
				id = undefined;
				reject(new Error(timeoutMessage || `Promise timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);
	});

	promise.then((result) => {
		if (id) {
			clearTimeout(id);
			id = undefined;
			// console.log(`promise resolved in time`, result);
		} else {
			// console.log(`promise resolved too late`);
		}
	});

	// Race the original promise against the timeout
	return Promise.race([promise, timeoutPromise]);
}

const encoder = new TextEncoder();

export function hashMessage(message: string): `0x${string}` {
	const messageAsBytes = encoder.encode(message);
	const msg = `0x${bytesToHex(messageAsBytes)}` as `0x${string}`;
	return msg;
}
