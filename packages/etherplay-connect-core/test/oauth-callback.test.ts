import {describe, expect, it} from 'vitest';
import {buildOAuthCallbackUrl, CARRIED_THROUGH_OAUTH} from '../src/oauth-callback.js';
import {parsePermissionRequests} from '../src/permissions.js';

const REDIRECTION = {
	windowOrigin: 'https://game.example',
	signingOrigin: 'https://game.example',
	id: '42',
};

function callbackParams(current: string, overrides?: {connection?: string}) {
	const url = buildOAuthCallbackUrl({
		baseUrl: 'https://wallet.example',
		redirection: REDIRECTION,
		provider: 'google',
		connection: overrides?.connection,
		current: new URLSearchParams(current),
	});
	return new URL(url).searchParams;
}

describe('buildOAuthCallbackUrl', () => {
	it('carries the declared permissions through the round trip', () => {
		// THE REGRESSION. Dropped here, the returning popup parses no request at all: it asks for
		// nothing, grants nothing and reports nothing, so the app receives an account with no
		// credentials and no refusal to explain them. Sign-in by email kept working the whole time,
		// which is why this survived.
		const permissions = JSON.stringify([
			{type: 'delegation', chainId: 1, contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', required: true},
		]);
		const params = callbackParams(`permissions=${encodeURIComponent(permissions)}`);

		expect(params.get('permissions')).toBe(permissions);
		// and it survives as the request it was, not merely as a string
		expect(parsePermissionRequests(JSON.parse(params.get('permissions') as string))).toEqual([
			{type: 'delegation', chainId: 1, contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', required: true},
		]);
	});

	it('names the callback, the flow and who it is for', () => {
		const params = callbackParams('');
		expect(Object.fromEntries(params)).toEqual({
			'oauth-callback': 'true',
			'oauth-redirection': 'true',
			type: 'oauth',
			origin: 'https://game.example',
			signingOrigin: 'https://game.example',
			id: '42',
			'oauth-provider': 'google',
		});
	});

	it('round-trips the origins exactly, whatever they contain', () => {
		// The host decides access on these two, so a mangled port or a lost scheme is not a cosmetic
		// problem: it is a different origin.
		const url = buildOAuthCallbackUrl({
			baseUrl: 'https://wallet.example',
			redirection: {windowOrigin: 'http://localhost:5173', signingOrigin: 'https://game.example:8443', id: '7'},
			provider: 'google',
			current: new URLSearchParams(),
		});
		const params = new URL(url).searchParams;
		expect(params.get('origin')).toBe('http://localhost:5173');
		expect(params.get('signingOrigin')).toBe('https://game.example:8443');
	});

	it('keeps a value containing & or # as ONE parameter', () => {
		// Why this is built with URLSearchParams and not concatenated.
		const params = callbackParams('permissions=a%26b%23c&log=x%26y');
		expect(params.get('permissions')).toBe('a&b#c');
		expect(params.get('log')).toBe('x&y');
	});

	it('keeps a parameter that was present without a value', () => {
		const params = callbackParams('debug&eruda');
		expect(params.has('debug')).toBe(true);
		expect(params.has('eruda')).toBe(true);
	});

	it('carries nothing that was not asked for', () => {
		// The callback URL is not a place to forward whatever happens to be on the popup URL: an
		// unknown parameter reaching the host is a parameter nobody decided to trust.
		const params = callbackParams('surprise=1&code=stolen');
		expect(params.has('surprise')).toBe(false);
		expect(params.has('code')).toBe(false);
	});

	it('adds the broker connection only when there is one', () => {
		expect(callbackParams('').has('oauth-connection')).toBe(false);
		expect(callbackParams('', {connection: 'google-oauth2'}).get('oauth-connection')).toBe('google-oauth2');
	});

	it('carries every parameter it names, and each exactly once', () => {
		const current = CARRIED_THROUGH_OAUTH.map((name, index) => `${name}=v${index}`).join('&');
		const url = buildOAuthCallbackUrl({
			baseUrl: 'https://wallet.example',
			redirection: REDIRECTION,
			provider: 'google',
			current: new URLSearchParams(current),
		});
		const params = new URL(url).searchParams;
		CARRIED_THROUGH_OAUTH.forEach((name, index) => {
			expect(params.getAll(name)).toEqual([`v${index}`]);
		});
	});
});
