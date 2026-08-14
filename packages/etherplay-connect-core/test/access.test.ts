import {describe, expect, it} from 'vitest';
import {
	autoSignLookup,
	confirmAccess,
	crossOriginBlockedError,
	isLoopbackOrigin,
	lookupByOrigin,
	normalizeOrigin,
	requiresSecondConfirmation,
	resolveAccess,
	type AccessDecision,
	type CrossOriginConsent,
} from '../src/access.js';
import type {DelegationTarget} from '../src/permissions.js';

const GAME = 'https://game.example';
const THIRD_PARTY = 'https://tournament.example';
const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;
const OTHER = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const;

function consentTable(table: Record<string, CrossOriginConsent>) {
	return async (signingOrigin: string) => table[signingOrigin];
}

const noConsent = async () => undefined;

describe('resolveAccess', () => {
	it('lets an origin sign for itself without asking', async () => {
		expect(await resolveAccess({windowOrigin: GAME, signingOrigin: GAME}, {consentFor: noConsent})).toEqual({
			kind: 'same-origin',
		});
	});

	it('blocks a cross-origin request by default', async () => {
		// The rule this file exists for. An absent entry is a REFUSAL, not a prompt: a third party
		// wanting to act for this user has its own delegate and an onchain registration to reach for.
		expect(await resolveAccess({windowOrigin: THIRD_PARTY, signingOrigin: GAME}, {consentFor: noConsent})).toEqual({
			kind: 'blocked',
		});
	});

	it('asks when the signing origin named the requester', async () => {
		expect(
			await resolveAccess(
				{windowOrigin: THIRD_PARTY, signingOrigin: GAME},
				{consentFor: consentTable({[GAME]: [THIRD_PARTY]})},
			),
		).toEqual({kind: 'ask', basis: 'named'});
	});

	it('blocks a requester the signing origin did not name', async () => {
		expect(
			await resolveAccess(
				{windowOrigin: 'https://evil.example', signingOrigin: GAME},
				{consentFor: consentTable({[GAME]: [THIRD_PARTY]})},
			),
		).toEqual({kind: 'blocked'});
	});

	it('blocks everyone when the consent list is empty', async () => {
		expect(
			await resolveAccess({windowOrigin: THIRD_PARTY, signingOrigin: GAME}, {consentFor: consentTable({[GAME]: []})}),
		).toEqual({kind: 'blocked'});
	});

	it('asks with the wildcard basis when the signing origin accepts anyone', async () => {
		// `'*'` is "anyone may ASK", never "anyone is trusted": it still reaches a human, and the
		// basis is carried so that human is told which of the two situations they are in.
		expect(
			await resolveAccess(
				{windowOrigin: 'https://whoever.example', signingOrigin: GAME},
				{consentFor: consentTable({[GAME]: '*'})},
			),
		).toEqual({kind: 'ask', basis: 'wildcard'});
	});

	it('does not consult consent for a same-origin request', async () => {
		// A signing origin cannot lock itself out of its own account by mistyping its own entry.
		let consulted = false;
		const decision = await resolveAccess(
			{windowOrigin: GAME, signingOrigin: GAME},
			{
				consentFor: async () => {
					consulted = true;
					return [];
				},
			},
		);
		expect(decision).toEqual({kind: 'same-origin'});
		expect(consulted).toBe(false);
	});

	it('matches origins that differ only in spelling', async () => {
		// A hand-maintained table with a trailing slash must not fail SILENTLY, which here would mean
		// an origin's consent quietly having no effect.
		expect(
			await resolveAccess(
				{windowOrigin: THIRD_PARTY, signingOrigin: GAME},
				{consentFor: consentTable({[GAME]: [`${THIRD_PARTY}/`]})},
			),
		).toEqual({kind: 'ask', basis: 'named'});

		expect(await resolveAccess({windowOrigin: `${GAME}/`, signingOrigin: GAME}, {consentFor: noConsent})).toEqual({
			kind: 'same-origin',
		});
	});

	it('does not treat a subdomain or a sibling port as the same origin', async () => {
		for (const windowOrigin of ['https://sub.game.example', 'https://game.example:8443', 'http://game.example']) {
			expect(await resolveAccess({windowOrigin, signingOrigin: GAME}, {consentFor: noConsent})).toEqual({
				kind: 'blocked',
			});
		}
	});

	describe('the loopback allowance', () => {
		it('is off unless the host asks for it', async () => {
			// The production host never carries it. Local code the user was talked into running is
			// exactly the case it would otherwise let through, with a prompt that reads harmless.
			expect(
				await resolveAccess({windowOrigin: 'http://localhost:5173', signingOrigin: GAME}, {consentFor: noConsent}),
			).toEqual({kind: 'blocked'});
		});

		it('asks, with its own basis, when the host is a development build', async () => {
			for (const windowOrigin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://[::1]:8080']) {
				expect(
					await resolveAccess(
						{windowOrigin, signingOrigin: GAME},
						{consentFor: noConsent, allowLoopbackRequesters: true},
					),
				).toEqual({kind: 'ask', basis: 'loopback'});
			}
		});

		it('does not cover a domain that merely looks local', async () => {
			// `localhost.evil.com` is a domain anyone can register, and a substring check is how it
			// gets treated as a developer's machine.
			for (const windowOrigin of [
				'https://localhost.evil.example',
				'https://notlocalhost',
				'https://127.0.0.1.evil.example',
			]) {
				expect(
					await resolveAccess(
						{windowOrigin, signingOrigin: GAME},
						{consentFor: noConsent, allowLoopbackRequesters: true},
					),
				).toEqual({kind: 'blocked'});
			}
		});

		it('yields to an explicit naming, which says more than a build flag', async () => {
			expect(
				await resolveAccess(
					{windowOrigin: 'http://localhost:5173', signingOrigin: GAME},
					{consentFor: consentTable({[GAME]: ['http://localhost:5173']}), allowLoopbackRequesters: true},
				),
			).toEqual({kind: 'ask', basis: 'named'});
		});
	});
});

