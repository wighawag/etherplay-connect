import {entropyToMnemonic, mnemonicToSeedSync} from '@scure/bip39';
import {hexToBytes, bytesToHex} from '@noble/hashes/utils';
import {wordlist} from '@scure/bip39/wordlists/english';
import {HDKey} from '@scure/bip32';
import {keccak_256} from '@noble/hashes/sha3';
import {secp256k1} from '@noble/curves/secp256k1';
import {delegationMessage} from '@etherplay/delegation';
import {deriveKeySet, originPublicKeyPublicationMessage} from 'delegated-identity';
import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {AuthMechanism, EtherplayAccount, OriginAccount, PermissionOutcome, SavedDelegation} from './types.js';

export function originKeyMessage(orig: string): string {
	return `Origin: ${orig}\n\nIMPORTANT: Only sign on trusted websites.\n\nThis grants access to your private session account.\n\nVerify before proceeding.`;
}
export function localKeyMessage(): string {
	return 'DO NOT ACCEPT THIS SIGNATURE REQUEST! This used by Etherplay Wallet to generate your seed phrase.';
}
// The origin-key publication message is NOT defined here any more. It is the ownership proof that
// other services (missiv, the push notification server, the trigger service) verify, so it lives in
// delegated-identity next to the verifier, as the one copy of it in the ecosystem: a second copy
// could drift and silently invalidate every signature hosted accounts saved over it. Its bytes are
// still pinned in this package's tests. Re-exported so existing imports keep working, with the key
// set it names: an Ed25519 signing key and an X25519 encryption key derived from the origin signer.
export {originPublicKeyPublicationMessage, deriveKeySet, type KeySet} from 'delegated-identity';
// The delegation message is NOT defined here any more. It is consensus between three
// implementations - the verifying contract, this one, and any third-party wallet - so it lives in
// @etherplay/delegation next to the Solidity that verifies it and the vectors that pin the two
// together, where a change to either side fails a test instead of silently invalidating every
// signature ever generated. Re-exported so callers have one import for the whole feature.
export {delegationMessage, delegationDigest, DELEGATION_ABI, type DelegationTerms} from '@etherplay/delegation';

export function fromEntropyKeyToMnemonic(entropyKey: `0x${string}`): string {
	return entropyToMnemonic(hexToBytes(entropyKey.slice(2)), wordlist);
}

export function fromSignatureToKey(signature: `0x${string}`): `0x${string}` {
	const hash = keccak_256(hexToBytes(signature.slice(2)));
	return `0x${bytesToHex(hash)}`;
}

export function fromMnemonicToHDKey(mnemonic: string, index: number): HDKey {
	const seed = mnemonicToSeedSync(mnemonic);
	const hd = HDKey.fromMasterSeed(seed);
	return hd.derive(`m/44'/60'/0'/0/${index}`);
}

export function deriveEtherplayAccount(
	key: `0x${string}`,
	mechanism: AuthMechanism,
	accountGenerator: AccountGenerator,
): EtherplayAccount {
	const mnemonic = fromEntropyKeyToMnemonic(key);
	return {
		localAccount: {
			address: accountGenerator.fromMnemonicToAccount(mnemonic, 0).address,
			index: 0,
			key,
		},
		signer: {
			mechanismUsed: mechanism,
		},
		accountType: accountGenerator.type,
	};
}

/**
 * Derive the origin account, and mint the credentials that were granted along with it.
 *
 * `delegations` is what to sign, one per (chainId, contract) the host resolved as granted. Nothing
 * is signed for anything absent from it: a credential nobody approved must not exist, and this is
 * the only place that decides what does.
 */
