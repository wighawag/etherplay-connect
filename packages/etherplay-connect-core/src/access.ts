import {allowlistLookup, type AllowlistLookup, type DelegationTarget} from './permissions.js';

/**
 * WHO MAY ASK FOR AN ACCOUNT THAT IS NOT THEIRS.
 *
 * A request is CROSS-ORIGIN when the window that opened the wallet is not the origin being signed
 * for: `evil.example` opening the popup with `signingOrigin=https://game.example` is asking for the
 * signer `game.example` derives, which is the whole of that account's authority there.
 *
 * The answer is NO, unless the origin whose account is at stake has said otherwise. That default is
 * affordable because there is now a way to do this properly: a delegation contract authorises MANY
 * delegates, so a third-party site can bring its OWN origin signer and have the user register it
 * onchain. That costs a transaction, which is why the consent list below still exists, but it means
 * refusing is no longer refusing the use case.
 *
 * WHAT THIS IS NOT. It is not a guarantee that no page can obtain a cross-origin signer. In the
 * external-wallet path the app asks the user's own wallet to sign the origin message with no host
 * in the loop, and nothing here is consulted; the message text in the wallet's dialog is the only
 * gate there. What this does guarantee is that THIS HOST will not hand over an account for an
 * origin that did not agree to it.
 *
 * WHAT THE GUARANTEE RESTS ON, AND IT IS NOT IN THIS FILE. `windowOrigin` is a value the opener
 * writes; nothing here authenticates it, so a page can claim to be `https://game.example` and be
 * answered `same-origin`. What makes the lie worthless is DELIVERY, not this decision: the host
 * posts the result with `targetOrigin: windowOrigin` and only ever adopts an opener whose
 * `event.origin` matches, so a page that lies is instructing the browser to hand the account to a
 * window it is not. A claimed origin is therefore safe to decide on and unsafe to act on any other
 * way, and any future path that returns something to the app WITHOUT that origin lock breaks this
 * module's guarantee without touching this module.
 */

/**
 * What one signing origin accepts.
 *
 * `'*'` means "anyone may ASK", which is emphatically not "anyone is trusted": there is still a
 * human prompt, and it is a stronger one, because the host knows nothing about who is asking. An
 * array is the meaningful form: named requesters, matched exactly.
 */
export type CrossOriginConsent = '*' | string[];

/**
 * How a host looks up that consent.
 *
 * ASYNCHRONOUS ON PURPOSE, while every implementation is a hardcoded table. The table is expected
 * to become something fetched (a document served by the signing origin itself is self-attesting in
 * the way a central list is not), and an async boundary drawn later is a rewrite of every call
 * site, at the exact place where a rushed rewrite grants an account to the wrong page.
 */
export type CrossOriginConsentLookup = (signingOrigin: string) => Promise<CrossOriginConsent | undefined>;

/**
 * What the host does about the request, decided before anything is derived or signed.
 *
 * `basis` exists so the UI can say something true. A named requester and a wildcard are both a
 * prompt, but they are not the same prompt: one origin vouched for this specific site, the other
 * left its door open to everyone.
 */
export type AccessDecision =
	| {kind: 'same-origin'}
	| {kind: 'ask'; basis: 'named' | 'wildcard' | 'loopback'}
	| {kind: 'blocked'};

/** What the app is told when a request is refused, so it can offer the onchain path instead. */
export type CrossOriginBlocked = {
	message: string;
	type: 'cross-origin-blocked';
	windowOrigin: string;
	signingOrigin: string;
};

export function crossOriginBlockedError(request: {windowOrigin: string; signingOrigin: string}): CrossOriginBlocked {
	return {
		// Named in full, both of them. An app that gets this back has almost always misconfigured
		// `signingOrigin`, and the two strings side by side are the whole diagnosis.
		message: `${request.windowOrigin} may not request an account for ${request.signingOrigin}`,
		type: 'cross-origin-blocked',
		windowOrigin: request.windowOrigin,
		signingOrigin: request.signingOrigin,
	};
}

/**
 * One spelling for one origin.
 *
 * A browser hands over `https://game.example` already lowercased and without a trailing slash; a
 * table maintained by hand does not. Normalising both sides costs nothing and prevents the failure
 * that would otherwise be silent in the dangerous direction: an entry with a trailing slash that
 * never matches, leaving an origin's consent quietly ineffective.
 *
 * It normalises SPELLING and nothing else. No wildcards, no subdomain rules, no port tolerance:
 * every relaxation of this comparison is a way for one origin to be granted what was decided for
 * another.
 */
