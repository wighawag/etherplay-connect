/**
 * THE TWO STANDING DECISIONS THIS HOST MAKES ABOUT ORIGINS, AND THEY POINT IN OPPOSITE DIRECTIONS.
 *
 * `ORIGIN_ALLOWLIST` is keyed by the REQUESTER: which (origin, chainId, contract) triples are
 * granted without asking. `CROSS_ORIGIN_ALLOWLIST` is keyed by the origin WHOSE ACCOUNT IS AT
 * STAKE: which origins accept being requested by somebody else at all, without which such a request
 * is refused rather than prompted.
 *
 * BOTH ARE HARDCODED AT BUILD TIME IN THE HOST THAT HOLDS REAL ACCOUNTS, and that is the safer end
 * of the design rather than a shortcut: nothing fetched at runtime can reach these tables, no config
 * endpoint can compromise them, and changing the list requires shipping the host. If they ever
 * become dynamic there, their integrity has to come from something signed, not from a plain HTTP
 * response.
 *
 * Said precisely, because a production build does make one runtime request: it looks for a
 * configuration document SOLELY so that it can shout if it finds one (see config.ts), and discards
 * what comes back without reading a field of it. What the argument above rests on is not the
 * absence of a request, it is that no value from one is ever applied.
 *
 * The DEVELOPMENT build does apply them (see config.ts), which does not weaken any of this: it is a
 * different artefact, built with a different flag, holding nothing worth protecting.
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
import {deadlineIn, lookupByOrigin, type CrossOriginConsent, type DelegationTarget} from '@etherplay/connect-core';
import {DEVELOPMENT_BUILD, hostConfig} from './config';

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
 * Empty in the PRODUCTION build is the statement that matters; a development build may be handed a
 * table by its runtime document, which is how a test exercises auto-signing at all.
 *
 *   'https://game.example': [{chainId: 1, contract: '0xe7f1...0512'}],
 */
export const ORIGIN_ALLOWLIST: Record<string, AllowlistEntry[]> = hostConfig().originAllowlist;

/**
 * WHICH ORIGINS ACCEPT BEING ASKED FOR BY SOMEBODY ELSE.
 *
 * A different table on a different axis from the one above, and they must not be confused. That one
 * is keyed by the REQUESTER and removes a prompt. This one is keyed by the origin WHOSE ACCOUNT IS
 * AT STAKE, and without an entry there is no prompt to remove: the request is refused.
 *
 * Refusing is affordable because delegation admits many delegates. A third-party site can bring its
 * own origin signer and have the user register it onchain at the contract, which costs a
 * transaction but grants that site its own bounded, separately revocable authority instead of a
 * copy of somebody else's signer. This table is for the cases where that transaction is not
 * acceptable, and it is a standing statement by the listed origin that another site may act with
 * its account, so it is added when both parties are known and not before.
 *
 *   'https://game.example': ['https://tournament.example'],   // named, and matched exactly
 *   'https://open.example': '*',                              // anyone may ASK; the user is asked harder
 *
 * `'*'` is not a shortcut for a long list. It means the host knows nothing about who is asking, so
 * the prompt has to be confirmed twice and NOTHING is ever auto-signed under it.
 *
 * Hardcoded, like the table above, and for the same reason: no runtime fetch to poison. The lookup
 * is async so that a signed or self-served document (an origin publishing its own consent is
 * self-attesting in a way a central list is not) can replace this without touching a call site.
 */
export const CROSS_ORIGIN_ALLOWLIST: Record<string, CrossOriginConsent> = hostConfig().crossOriginAllowlist;

/**
 * Whether a page on this machine may ask for somebody else's account.
 *
 * DEVELOPMENT BUILDS ONLY, and deliberately not a property of the host that holds real accounts. A
 * remote site cannot claim to be `http://localhost:5173`, so what this admits is untrusted code the
 * user runs locally, asking for their real account behind a prompt that reads harmless. Working
 * against real accounts from a dev server is what a dev or staging wallet host is for.
 *
 * `VITE_ALLOW_LOOPBACK_CROSS_ORIGIN` exists so a self-hosted deployment can turn it on knowing what
 * it costs, rather than discovering the flag is welded to a build mode. It is read in config.ts,
 * with the same rule it always had: a development build allows it unless told not to, any other
 * build refuses it unless told to, and being told to is what this shouts about.
 */
export const ALLOW_LOOPBACK_REQUESTERS = hostConfig().allowLoopbackRequesters;

// Said out loud, every time, because the only thing standing between this allowance and a host that
// holds real accounts is how it was built. A production bundle reaches this line only if somebody
// set the variable to `true` deliberately, and this is what tells them they did.
if (ALLOW_LOOPBACK_REQUESTERS && !DEVELOPMENT_BUILD) {
	console.warn(
		'[etherplay] loopback cross-origin requesters are ALLOWED in this build: a page on the user machine ' +
			'may ask for another origin account. Unset VITE_ALLOW_LOOPBACK_CROSS_ORIGIN for a host holding real accounts.',
	);
}

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
export const AUTO_SIGNED_LIFETIME_SECONDS = hostConfig().autoSignedLifetimeSeconds;

/**
 * Prompted credentials get no expiry, for now: that is what a lifetime of 0 means, and it is the
 * default in every build.
 *
 * Refreshing one costs a popup and re-consent in the middle of someone's game, and unlike the
 * auto-signed case there was a human at the moment of granting. Revocation is onchain and is the
 * real remedy here. It is settable in a development build for the same reason the auto-signed one
 * is: expiry that cannot be made to happen is expiry nobody has ever seen work.
 */
export const PROMPTED_LIFETIME_SECONDS = hostConfig().promptedLifetimeSeconds;

// The TABLES are here; the MATCHING is `lookupByOrigin` in @etherplay/connect-core, where a test
// covers which key answers for which origin. An exact origin match and nothing cleverer: no
// wildcards, no subdomain rules, no port tolerance, since every relaxation of that comparison is a
// way for one origin to be granted what was decided for another.
export function allowlistFor(origin: string): AllowlistEntry[] {
	return lookupByOrigin(ORIGIN_ALLOWLIST, origin) || [];
}

// There is deliberately no `isAllowlisted(origin, pair)` helper here any more. Whether a pair may be
// signed with nobody in the loop depends on HOW ACCESS WAS DECIDED, not on one origin's table alone,
// and a helper that answered without the access decision is exactly the shortcut a later change
// would reach for. `autoSignLookup` in @etherplay/connect-core takes the decision and is tested
// against it; this file supplies the table it reads.

/**
 * What this host knows about an origin's willingness to be requested by others.
 *
 * A promise over a hardcoded object, which is the shape a fetched document would have. Undefined is
 * the answer for an origin that never said anything, and it means no.
 */
export async function crossOriginConsentFor(signingOrigin: string): Promise<CrossOriginConsent | undefined> {
	return lookupByOrigin(CROSS_ORIGIN_ALLOWLIST, signingOrigin);
}

/** The deadline to stamp on an auto-signed credential, in unix seconds. */
export function autoSignedDeadline(now: number = Date.now()): number {
	return deadlineIn(AUTO_SIGNED_LIFETIME_SECONDS, now);
}

/** The deadline to stamp on a credential a human granted, in unix seconds. `0` is no expiry. */
export function promptedDeadline(now: number = Date.now()): number {
	return PROMPTED_LIFETIME_SECONDS === 0 ? 0 : deadlineIn(PROMPTED_LIFETIME_SECONDS, now);
}
