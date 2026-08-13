import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DELEGATION_ABI} from '../../src/index.js';

/**
 * The exported ABI is exactly the Solidity's, and stays that way.
 *
 * `DELEGATION_ABI` is hand-written, so it reads as the contract's surface and ships without a build
 * artifact. The cost of that is drift, and this is where drift is caught: a parameter added on one
 * side, a `view` that became `payable`, an error removed - each changes a selector, and a client
 * built on a stale ABI does not fail loudly, it calls a function that is not there.
 *
 * The comparison is against the compiled artifacts of the interface (the six functions) and of the
 * libraries an adopter's ABI actually surfaces (the event and the errors). Together they are
 * precisely what a contract inheriting `UsingDelegation` exposes.
 */
type AbiEntry = {
	type: string;
	name?: string;
	stateMutability?: string;
	anonymous?: boolean;
	inputs?: {name: string; type: string; indexed?: boolean}[];
	outputs?: {name: string; type: string}[];
};

function artifactAbi(path: string): AbiEntry[] {
	return JSON.parse(readFileSync(new URL(`../../artifacts/contracts/${path}`, import.meta.url), 'utf-8')).abi;
}

/**
 * `internalType` is dropped: it is a solc annotation for tooling, carries no meaning for a caller,
 * and pinning it here would make the exported ABI harder to read for no safety at all. Everything
 * that changes a selector or a decode is kept.
 */
function normalise(entry: AbiEntry) {
	const params = (list: {name: string; type: string; indexed?: boolean}[] | undefined) =>
		(list ?? []).map((p) => ({
			name: p.name,
			type: p.type,
			...(p.indexed === undefined ? {} : {indexed: p.indexed}),
		}));
	return {
		type: entry.type,
		name: entry.name ?? '',
		...(entry.stateMutability === undefined ? {} : {stateMutability: entry.stateMutability}),
		...(entry.anonymous === undefined ? {} : {anonymous: entry.anonymous}),
		inputs: params(entry.inputs),
		...(entry.type === 'function' ? {outputs: params(entry.outputs)} : {}),
	};
}

function sorted(entries: AbiEntry[]) {
	return entries.map(normalise).sort((a, b) => `${a.type} ${a.name}`.localeCompare(`${b.type} ${b.name}`));
}

describe('DELEGATION_ABI', () => {
	it('is exactly what the Solidity exposes', () => {
		const compiled = [
			// the six external functions
			...artifactAbi('IDelegation.sol/IDelegation.json'),
			// the event that IS the enumeration API, and the errors the library raises
			...artifactAbi('Delegation.sol/Delegation.json'),
			// the errors an adopter surfaces from the utility libraries it forwards through
			...artifactAbi('utils/Payments.sol/Payments.json'),
			...artifactAbi('utils/SignatureUtils.sol/SignatureUtils.json'),
		];

		assert.deepEqual(sorted(DELEGATION_ABI as unknown as AbiEntry[]), sorted(compiled));
	});

	it('keeps the reads view rather than pure', () => {
		// `delegationMessage` and `delegationDigest` read `address(this)` and `block.chainid`, which
		// is what stops a caller choosing the contract and the chain a credential is good for. A
		// `pure` here would mean somebody had put them back in the arguments.
		for (const name of ['delegationMessage', 'delegationDigest', 'delegationStatus']) {
			const entry = DELEGATION_ABI.find((e) => e.type === 'function' && e.name === name);
			assert.equal((entry as {stateMutability?: string} | undefined)?.stateMutability, 'view', name);
		}
	});

	it('has no delegateOf', () => {
		// Removed with the move to a set: an account may have several delegates, so any single
		// address this returned would be a lie. Consumers ask about a pair instead.
		assert.equal(
			DELEGATION_ABI.some((entry) => entry.type === 'function' && entry.name === 'delegateOf'),
			false,
		);
	});
});