export function normalizeOrigin(origin: string): string {
	return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * One entry of a table keyed by origin, matched with only SPELLING normalised.
 *
 * Here rather than in the host that holds the table, because it is MATCHING: which key answers for
 * which origin decides whether a credential is minted with nobody in the loop, and that comparison
 * belongs where tests reach it. A host supplies the table and calls this.
 */
export function lookupByOrigin<T>(table: Record<string, T>, origin: string): T | undefined {
	const wanted = normalizeOrigin(origin);
	for (const key of Object.keys(table)) {
		if (normalizeOrigin(key) === wanted) {
			return table[key];
		}
	}
	return undefined;
}

/**
 * A LOCAL DEVELOPMENT PAGE, matched by parsing rather than by looking for a substring.
 *
 * `origin.includes('localhost')` also matches `https://localhost.evil.com`, which is a real domain
 * a real attacker can register, so the check is: a real URL, whose own `origin` is all the string
 * contains, over http(s), whose HOSTNAME IS EXACTLY a loopback name.
 *
 * A page cannot claim to be `http://localhost:3000` unless it is served from there, so the threat
 * this admits is not a remote site: it is untrusted code the user runs locally. That is why the
 * allowance below is a property of a development build of the host and not of the one holding real
 * accounts.
 */
export function isLoopbackOrigin(origin: string): boolean {
	const normalised = normalizeOrigin(origin);
	let url: URL;
	try {
		url = new URL(normalised);
	} catch {
		return false;
	}
	// Anything carrying a path, credentials or a query is not an origin, and must not be treated as
	// one: `http://localhost@evil.example` parses, and its host is `evil.example`.
	if (url.origin.toLowerCase() !== normalised) {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return false;
	}
	return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Decide, before anything is derived, whether this window may be signed for at all.
 *
 * Default-deny is the point: the absence of an entry is a refusal, not a prompt. A prompt naming
 * two origins is not a decision a user can make well, and the one case where it carries real
 * information (an origin that deliberately opened itself to another) is exactly the case an entry
 * records.
 */
export async function resolveAccess(
	request: {windowOrigin: string; signingOrigin: string},
	options: {consentFor: CrossOriginConsentLookup; allowLoopbackRequesters?: boolean},
): Promise<AccessDecision> {
	const windowOrigin = normalizeOrigin(request.windowOrigin);
	const signingOrigin = normalizeOrigin(request.signingOrigin);

	if (windowOrigin === signingOrigin) {
		return {kind: 'same-origin'};
	}

	const consent = await options.consentFor(signingOrigin);

	// An explicit naming wins over every fallback below, including the loopback allowance: an origin
	// that listed `http://localhost:5173` itself has vouched for it, which is more than a build flag
	// can say.
	if (Array.isArray(consent) && consent.map(normalizeOrigin).includes(windowOrigin)) {
		return {kind: 'ask', basis: 'named'};
	}

	if (consent === '*') {
		return {kind: 'ask', basis: 'wildcard'};
	}

	if (options.allowLoopbackRequesters && isLoopbackOrigin(windowOrigin)) {
		return {kind: 'ask', basis: 'loopback'};
	}

	return {kind: 'blocked'};
}

/**
 * Whether the prompt for this decision has to be confirmed twice.
 *
 * Only where nobody vouched for the requester. A wildcard says the signing origin accepts anyone,
 * and a loopback allowance says a build flag does, so in both cases the only party who knows
 * whether this particular site should be trusted is the person reading the screen. Making them say
 * so twice is not friction for its own sake: it is the difference between clicking through a
 * dialog and answering it.
 */
export function requiresSecondConfirmation(decision: AccessDecision): boolean {
	return decision.kind === 'ask' && decision.basis !== 'named';
}

/**
 * The access gate itself: one confirmation in, the state of the gate out.
 *
 * A counter and two comparisons, and it is here rather than in the component holding them because
 * of what it decides. It is the last thing between a request and an account, it is the only new
 * logic in this feature that a human clicks through, and a component in the host is somewhere no
 * test in this repository can reach.
 *
 * A decision that is not `ask` can never be granted through this path: `same-origin` needs no
 * confirming and `blocked` must not be confirmable at all, so the guard is a property of the
 * function rather than of whichever markup happens to render a button.
 */
export function confirmAccess(
	decision: AccessDecision,
	confirmationsGiven: number,
): {confirmationsGiven: number; accessGranted: boolean} {
	if (decision.kind !== 'ask') {
		return {confirmationsGiven, accessGranted: false};
	}
	const given = confirmationsGiven + 1;
	const required = requiresSecondConfirmation(decision) ? 2 : 1;
	return {confirmationsGiven: given, accessGranted: given >= required};
}

/** How many confirmations this decision needs, for a UI that wants to say so. */
export function confirmationsRequired(decision: AccessDecision): number {
	return requiresSecondConfirmation(decision) ? 2 : 1;
}

/**
 * Which (chain, contract) pairs may be signed with NOBODY IN THE LOOP, given how access was decided.
 *
 * SAME ORIGIN: the host's table for that origin, unchanged. Auto-signing there removes a prompt
 * that carried nothing, since an origin that can derive this signer silently gains nothing from a
 * delegation bounded to its own contract.
 *
 * NAMED CROSS-ORIGIN: the pair must be listed for BOTH origins. The argument is that once access
 * has been granted, the requester holds exactly the signer the signing origin holds, so a
 * delegation at a contract the signing origin is already allowlisted for is one its own flow would
 * have minted anyway. That argument needs both sides named, and it is why a wildcard does not
 * qualify: "anyone may ask" says nothing about who this is, so nothing is minted without a human.
 */
export function autoSignLookup(options: {
	windowOrigin: string;
	signingOrigin: string;
	access: AccessDecision;
	allowlistFor: (origin: string) => DelegationTarget[];
}): AllowlistLookup {
	if (options.access.kind === 'same-origin') {
		return allowlistLookup(options.allowlistFor(normalizeOrigin(options.windowOrigin)));
	}

	if (options.access.kind === 'ask' && options.access.basis === 'named') {
		const requester = allowlistLookup(options.allowlistFor(normalizeOrigin(options.windowOrigin)));
		const owner = allowlistLookup(options.allowlistFor(normalizeOrigin(options.signingOrigin)));
		return (request) => requester(request) && owner(request);
	}

	return () => false;
}
