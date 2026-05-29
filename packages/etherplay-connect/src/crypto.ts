// Zero-dependency Web Crypto helpers for the Same-Origin Callback Bridge
// (domain-redirect fallback). Implementation lives in @etherplay/connect-core
// so it can be shared with the login app; re-exported here per plan conventions.
export {
	bufToB64,
	b64ToBuf,
	generateEcdhKeyPair,
	exportPublicKeyB64,
	importPublicKeyB64,
	deriveAesKey,
} from '@etherplay/connect-core';
