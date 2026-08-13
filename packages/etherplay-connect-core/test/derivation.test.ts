import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex} from '@noble/hashes/utils';
import {secp256k1} from '@noble/curves/secp256k1';
import type {AccountGenerator, PrivateKeyAccount} from '@etherplay/wallet-connector';
import {
	delegationMessage,
	deriveOriginAccount,
	fromMnemonicToHDKey,
	fromPublicKey,
	fromSignatureToKey,
	originKeyMessage,
	originPublicKeyPublicationMessage,
	fromEntropyKeyToMnemonic,
} from '../src/index.js';
import type {EtherplayAccount} from '../src/types.js';

// A real signer, not a stub: a delegation credential is only worth testing if it is a signature
// somebody can actually recover an address from, the way the verifying contract will.
//
// The message bytes themselves are NOT pinned here. They are consensus between this and the
// Solidity that verifies them, so they are pinned in @etherplay/delegation against `vectors.json`,
// from both languages at once. What is pinned here is what this package is responsible for: which
// credentials get minted, for whom, and over which terms.
const EIP191MessagePrefix = '\x19Ethereum Signed Message:\n';
const encoder = new TextEncoder();

function hashTextMessage(message: string): Uint8Array {
	const bytes = encoder.encode(message);
	const prefixBytes = encoder.encode(`${EIP191MessagePrefix}${bytes.length}`);
	const full = new Uint8Array(prefixBytes.length + bytes.length);
	full.set(prefixBytes, 0);
	full.set(bytes, prefixBytes.length);
	return keccak_256(full);
}

const signedMessages: {message: string; privateKey: `0x${string}`}[] = [];

