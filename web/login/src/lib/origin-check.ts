/**
 * Ask @etherplay/connect-core whether the origin this window will DELIVER to is the origin the
 * opener is actually at, and hold the answer for whoever wants to say it.
 *
 * The comparison itself is not here. It is `describeOriginMismatch` in connect-core, next to the
 * other origin rules and under the tests that run in CI: a host that wrote its own comparison would
 * be writing the one comparison in this system that nothing checks. What is left here is the part
 * that can only be done in a browser, which is reading the two strings out of this window.
 *
 * IT ONLY WARNS. The opener's real origin comes from `document.referrer`, which a referrer policy
 * may strip entirely, so absence is "cannot tell" and never "mismatch". And the origin lock is
 * enforced by the browser regardless; this exists to make it explicable, not to make it correct.
 */
import {describeOriginMismatch} from '@etherplay/connect-core';

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

/**
 * The mismatch this window is running under, computed once.
 *
 * Skipped after an OAuth round trip: that is a full page load, so `document.referrer` is then the
 * identity provider rather than the opener, and comparing it would report a mismatch that is not
 * one.
 */
const mismatch = (() => {
	if (typeof window === 'undefined') {
		return undefined;
	}
	const params = new URL(location.href).searchParams;
	if (params.get('oauth-callback') === 'true') {
		return undefined;
	}
	return describeOriginMismatch(params.get('origin'), document.referrer ? originOf(document.referrer) : undefined);
})();

/** The whole explanation, for the one place that says it first. */
export const originMismatch: string | undefined = mismatch?.message;

/** One line, for the place that says it again at the moment the cost is paid. */
export const originMismatchBrief: string | undefined = mismatch?.brief;