export async function deriveOriginAccount(
	origin: string,
	account: EtherplayAccount,
	accountGenerator: AccountGenerator,
	granted?: {
		delegations?: {chainId: number; contract: `0x${string}`; deadline: number}[];
		permissions?: PermissionOutcome[];
	},
): Promise<OriginAccount> {
	const accountMnemonic = fromEntropyKeyToMnemonic(account.localAccount.key);
	const accountObject = accountGenerator.fromMnemonicToAccount(accountMnemonic, account.localAccount.index);

	const originKeySignature = await accountGenerator.signTextMessage(originKeyMessage(origin), accountObject.privateKey);

	const originKey = fromSignatureToKey(originKeySignature);
	const originMnemonic = fromEntropyKeyToMnemonic(originKey);
	const originAccount = accountGenerator.fromMnemonicToAccount(originMnemonic, 0);
	// Beside the origin signer, not instead of it: the signer stays the on-chain delegate of
	// `savedDelegations`, while services that check a delegated request (missiv, the push
	// notification server, the trigger service) verify the Ed25519 key and encrypt to the X25519 one.
	// Derived from the signer's private key, so every device of the account derives the same set.
	const keySet = deriveKeySet(originAccount.privateKey);

	// The publication names the key set, not the signer's secp256k1 key.
	const savedPublicKeyPublicationSignature = await accountGenerator.signTextMessage(
		originPublicKeyPublicationMessage(origin, keySet),
		accountObject.privateKey,
	);

	// Pre-generated because a hosted account holds its key at the wallet host and exposes no live
	// arbitrary-signing capability: sign-in is the only moment these can be produced. One per
	// (chainId, contract), because that pair is the whole extent of what each one authorizes, and
	// each carries the deadline it was signed with rather than being open-ended.
	//
	// Signed by the ACCOUNT key, delegating to the origin signer: exactly the claim the contract
	// verifies, which is "account A allows signer S to act for it, here".
	const savedDelegations: SavedDelegation[] = [];
	for (const delegation of granted?.delegations || []) {
		const signature = await accountGenerator.signTextMessage(
			delegationMessage({
				delegate: originAccount.address,
				contract: delegation.contract,
				chainId: delegation.chainId,
				deadline: delegation.deadline,
			}),
			accountObject.privateKey,
		);
		savedDelegations.push({
			chainId: delegation.chainId,
			contract: delegation.contract,
			delegate: originAccount.address,
			deadline: delegation.deadline,
			signature,
		});
	}

	return {
		address: account.localAccount.address,
		signer: {
			origin,
			publicKey: originAccount.publicKey,
			address: originAccount.address,
			privateKey: originAccount.privateKey,
		},
		keySet,
		metadata: {},
		mechanismUsed: account.signer.mechanismUsed,
		savedPublicKeyPublicationSignature,
		savedDelegations,
		permissions: granted?.permissions,
		accountType: accountGenerator.type,
	};
}

///////////////////////////////////////////////////////////////////////////////////////////////////
// TAKEN FROM https://github.com/paulmillr/micro-eth-signer/
///////////////////////////////////////////////////////////////////////////////////////////////////
const ethHexStartRe = /^0[xX]/;
export function strip0x(hex: string): string {
	return hex.replace(ethHexStartRe, '');
}
export function add0x(hex: string): string {
	return ethHexStartRe.test(hex) ? hex : `0x${hex}`;
}

export function astr(str: unknown) {
	if (typeof str !== 'string') throw new Error('string expected');
}

const RE = /^(0[xX])?([0-9a-fA-F]{40})?$/;
export function parse(address: string) {
	astr(address);
	const res = address.match(RE) || [];
	const hasPrefix = res[1] != null;
	const data = res[2];
	if (!data) {
		const len = hasPrefix ? 42 : 40;
		throw new Error(`address must be ${len}-char hex, got ${address.length}-char ${address}`);
	}
	return {hasPrefix, data};
}

export function addChecksum(nonChecksummedAddress: string): string {
	const low = parse(nonChecksummedAddress).data.toLowerCase();
	const hash = bytesToHex(keccak_256(low));
	let checksummed = '';
	for (let i = 0; i < low.length; i++) {
		const hi = Number.parseInt(hash[i], 16);
		const li = low[i];
		checksummed += hi <= 7 ? li : li.toUpperCase(); // if char is 9-f, upcase it
	}
	return add0x(checksummed);
}

export function fromPublicKey(key: string | Uint8Array): string {
	if (!key) throw new Error('invalid public key: ' + key);
	const pub65b = secp256k1.ProjectivePoint.fromHex(key).toRawBytes(false);
	const hashed = keccak_256(pub65b.subarray(1, 65));
	return addChecksum(bytesToHex(hashed).slice(24)); // slice 24..64
}

export function fromPrivateKey(key: string | Uint8Array): string {
	if (typeof key === 'string') key = strip0x(key);
	return fromPublicKey(secp256k1.getPublicKey(key, false));
}
///////////////////////////////////////////////////////////////////////////////////////////////////

export type * from './types.js';
export * from './crypto.js';
export * from './permissions.js';
export * from './access.js';
export * from './oauth-callback.js';
export * from './local-provider.js';
