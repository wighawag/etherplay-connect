import type {Redirection} from './types.js';

/**
 * WHAT THE POPUP MUST STILL KNOW WHEN IT COMES BACK FROM AN OAUTH PROVIDER.
 *
 * The OAuth round trip is a full page load: the popup navigates away to Google, comes back as a NEW
 * document, and remembers nothing. Everything it needs has to be in the callback URL, so anything
 * the app put on the popup URL and this list does not name is GONE, silently, and only on the OAuth
 * path. That is what makes an omission here so hard to notice: the same app works by email and
 * quietly loses a capability by Google.
 *
 * `permissions` is the case that proves it. It was missing for as long as the feature existed, so a
 * user signing in with Google got an account with no credentials AND no refusal explaining it,
 * which is exactly the "nobody asked" versus "you declined" ambiguity the per-entry outcomes exist
 * to remove.
 *
 * A LIST, in one place, rather than a variable per parameter at the call site: the previous shape
 * (one hand-concatenated string fragment each) is what let a parameter be forgotten with no error
 * anywhere. Adding a parameter to the popup URL means adding it here.
 */
export const CARRIED_THROUGH_OAUTH = [
	'account-type',
	/** what the app asked for beyond the account itself, as JSON */
	'permissions',
	/**
	 * Same-Origin Callback Bridge: the parent's public key. It must survive this round trip for the
	 * encrypted result to be deliverable at all when the opener link has been severed, which is the
	 * situation the bridge exists for.
	 */
	'domain-redirect-public-key',
	'eruda',
	'debug',
	'log',
	/** testing aid: forces the BroadcastChannel delivery path on the bridge page */
	'forceBroadcastChannel',
] as const;

/**
 * The URL the OAuth provider sends the user back to.
 *
 * Pure, and here rather than in the provider package, because what it encodes is the popup URL
 * CONTRACT: one side of it is written by `@etherplay/connect`, the other read by the host, and this
 * is the point where the two are re-joined after a full page load. A test can reach it here.
 *
 * Built with `URLSearchParams` rather than concatenated. Every value in it is data from somewhere
 * else (an origin, a JSON document, a public key), and hand-concatenation is how one containing `&`
 * or `#` stops being one parameter and becomes several.
 */
export function buildOAuthCallbackUrl(options: {
	baseUrl: string;
	redirection: Redirection;
	/** the OAuth provider id, e.g. `google` */
	provider: string;
	/** for multi-provider brokers (auth0), the connection to use */
	connection?: string;
	/** the popup URL as it stands right now, which is where the carried parameters come from */
	current: URLSearchParams;
}): string {
	const params = new URLSearchParams({
		'oauth-callback': 'true',
		'oauth-redirection': 'true',
		type: 'oauth',
		origin: options.redirection.windowOrigin,
		signingOrigin: options.redirection.signingOrigin,
		id: options.redirection.id,
		'oauth-provider': options.provider,
	});

	if (options.connection) {
		params.set('oauth-connection', options.connection);
	}

	for (const name of CARRIED_THROUGH_OAUTH) {
		if (options.current.has(name)) {
			// Presence is meaningful on its own: `?debug` and `?debug=1` both mean debug, and a
			// parameter that was present must not come back absent.
			params.set(name, options.current.get(name) || '');
		}
	}

	return `${options.baseUrl}/login/?${params.toString()}`;
}
