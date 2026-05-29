// Zero-dependency crypto helpers built on the native Web Crypto API.
// Used by the Same-Origin Callback Bridge (domain-redirect fallback) to
// encrypt the credential exchange between the login popup and the parent window.
//
// Scheme: ECDH (P-256) for key agreement + AES-GCM (256-bit) for payload encryption.

export const bufToB64 = (buf: ArrayBuffer | Uint8Array): string =>
	btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));

export const b64ToBuf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export async function generateEcdhKeyPair(): Promise<CryptoKeyPair> {
	return window.crypto.subtle.generateKey(
		{name: 'ECDH', namedCurve: 'P-256'},
		true, // MUST be true so the public key is exportable
		['deriveKey'],
	);
}

export async function exportPublicKeyB64(key: CryptoKey): Promise<string> {
	const jwk = await window.crypto.subtle.exportKey('jwk', key);
	return btoa(JSON.stringify(jwk));
}

export async function importPublicKeyB64(b64: string): Promise<CryptoKey> {
	const jwk = JSON.parse(atob(b64));
	return window.crypto.subtle.importKey('jwk', jwk, {name: 'ECDH', namedCurve: 'P-256'}, true, []);
}

export async function deriveAesKey(
	privateKey: CryptoKey,
	otherPublicKey: CryptoKey,
	usage: KeyUsage[],
): Promise<CryptoKey> {
	return window.crypto.subtle.deriveKey(
		{name: 'ECDH', public: otherPublicKey},
		privateKey,
		{name: 'AES-GCM', length: 256},
		false,
		usage,
	);
}
