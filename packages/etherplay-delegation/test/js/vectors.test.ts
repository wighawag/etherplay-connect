import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {delegationMessage, delegationDigest, type DelegationTerms} from '../../src/index.js';

/**
 * The consensus check, from the TypeScript side.
 *
 * The same `vectors.json` the Solidity suite reads (test/solidity/Vectors.t.sol). Two languages
 * against one file is the whole reason this package exists: a mismatch between them is catastrophic
 * and silent, because a signature over a message that differs by one byte does not fail loudly, it
 * recovers a different address.
 *
 * If this fails, the change is not a wording change. It invalidates every delegation signature ever
 * generated, and the Solidity, the vectors and this builder have to move together, in one commit.
 */
type Vector = DelegationTerms & {
	name: string;
	why: string;
	message: string;
	digest: `0x${string}`;
};

const vectors: Vector[] = JSON.parse(readFileSync(new URL('../../vectors.json', import.meta.url), 'utf-8')).cases;

describe('vectors', () => {
	it('has cases at all', () => {
		// A vectors file that silently parsed to nothing would make every loop below vacuously pass.
		assert.ok(vectors.length >= 5, `expected the vectors file to hold cases, got ${vectors.length}`);
	});

	for (const vector of vectors) {
		describe(vector.name, () => {
			it('builds the exact message', () => {
				assert.equal(delegationMessage(vector), vector.message);
			});

			// The EIP-191 prefix carries the message's own length IN BYTES. An implementation that
			// counts UTF-16 units or characters instead produces an identical-looking message and a
			// different digest, which the string comparison above would not notice.
			it('builds the exact digest', () => {
				assert.equal(delegationDigest(vector), vector.digest);
			});
		});
	}

	it('renders addresses lowercase whatever casing it is handed', () => {
		// Not a restatement of the checksummed vector: this asserts the RELATIONSHIP, so it holds
		// for terms the vectors file does not happen to carry.
		const terms: DelegationTerms = {
			delegate: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
			contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
			chainId: 1,
			deadline: 0,
		};
		assert.equal(
			delegationMessage(terms),
			delegationMessage({
				...terms,
				delegate: terms.delegate.toLowerCase() as `0x${string}`,
				contract: terms.contract.toLowerCase() as `0x${string}`,
			}),
		);
		assert.ok(!delegationMessage(terms).includes(terms.delegate));
	});

	it('treats a deadline of zero as never, and one as a real expiry', () => {
		// The two are one character apart in the source and worlds apart in meaning.
		const terms = {
			delegate: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
			contract: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
			chainId: 1,
		} as const;
		assert.ok(delegationMessage({...terms, deadline: 0}).endsWith('\nExpires: never'));
		assert.ok(delegationMessage({...terms, deadline: 1}).endsWith('\nExpires: 1'));
	});

	it('accepts bigints as well as numbers, for the same bytes', () => {
		// A caller holding a chain id or a deadline as a bigint (which is what an RPC or a contract
		// read hands back) must not get a different message for it.
		const terms = {
			delegate: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',
			contract: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
		} as const;
		assert.equal(
			delegationMessage({...terms, chainId: 31337n, deadline: 1767225600n}),
			delegationMessage({...terms, chainId: 31337, deadline: 1767225600}),
		);
	});
});
