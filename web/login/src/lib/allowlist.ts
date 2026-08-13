/**
 * Which (origin, chainId, contract) triples this host will grant WITHOUT ASKING.
 *
 * HARDCODED AT BUILD TIME, and that is the safer end of the design rather than a shortcut: there is
 * no runtime fetch to poison, no config endpoint to compromise, and changing the list requires
 * shipping the host. If it ever becomes dynamic, its integrity has to come from something signed,
 * not from a plain HTTP response.
 *
 * WHY AUTO-SIGNING IS NOT A HOLE. It does not create authority, it removes a prompt exactly where
 * the prompt was worthless. An origin on this list can already derive this account's signer
 * silently, because the origin mechanism grants that unconditionally to whoever the page is. Adding
 * a delegation bounded to that same origin's own contract gives an attacker who has compromised
 * that origin nothing they did not already have, minus one click-through. The prompt is kept for
 * the case that carries information: an origin asking for a contract that is NOT its own.
 *
 * WHY MATCHING A CLAIMED ORIGIN IS SAFE. `windowOrigin` arrives as a query parameter and an app can
 * put anything in it. It buys nothing: the result is delivered with `postMessage(..., {targetOrigin:
 * windowOrigin})`, so a page that lies about being `https://game.example` is telling the browser to
 * deliver the credential only to a window actually at `https://game.example`, which it is not. The
 * lie yields a credential nobody receives.
 *
 * WHAT THIS LIST CANNOT DO IS REVOKE. If a listed origin is compromised, removing the entry stops
 * future auto-signing and reaches nobody who already holds a credential. That is what the deadline
 * below is for, and it is the only lever there is.
 */
import {allowlistLookup, deadlineIn, type DelegationTarget} from '@etherplay/connect-core';

/**
 * The TABLE lives here, in the host, hardcoded. The MATCHING lives in @etherplay/connect-core,
 * where it is covered by tests that run in CI: a match mints a credential with nobody in the loop,
 * so "does this pair match" is not a comparison to write twice or leave unchecked.
 */
export type AllowlistEntry = DelegationTarget;

/**
 * Origin to the pairs it may have without a prompt.
 *
 * Empty on purpose. An entry here is a standing decision to mint credentials for a third party with
 * no human in the loop, so it is added when a specific origin and contract are known to belong to
 * each other, and not before. A placeholder would be a wrong entry, which is worse than none.
 *
 *   'https://game.example': [{chainId: 1, contract: '0xe7f1...0512'}],
 */
export const ORIGIN_ALLOWLIST: Record<string, AllowlistEntry[]> = {};

/**
 * How long an auto-signed credential may be presented for.
 *
 * Set by how painful re-authentication is, not by how cheap the signature is. Minting needs the
 * account key, and this host is stateless, so a fresh credential means signing in again, which for
 * an email mechanism is another OTP round trip. Weeks to months therefore: comfortably outliving a
 * remembered session, bounding staleness rather than sessions. If this host ever gains a session of
 * its own, shorter deadlines become affordable and this should shrink.
 *
 * It exists at all because these are the credentials minted with NO HUMAN IN THE LOOP, which makes
 * them the ones an allowlist entry keeps producing after that entry turns out to be wrong.
 */
export const AUTO_SIGNED_LIFETIME_SECONDS = 90 * 24 * 60 * 60; // ~3 months

/**
 * Prompted credentials get no expiry, for now.
 *
 * Refreshing one costs a popup and re-consent in the middle of someone's game, and unlike the
 * auto-signed case there was a human at the moment of granting. Revocation is onchain and is the
 * real remedy here.
 */
export const PROMPTED_DEADLINE = 0;

export function allowlistFor(origin: string): AllowlistEntry[] {
	// An exact origin match, and nothing cleverer. No wildcards, no subdomain rules, no port
	// tolerance: every relaxation of this comparison is a way for an origin to be granted something
	// that was decided for a different one.
	return ORIGIN_ALLOWLIST[origin] || [];
}

export function isAllowlisted(origin: string, request: DelegationTarget): boolean {
	return allowlistLookup(allowlistFor(origin))(request);
}

/** The deadline to stamp on an auto-signed credential, in unix seconds. */
export function autoSignedDeadline(now: number = Date.now()): number {
	return deadlineIn(AUTO_SIGNED_LIFETIME_SECONDS, now);
}
