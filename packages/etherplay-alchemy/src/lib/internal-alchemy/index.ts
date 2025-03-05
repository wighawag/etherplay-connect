import type { User } from '@account-kit/signer';
import { AlchemyWebSigner } from '@account-kit/signer';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { wordlist } from '@scure/bip39/wordlists/english';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { HDKey } from '@scure/bip32';
import { getPublicKey } from '@noble/secp256k1';

const TURNKEY_IFRAME_CONTAINER_ID = 'turnkey-iframe-container';

const EIP191MessagePrefix = '\x19Ethereum Signed Message:\n';
const encoder = new TextEncoder();

export { AlchemyWebSigner };

export type { User };

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

export function concatUint8Arrays(values: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const arr of values) {
		length += arr.length;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const arr of values) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

export function hashTextMessage(str: string): string {
	const bytes = encoder.encode(str);
	const prefixBytes = encoder.encode(`${EIP191MessagePrefix}${bytes.length}`);
	const fullBytes = concatUint8Arrays([prefixBytes, bytes]);
	return bytesToHex(keccak_256(fullBytes));
}

export function fromEntropyKeyToMnemonic(entropyKey: `0x${string}`): string {
	return entropyToMnemonic(hexToBytes(entropyKey.slice(2)), wordlist);
}

export function signTextMessage(str: string, privateKey: `0x${string}`): `0x${string}` {
	const hash = hashTextMessage(str);
	const signature = secp256k1.sign(hash, privateKey.slice(2));
	const r = signature.r;
	const s = signature.s;
	const v = signature.recovery ? 28n : 27n;
	const yParity = signature.recovery;
	let postfix = '';
	if (v === 27n || yParity === 0) {
		postfix = '1b';
	} else if (v === 28n || yParity === 1) {
		postfix = '1c';
	} else {
		throw new Error('Invalid v value');
	}
	return `0x${new secp256k1.Signature(r, s).toCompactHex()}${postfix}`;
}

export type SignerUser = {
	user: User;
	signer: AlchemyWebSigner;
};

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
	return { hasPrefix, data };
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

export function fromSignatureToKey(signature: `0x${string}`): `0x${string}` {
	const hash = keccak_256(hexToBytes(signature.slice(2)));
	return `0x${bytesToHex(hash)}`;
}

export function fromMnemonicToHDKey(mnemonic: string, index: number): HDKey {
	const seed = mnemonicToSeedSync(mnemonic);
	const hd = HDKey.fromMasterSeed(seed);
	return hd.derive(`m/44'/60'/0'/0/${index}`);
}

export function fromMnemonicToAccount(
	mnemonic: string,
	index: number
): {
	address: `0x${string}`;
	publicKey: `0x${string}`;
	privateKey: `0x${string}`;
} {
	const hdkey = fromMnemonicToHDKey(mnemonic, index);
	if (!hdkey.privateKey) {
		throw new Error(`invalid key`);
	}
	const privateKey = `0x${bytesToHex(hdkey.privateKey)}` as `0x${string}`;
	return {
		address: fromPrivateKey(hdkey.privateKey) as `0x${string}`,
		privateKey,
		publicKey: toHex(getPublicKey(privateKey))
	};
}

export function fromMnemonicToFirstAccount(mnemonic: string): {
	address: `0x${string}`;
	publicKey: `0x${string}`;
	privateKey: `0x${string}`;
} {
	return fromMnemonicToAccount(mnemonic, 0);
}

// export function fromMnemonicSignToGenerateEntropyKey(
// 	mnemonic: string,
// 	accountIndex: number,
// 	msg: string
// ): `0x${string}` {
// 	const account = fromMnemonicToHDKey(mnemonic, accountIndex);
// 	if (!account.privateKey) {
// 		throw new Error(`hd key do not generate account with private key`);
// 	}
// 	const signature = signTextMessage(msg, `0x${bytesToHex(account.privateKey)}`);
// 	return fromSignatureToKey(signature);
// }

export type AlchemySettings = { rpcURL: string } | { apiKeyNotRecommended: string };

