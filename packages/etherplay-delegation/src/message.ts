import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils';

/**
 * What one delegation authorises, and the whole of it.
 *
 * Every field is inside the signed bytes. Anything stored beside a signature is a CACHE of what is
 * in it, never metadata about it: if a stored copy disagrees with the signed copy there is no way
 * to notice locally, the signature simply fails to recover, so the remedy for a signature failure
 * is to throw the record away and ask for a fresh one rather than to report a contract error.
 */
export type DelegationTerms = {
	/** the address being authorised to act for the owner */
	delegate: `0x${string}`;
	/** the contract the authorisation is good at, and nowhere else */
	contract: `0x${string}`;
	/** the chain that contract is on */
	chainId: number | bigint;
	/** unix seconds after which the signature stops being registrable; 0 means no expiry */
	deadline: number | bigint;
};

// The verifying contract reproduces this wording literally, character for character, and renders
// both addresses lowercase. The wording, the field order and the casing are consensus, not style:
// change any of it and every signature ever generated silently stops verifying, with no error that
// points at the cause.
//
// The three implementations are this file, `contracts/Delegation.sol`, and whatever a third-party
// wallet writes. They are pinned against `vectors.json` at the root of this package, from both
// languages. NEVER change one side without the others and the vectors, in the same commit.
const HEAD =
	'IMPORTANT: Only sign this on a site you trust.\n' +
	'\n' +
	'This authorizes another address to act in your name onchain, at one contract.\n' +
	'You can withdraw it at any time by revoking it there.\n' +
	'\n' +
	'Delegate: ';

/**
 * The exact text an owner signs to authorise a delegate at one contract on one chain.
 *
 * Addresses are lowercased HERE rather than at the call site, so no caller can hand us an EIP-55
 * checksummed spelling that then fails to verify onchain. The deadline is decimal unix seconds, or
 * the word `never` for 0; `Expires` stays a line either way, since an absent line is easy for a
 * human to miss and easy for a parser to treat as an unset default.
 */
export function delegationMessage(terms: DelegationTerms): string {
	const expires = BigInt(terms.deadline) === 0n ? 'never' : BigInt(terms.deadline).toString(10);
	return (
		HEAD +
		terms.delegate.toLowerCase() +
		'\nContract: ' +
		terms.contract.toLowerCase() +
		'\nChain ID: ' +
		BigInt(terms.chainId).toString(10) +
		'\nExpires: ' +
		expires
	);
}

/**
 * The EIP-191 `personal_sign` digest of {@link delegationMessage}.
 *
 * The same bytes `SignatureUtils.textDigest` builds onchain: the text with the fixed prefix and its
 * own byte LENGTH in front. Exported so a wallet can check a signature it is about to store, and so
 * the vectors pin the digest rather than only the string - a length prefix computed in characters
 * instead of bytes produces an identical-looking message and a different digest.
 */
export function delegationDigest(terms: DelegationTerms): `0x${string}` {
	const message = utf8ToBytes(delegationMessage(terms));
	const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`);
	const full = new Uint8Array(prefix.length + message.length);
	full.set(prefix, 0);
	full.set(message, prefix.length);
	return `0x${bytesToHex(keccak_256(full))}`;
}