describe('isLoopbackOrigin', () => {
	it('accepts the loopback names, on http and https, on any port', () => {
		for (const origin of [
			'http://localhost',
			'http://localhost:5173',
			'https://localhost:5173',
			'http://127.0.0.1:3000',
			'http://[::1]:8080',
		]) {
			expect(isLoopbackOrigin(origin)).toBe(true);
		}
	});

	it('rejects anything that is not exactly a loopback origin', () => {
		for (const origin of [
			'https://localhost.evil.example',
			'https://evil.example/localhost',
			'http://localhost@evil.example',
			'http://localhost:5173/path',
			'http://localhost:5173?x=1',
			'file://localhost',
			'not a url',
			'',
		]) {
			expect(isLoopbackOrigin(origin)).toBe(false);
		}
	});
});

describe('normalizeOrigin', () => {
	it('normalises spelling and nothing else', () => {
		expect(normalizeOrigin(' HTTPS://Game.Example/ ')).toBe('https://game.example');
		expect(normalizeOrigin('https://game.example:8443')).toBe('https://game.example:8443');
	});
});

describe('requiresSecondConfirmation', () => {
	it('is required exactly where nobody vouched for the requester', () => {
		expect(requiresSecondConfirmation({kind: 'ask', basis: 'wildcard'})).toBe(true);
		expect(requiresSecondConfirmation({kind: 'ask', basis: 'loopback'})).toBe(true);
		expect(requiresSecondConfirmation({kind: 'ask', basis: 'named'})).toBe(false);
		expect(requiresSecondConfirmation({kind: 'same-origin'})).toBe(false);
		expect(requiresSecondConfirmation({kind: 'blocked'})).toBe(false);
	});
});

describe('lookupByOrigin', () => {
	it('answers for the same origin written differently', () => {
		// A hand-maintained table with a capital or a trailing slash must not fail silently, which
		// here means an entry that never matches anything.
		expect(lookupByOrigin({'https://Game.Example/': 'entry'}, GAME)).toBe('entry');
	});

	it('does not answer for a different origin', () => {
		expect(lookupByOrigin({[GAME]: 'entry'}, 'https://sub.game.example')).toBeUndefined();
		expect(lookupByOrigin({[GAME]: 'entry'}, 'http://game.example')).toBeUndefined();
		expect(lookupByOrigin({}, GAME)).toBeUndefined();
	});
});

