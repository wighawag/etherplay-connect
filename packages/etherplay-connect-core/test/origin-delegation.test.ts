import {describe, expect, it} from 'vitest';
import {keccak_256} from '@noble/hashes/sha3';
import {bytesToHex} from '@noble/hashes/utils';
import {secp256k1} from '@noble/curves/secp256k1';
import type {AccountGenerator, PrivateKeyAccount} from '@etherplay/wallet-connector';
import {
	deriveOriginAccount,
	fromMnemonicToHDKey,
	fromPublicKey,
	fromSignatureToKey,
	originDelegationMessage,
	originKeyMessage,
	originPublicKeyPublicationMessage,
	fromEntropyKeyToMnemonic,
} from '../src/index.js';
import type {EtherplayAccount} from '../src/types.js';

// A real signer, not a stub: the delegation signature is only worth testing if it is a signature
// somebody can actually recover an address from, the way the verifying contract will.
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

describe('originDelegationMessage', () => {
	// The verifying contract reproduces this wording literally. If this test fails, the change is
	// not a wording change: it invalidates every delegation signature ever generated, and the
	// contract has to change in the same breath.
	it('is exactly these bytes', () => {
		expect(originDelegationMessage(ORIGIN, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045')).toBe(
			'Origin: https://app.example.com\n' +
				'\n' +
				'IMPORTANT: Only sign on trusted websites.\n' +
				'\n' +
				'This authorizes the following address to act on your behalf onchain:\n' +
				'\n' +
				'0xd8da6bf26964af9d7eed9e03e53415d37aa96045\n' +
				'\n' +
				'Apps at this origin can use it to send transactions in your name.',
		);
	});

	it('renders the delegate lowercased, whatever casing it is given', () => {
		// the contract renders the address lowercase; a checksummed spelling would not verify.
		expect(originDelegationMessage(ORIGIN, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(
			originDelegationMessage(ORIGIN, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'),
		);
	});
});

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
	it('pre-generates a delegation signature over the signer address, by the account key', async () => {
		const account = anAccount();
		const originAccount = await deriveOriginAccount(ORIGIN, account, accountGenerator);

		expect(originAccount.savedDelegationSignature).toBeDefined();
		const message = originDelegationMessage(ORIGIN, originAccount.signer.address);
		// signed by the account, delegating to the signer: exactly the claim the contract verifies.
		expect(recoverAddress(message, originAccount.savedDelegationSignature!)).toBe(
			account.localAccount.address.toLowerCase(),
		);
		expect(message).toContain(originAccount.signer.address.toLowerCase());
	});

	it('does not feed the new signature back into the signer derivation', async () => {
		const account = anAccount();
		const originAccount = await deriveOriginAccount(ORIGIN, account, accountGenerator);

		// re-derive by hand from originKeyMessage alone, as before this signature existed
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

	it('derives the same signer and the same delegation signature every time', async () => {
		const first = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator);
		const second = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator);

		// deterministic ECDSA: one delegate per account per origin, forever, on every device. This
		// is why the signature needs no nonce, index or expiry.
		expect(second.signer.address).toBe(first.signer.address);
		expect(second.savedDelegationSignature).toBe(first.savedDelegationSignature);
	});

	it('keeps the delegation signature distinct from the public key publication one', async () => {
		signedMessages.length = 0;
		const originAccount = await deriveOriginAccount(ORIGIN, anAccount(), accountGenerator);

		// a user who consented to an encryption key has not consented to a key that spends gas.
		expect(originAccount.savedDelegationSignature).not.toBe(originAccount.savedPublicKeyPublicationSignature);
		expect(signedMessages.map((m) => m.message)).toEqual([
			originKeyMessage(ORIGIN),
			originPublicKeyPublicationMessage(ORIGIN, originAccount.signer.publicKey),
			originDelegationMessage(ORIGIN, originAccount.signer.address),
		]);
	});
});