export function createAlchemyOnBoarding(
	settings: AlchemySettings,
	options?: { sessionKey?: string; orgId?: string }
) {
	const sessionKey = options?.sessionKey || 'alchemy-signer-session';

	let popupIsPrepared: boolean = false;
	let signer: AlchemyWebSigner | undefined;

	async function init(params?: { preparePopup?: boolean }): Promise<AlchemyWebSigner> {
		if (!signer) {
			console.log(`setting up iframe container...`);
			const existingContainer = document.getElementById(TURNKEY_IFRAME_CONTAINER_ID);
			if (!existingContainer) {
				const container = document.createElement('div');
				container.id = TURNKEY_IFRAME_CONTAINER_ID;
				container.style.display = 'none';
				document.body.appendChild(container);
			}

			console.log(`creating signer using orgId: ${options?.orgId}...`);
			signer = new AlchemyWebSigner({
				client: {
					// This is created in your dashboard under `https://dashboard.alchemy.com/settings/access-keys`
					// NOTE: it is not recommended to expose your API key on the client, instead proxy requests to your backend and set the `rpcUrl`
					// here to point to your backend.
					connection:
						'apiKeyNotRecommended' in settings
							? { apiKey: settings.apiKeyNotRecommended }
							: { rpcUrl: settings.rpcURL },
					iframeConfig: {
						// you will need to render a container with this id in your DOM
						iframeContainerId: TURNKEY_IFRAME_CONTAINER_ID
					},
					rootOrgId: options?.orgId
				},
				sessionConfig: {
					expirationTimeMs: 1 * 60 * 60 * 1000,
					sessionKey
				}
			});

			if (params?.preparePopup) {
				console.log('preparePopupOauth...');
				await signer.preparePopupOauth();
				popupIsPrepared = true;
			}
		}

		return signer;
	}

	async function preparePopup() {
		if (!signer) {
			throw new Error(`no signer initialised`);
		}
		await signer.preparePopupOauth();
		popupIsPrepared = true;
	}

	async function loginViaEmail(
		email: string,
		emailMode: 'otp' | 'magicLink'
	): Promise<SignerUser | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}

		// TODO we don't do that untile we can determine if this is the same account
		// email are not the right wa to that on its own since google account can share same email as email account
		//  and yet have a different signer
		// console.log(`initial signer.getAuthDetails...`);
		// const user = await signer.getAuthDetails().catch(() => null);
		// // TODO and same auth method
		// if (user && user.email == email) {
		// 	console.log({user});
		// 	console.log(`same email , we are already logged in.`);
		// 	return {user, signer};
		// }

		console.log(`signer.authenticate with email ...`);
		const newUser = await signer.authenticate({
			type: 'email',
			emailMode,
			email
		});

		console.log({ newUser });

		if (newUser) {
			console.log(`signer.getAuthDetails...`);
			const user = await signer.getAuthDetails();
			return { user, signer };
		} else {
			console.log(`no user`);
			return null;
		}
	}

	async function loginViaOAuth(
		provider: { id: 'google' } | { id: 'facebook' } | { id: 'auth0'; connection: string },
		redirection?: { origin: string; id: string }
	): Promise<SignerUser | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}

		// const user = await signer.getAuthDetails().catch(() => null);

		// console.log({user});

		console.log('authenticating...');

		const authProviderId = provider.id;
		const auth0Connection =
			typeof provider === 'object' && provider.id === 'auth0' ? provider.connection : undefined;

		let newUser: User | undefined;

		if (redirection) {
			let erudaStr = '';
			const currentURL = new URL(location.href);
			if (currentURL.searchParams.has('_d_eruda')) {
				const value = currentURL.searchParams.get('_d_eruda');
				erudaStr = value ? `&_d_eruda=${value}` : '&_d_eruda';
			}
			const redirectUrl = `/login/?type=oauth-redirect&origin=${redirection.origin}&id=${redirection.id}&oauth-provider=${authProviderId}${auth0Connection ? `&oauth-connection=${auth0Connection}` : ''}${options?.orgId ? `&orgId=${options.orgId}` : ''}${erudaStr}`;
			console.log({ redirectUrl });
			if (authProviderId === 'auth0') {
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					auth0Connection,
					mode: 'redirect',
					redirectUrl
				});
			} else {
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					mode: 'redirect',
					redirectUrl
				});
			}
		} else {
			if (authProviderId === 'auth0') {
				console.log(`auth0:${auth0Connection}`);
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					auth0Connection,
					mode: 'popup'
				});
			} else {
				console.log(`oauth:${authProviderId}`);
				newUser = await signer.authenticate({
					type: 'oauth',
					authProviderId,
					mode: 'popup'
				});
			}
		}

		console.log({ newUser });

		if (newUser) {
			const user = await signer.getAuthDetails();
			return { user, signer };
		} else {
			return null;
		}
	}

	async function completeEmailLoginViaBundle(
		bundle: string,
		orgId?: string
	): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			await signer.authenticate({ type: 'email', bundle, orgId });

			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return { user, signer };
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with bundle`, err);
			return null;
		}
	}

	async function completeOAuthWithBundle(
		alchemyBundle: string,
		alchemyOrgId: string,
		alchemyIdToken: string
	): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			await signer.authenticate({
				type: 'oauthReturn',
				bundle: alchemyBundle,
				orgId: alchemyOrgId,
				idToken: alchemyIdToken
			});

			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return { user, signer };
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with bundle`, err);
			return null;
		}
	}

	async function completeEmailLoginViaOTP(otpCode: string): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		try {
			await signer.authenticate({ type: 'otp', otpCode });

			const user = await signer.getAuthDetails().catch(() => null);
			if (user) {
				return { user, signer };
			} else {
				return null;
			}
		} catch (err) {
			console.error(`failed to authenticate with otp`, err);
			throw new Error(`failed to authenticate with otp`, { cause: err });
		}
	}

	async function getUserSigner(): Promise<{
		user: User;
		signer: AlchemyWebSigner;
	} | null> {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}
		const user = await signer.getAuthDetails().catch(() => null);
		if (user) {
			return { user, signer };
		} else {
			return null;
		}
	}

	async function sign(msg: string) {
		if (!signer) {
			throw new Error(`Alchemy Onboarding not initialised`);
		}

		return signer.signMessage(msg);
	}

	async function signToGenerateEntropyKey(msg: string): Promise<`0x${string}`> {
		let signature: `0x${string}`;
		try {
			signature = await sign(msg);
		} catch {
			try {
				signature = await sign(msg);
			} catch {
				signature = await sign(msg);
			}
		}
		return fromSignatureToKey(signature);
	}

	// function getSession(): AlchemySessionInStorage | undefined {
	// 	const fromStorage = localStorage.getItem(sessionKey);
	// 	if (fromStorage) {
	// 		const session = JSON.parse(fromStorage);
	// 		return session as AlchemySessionInStorage;
	// 	}
	// }

	return {
		init,
		loginViaEmail,
		loginViaOAuth,
		sign,
		getUserSigner,
		preparePopup,
		get signer() {
			return signer;
		},
		get popupIsPrepared() {
			return popupIsPrepared;
		},
		completeEmailLoginViaBundle,
		completeOAuthWithBundle,
		completeEmailLoginViaOTP,
		signToGenerateEntropyKey
		// getSession,
	};
}