describe('confirmAccess', () => {
	it('grants a named request on the first confirmation', () => {
		expect(confirmAccess({kind: 'ask', basis: 'named'}, 0)).toEqual({confirmationsGiven: 1, accessGranted: true});
	});

	it('needs two where nobody vouched for the requester', () => {
		for (const basis of ['wildcard', 'loopback'] as const) {
			const first = confirmAccess({kind: 'ask', basis}, 0);
			expect(first).toEqual({confirmationsGiven: 1, accessGranted: false});
			expect(confirmAccess({kind: 'ask', basis}, first.confirmationsGiven)).toEqual({
				confirmationsGiven: 2,
				accessGranted: true,
			});
		}
	});

	it('cannot grant a blocked request, however many times it is called', () => {
		// The guard belongs to the gate, not to whichever markup renders a button.
		let state = {confirmationsGiven: 0, accessGranted: false};
		for (let i = 0; i < 5; i++) {
			state = confirmAccess({kind: 'blocked'}, state.confirmationsGiven);
		}
		expect(state).toEqual({confirmationsGiven: 0, accessGranted: false});
	});

	it('does not grant a same-origin request through this path either', () => {
		// Same-origin needs no confirming; it is granted where the decision is read, not by clicking.
		expect(confirmAccess({kind: 'same-origin'}, 0)).toEqual({confirmationsGiven: 0, accessGranted: false});
	});
});

describe('crossOriginBlockedError', () => {
	it('names both origins, since a misconfigured signingOrigin is the usual cause', () => {
		const error = crossOriginBlockedError({windowOrigin: THIRD_PARTY, signingOrigin: GAME});
		expect(error.type).toBe('cross-origin-blocked');
		expect(error.message).toContain(THIRD_PARTY);
		expect(error.message).toContain(GAME);
	});
});

describe('autoSignLookup', () => {
	const table: Record<string, DelegationTarget[]> = {
		[GAME]: [{chainId: 1, contract: CONTRACT}],
		[THIRD_PARTY]: [{chainId: 1, contract: CONTRACT}],
	};
	const allowlistFor = (origin: string) => table[origin] || [];
	const pair = {chainId: 1, contract: CONTRACT};

	it('uses the requester table when an origin signs for itself', () => {
		const lookup = autoSignLookup({
			windowOrigin: GAME,
			signingOrigin: GAME,
			access: {kind: 'same-origin'},
			allowlistFor,
		});
		expect(lookup(pair)).toBe(true);
		expect(lookup({chainId: 1, contract: OTHER})).toBe(false);
		expect(lookup({chainId: 10, contract: CONTRACT})).toBe(false);
	});

	it('requires the pair on BOTH sides for a named cross-origin request', () => {
		const named: AccessDecision = {kind: 'ask', basis: 'named'};
		expect(autoSignLookup({windowOrigin: THIRD_PARTY, signingOrigin: GAME, access: named, allowlistFor})(pair)).toBe(
			true,
		);

		// Listed for the requester, not for the account's own origin: no silent minting.
		const oneSided = (origin: string) => (origin === THIRD_PARTY ? table[THIRD_PARTY] : []);
		expect(
			autoSignLookup({windowOrigin: THIRD_PARTY, signingOrigin: GAME, access: named, allowlistFor: oneSided})(pair),
		).toBe(false);
	});

	it('never auto-signs on a wildcard, a loopback allowance, or a block', () => {
		// "Anyone may ask" says nothing about who this is, so nothing is minted without a human.
		for (const access of [
			{kind: 'ask', basis: 'wildcard'},
			{kind: 'ask', basis: 'loopback'},
			{kind: 'blocked'},
		] as AccessDecision[]) {
			expect(autoSignLookup({windowOrigin: THIRD_PARTY, signingOrigin: GAME, access, allowlistFor})(pair)).toBe(false);
		}
	});
});
