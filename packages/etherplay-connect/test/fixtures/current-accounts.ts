// Accounts in the current format, for tests that seed storage or answer as the wallet host.
//
// A stored or returned account is only restored or signed in when it carries a key set and its
// saved publication signature is the account's own over `originPublicKeyPublicationMessage(origin,
// keySet)` (a wallet account may have none yet). So a hosted account here is a REAL one, built by
// `deriveOriginAccount` exactly as the wallet host builds it, and a wallet account carries a key set
// and no signature, which is what the wallet path stores until the app first asks for the publication.

import {
	deriveKeySet,
	deriveOriginAccount,
	fromEntropyKeyToMnemonic,
	type KeySet,
	type OriginAccount,
} from '@etherplay/connect-core';
import {EthereumAccountGenerator} from '@etherplay/wallet-connector-ethereum';

const generator = new EthereumAccountGenerator();
const ACCOUNT_ENTROPY = `0x${'11'.repeat(32)}` as const;

/** A key set as `deriveKeySet` derives it from a stored signer's private key. */
export function keySetOf(signerPrivateKey: `0x${string}`): KeySet {
	return deriveKeySet(signerPrivateKey);
}

/**
 * What the wallet host returns for a popup sign-in: `deriveOriginAccount` over a real account, so
 * its publication signature verifies for `origin`. `index` picks another account of the same
 * entropy; `overrides` replaces fields after derivation (a delegation list, the mechanism).
 */
export async function hostedAccount(
	origin: string,
	options?: {index?: number; overrides?: Partial<OriginAccount>},
): Promise<OriginAccount> {
	const index = options?.index ?? 0;
	const address = generator.fromMnemonicToAccount(fromEntropyKeyToMnemonic(ACCOUNT_ENTROPY), index).address;
	const derived = await deriveOriginAccount(
		origin,
		{
			localAccount: {address, index, key: ACCOUNT_ENTROPY},
			signer: {mechanismUsed: {type: 'email', email: 'user@example.com', mode: 'otp'}},
			accountType: generator.type,
		},
		generator,
	);
	return {...derived, metadata: {email: 'user@example.com'}, mechanismUsed: {type: 'email'}, ...options?.overrides};
}

/** A message signed (EIP-191) by the account `hostedAccount` returns for `index`, as the wallet host would sign it. */
export async function signAsHostedAccount(message: string, index = 0): Promise<`0x${string}`> {
	const account = generator.fromMnemonicToAccount(fromEntropyKeyToMnemonic(ACCOUNT_ENTROPY), index);
	return generator.signTextMessage(message, account.privateKey);
}
