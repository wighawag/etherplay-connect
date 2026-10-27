import {bytesToHex} from '@noble/hashes/utils';
import type {Methods} from 'eip-1193';
import type {CurriedRPC} from 'remote-procedure-call';

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

/**
 * The ONE spelling of a text signature request.
 *
 * Two callers send this: `EthereumWalletProvider.signMessage`, which sign-in still uses, and
 * `AlwaysOnEthereumProviderWrapper.signMessage`, which announces the signatures the library asks
 * for (see ADR-0001). They hold different objects and neither can call the other, so without this
 * they would each spell out the method name and the hex encoding and be free to drift. A signature
 * produced over differently encoded bytes recovers to a different address, so the drift would show
 * up as a credential that verifies against nobody rather than as an error.
 */
export function personalSign(
	rpc: CurriedRPC<Methods>,
	message: string,
	account: `0x${string}`,
): Promise<`0x${string}`> {
	return rpc.request({
		method: 'personal_sign',
		params: [hashMessage(message), account],
	}) as Promise<`0x${string}`>;
}