const accountGenerator: AccountGenerator = {
	type: 'ethereum',
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount {
		const hdkey = fromMnemonicToHDKey(mnemonic, index);
		if (!hdkey.privateKey) {
			throw new Error('invalid key');
		}
		return {
			// deliberately EIP-55 checksummed, like viem returns it, so the lowercasing the contract
			// depends on cannot silently come from the generator instead of from us.
			address: fromPublicKey(secp256k1.getPublicKey(hdkey.privateKey, false)) as `0x${string}`,
			privateKey: `0x${bytesToHex(hdkey.privateKey)}`,
			publicKey: `0x${bytesToHex(secp256k1.getPublicKey(hdkey.privateKey, false))}`,
		};
	},
	async signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`> {
		signedMessages.push({message, privateKey});
		const signature = secp256k1.sign(hashTextMessage(message), privateKey.slice(2));
		const postfix = signature.recovery === 1 ? '1c' : '1b';
		return `0x${signature.toCompactHex()}${postfix}`;
	},
};

function recoverAddress(message: string, signature: `0x${string}`): `0x${string}` {
	const hex = signature.slice(2);
	const recovery = Number.parseInt(hex.slice(128, 130), 16) - 27;
	const publicKey = secp256k1.Signature.fromCompact(hex.slice(0, 128))
		.addRecoveryBit(recovery)
		.recoverPublicKey(bytesToHex(hashTextMessage(message)))
		.toRawBytes(false);
	return fromPublicKey(publicKey).toLowerCase() as `0x${string}`;
}

const ORIGIN = 'https://app.example.com';
const ACCOUNT_KEY = `0x${'11'.repeat(32)}` as const;
const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;
const OTHER_CONTRACT = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const;

function anAccount(): EtherplayAccount {
	const mnemonic = fromEntropyKeyToMnemonic(ACCOUNT_KEY);
	return {
		localAccount: {
			address: accountGenerator.fromMnemonicToAccount(mnemonic, 0).address,
			index: 0,
			key: ACCOUNT_KEY,
		},
		signer: {mechanismUsed: {type: 'email', email: 'test@example.com', mode: 'otp'}},
		accountType: accountGenerator.type,
	};
}

// Hard constraint: the derived signer address is a pure function of the account key and this
// message. Changing it re-derives every existing user onto a different signer, orphaning funds and
// onchain state attached to the old one, with no migration path.
describe('originKeyMessage', () => {
	it('is exactly these bytes', () => {
		expect(originKeyMessage(ORIGIN)).toBe(
			'Origin: https://app.example.com\n' +
				'\n' +
				'IMPORTANT: Only sign on trusted websites.\n' +
				'\n' +
				'This grants access to your private session account.\n' +
				'\n' +
				'Verify before proceeding.',
		);
	});
});

describe('deriveOriginAccount', () => {
	it('mints nothing when nothing was granted', async () => {
		signedMessages.length = 0;
		const originAccount = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator);

		// A credential nobody approved must not exist. This is the whole enforcement: not a flag on
		// something handed over anyway, but the thing never being produced.
		expect(originAccount.savedDelegations).toEqual([]);
		expect(signedMessages.map((m) => m.message)).toEqual([
			originKeyMessage(ORIGIN),
			originPublicKeyPublicationMessage(ORIGIN, originAccount.signer.publicKey),
		]);
	});

	it('mints one credential per granted pair, signed by the account, delegating to the signer', async () => {
		const account = anAccount();
		const deadline = 1767225600;
		const originAccount = await deriveOriginAccount(ORIGIN, account, accountGenerator, {
			delegations: [{chainId: 31337, contract: CONTRACT, deadline}],
		});

		expect(originAccount.savedDelegations).toHaveLength(1);
		const saved = originAccount.savedDelegations[0];
		expect(saved).toMatchObject({
			chainId: 31337,
			contract: CONTRACT,
			delegate: originAccount.signer.address,
			deadline,
		});

		// Exactly the claim the contract verifies: recovered from the bytes the contract rebuilds.
		const message = delegationMessage({
			delegate: originAccount.signer.address,
			contract: CONTRACT,
			chainId: 31337,
			deadline,
		});
		expect(recoverAddress(message, saved.signature)).toBe(account.localAccount.address.toLowerCase());
	});

	it('binds each credential to its own contract, chain and deadline', async () => {
		// The bound the whole design rests on, seen from this side: four grants that differ in one
		// field each must produce four different signatures. If any two collide, one of those fields
		// is not reaching the signed bytes, and a credential for one contract would be redeemable at
		// another.
		const originAccount = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator, {
			delegations: [
				{chainId: 31337, contract: CONTRACT, deadline: 0},
				{chainId: 31337, contract: OTHER_CONTRACT, deadline: 0},
				{chainId: 1, contract: CONTRACT, deadline: 0},
				{chainId: 31337, contract: CONTRACT, deadline: 1767225600},
			],
		});

		const signatures = originAccount.savedDelegations.map((d) => d.signature);
		expect(new Set(signatures).size).toBe(4);
	});

	it('carries the outcomes through, including the refusals', async () => {
		// A denial has to REACH the app. An absent credential says "you have nothing"; it does not
		// say whether the user declined, whether the wallet could not understand the request, or
		// whether the app forgot to ask, and those three call for different remedies.
		const outcomes = [
			{
				request: {type: 'delegation' as const, required: false, chainId: 1, contract: CONTRACT},
				granted: false as const,
				reason: 'denied' as const,
			},
			{
				request: {type: 'unrecognized' as const, required: false, requestedType: 'teleport'},
				granted: false as const,
				reason: 'unsupported' as const,
			},
		];
		const originAccount = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator, {permissions: outcomes});

		expect(originAccount.permissions).toEqual(outcomes);
		expect(originAccount.savedDelegations).toEqual([]);
	});

	it('does not feed the credentials back into the signer derivation', async () => {
		const account = anAccount();
		const originAccount = await deriveOriginAccount(ORIGIN, account, accountGenerator, {
			delegations: [{chainId: 1, contract: CONTRACT, deadline: 0}],
		});

		// re-derive by hand from originKeyMessage alone, as before any of this existed
		const accountObject = accountGenerator.fromMnemonicToAccount(
			fromEntropyKeyToMnemonic(account.localAccount.key),
			account.localAccount.index,
		);
		const originKeySignature = await accountGenerator.signTextMessage(
			originKeyMessage(ORIGIN),
			accountObject.privateKey,
		);
		const expected = accountGenerator.fromMnemonicToAccount(
			fromEntropyKeyToMnemonic(fromSignatureToKey(originKeySignature)),
			0,
		);

		expect(originAccount.signer.address).toBe(expected.address);
	});

	it('derives the same signer and the same credentials every time', async () => {
		const grant = {delegations: [{chainId: 31337, contract: CONTRACT, deadline: 1767225600}]};
		const first = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator, grant);
		const second = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator, grant);

		// deterministic ECDSA: one delegate per account per origin, forever, on every device. This
		// is why the signer needs no nonce or index, and why a lost credential can always be
		// reminted by signing in again rather than migrated.
		expect(second.signer.address).toBe(first.signer.address);
		expect(second.savedDelegations).toEqual(first.savedDelegations);
	});

	it('keeps the credentials distinct from the public key publication signature', async () => {
		const originAccount = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator, {
			delegations: [{chainId: 1, contract: CONTRACT, deadline: 0}],
		});

		// a user who consented to an encryption key has not consented to a key that spends gas.
		expect(originAccount.savedDelegations[0].signature).not.toBe(originAccount.savedPublicKeyPublicationSignature);
	});
});
