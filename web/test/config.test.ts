import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';
import {bakedDefaults, mergeDocument, type HostConfig} from '../login/src/lib/config';

/**
 * WHAT A RUNTIME DOCUMENT IS ALLOWED TO DO TO THIS HOST.
 *
 * The most important field here is the allowlist, because an entry in it mints a credential with NO
 * HUMAN IN THE LOOP, and the second most important is the deadline, because that deadline is the
 * only lever an entry has once it turns out to be wrong. Both arrive as untyped JSON from a file on
 * disk, and every way of getting this wrong is quiet: a refused field looks exactly like a field
 * nobody set, and an applied one produces a credential nobody sees until it is used.
 */
const defaults = bakedDefaults();
const CONTRACT = `0x${'e7'.repeat(20)}` as `0x${string}`;

let errors: string[];
let warnings: string[];

beforeEach(() => {
	errors = [];
	warnings = [];
	vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
	vi.spyOn(console, 'warn').mockImplementation((...args) => warnings.push(args.join(' ')));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the baked defaults', () => {
	it('are enough to sign in with, on their own', () => {
		// The whole promise of the artefact: no document, no key, no network.
		expect(defaults.devMnemonic.split(' ')).toHaveLength(12);
		expect(defaults.hostedAuthProvider).toBe('openfort');
	});

	it('grant nothing to anybody', () => {
		expect(defaults.originAllowlist).toEqual({});
		expect(defaults.crossOriginAllowlist).toEqual({});
	});

	it('expire an auto-signed credential, and never a prompted one', () => {
		expect(defaults.autoSignedLifetimeSeconds).toBe(90 * 24 * 60 * 60);
		expect(defaults.promptedLifetimeSeconds).toBe(0);
	});
});

describe('merging a runtime document', () => {
	it('is the defaults when the document is empty', () => {
		expect(mergeDocument(defaults, {})).toEqual(defaults);
	});

	it('touches only the fields the document mentions', () => {
		const merged = mergeDocument(defaults, {autoSignedLifetimeSeconds: 120});
		expect(merged.autoSignedLifetimeSeconds).toBe(120);
		expect(merged.devMnemonic).toBe(defaults.devMnemonic);
		expect(merged.originAllowlist).toEqual({});
	});

	it('does not mutate the defaults it was given', () => {
		const before = JSON.stringify(defaults);
		mergeDocument(defaults, {openfort: {publishableKey: 'pk_live_something'}, hostedAuthProvider: 'other'});
		expect(JSON.stringify(defaults)).toBe(before);
	});

	it('takes both allowlists whole', () => {
		const originAllowlist = {'http://localhost:5173': [{chainId: 31337, contract: CONTRACT}]};
		const crossOriginAllowlist = {'http://localhost:5173': ['http://localhost:5174']};
		const merged = mergeDocument(defaults, {originAllowlist, crossOriginAllowlist});
		expect(merged.originAllowlist).toEqual(originAllowlist);
		expect(merged.crossOriginAllowlist).toEqual(crossOriginAllowlist);
	});

	it('REPLACES a table rather than merging entry by entry', () => {
		// Merging would make "remove this entry" impossible to express, and an entry nobody meant to
		// keep is the dangerous direction for this particular table.
		const withEntry: HostConfig = {...defaults, originAllowlist: {'http://old.example': []}};
		const merged = mergeDocument(withEntry, {originAllowlist: {'http://new.example': []}});
		expect(Object.keys(merged.originAllowlist)).toEqual(['http://new.example']);
	});

	it('merges the openfort keys field by field, so setting one keeps the others', () => {
		const base: HostConfig = {
			...defaults,
			openfort: {publishableKey: 'pk', shieldPublishableKey: 'shield', encryptionSessionEndpoint: 'https://e.example'},
		};
		const merged = mergeDocument(base, {openfort: {publishableKey: 'pk2'}});
		expect(merged.openfort).toEqual({
			publishableKey: 'pk2',
			shieldPublishableKey: 'shield',
			encryptionSessionEndpoint: 'https://e.example',
		});
	});

	it('can turn the loopback allowance off as well as on', () => {
		expect(mergeDocument(defaults, {allowLoopbackRequesters: true}).allowLoopbackRequesters).toBe(true);
		expect(mergeDocument(defaults, {allowLoopbackRequesters: false}).allowLoopbackRequesters).toBe(false);
	});

	it('allows a zero lifetime, which means no expiry and is not the same as absent', () => {
		expect(
			mergeDocument({...defaults, autoSignedLifetimeSeconds: 99}, {autoSignedLifetimeSeconds: 0})
				.autoSignedLifetimeSeconds,
		).toBe(0);
	});

	describe('a field of the wrong type', () => {
		// REFUSED AND SAID OUT LOUD, rather than applied or silently dropped. A typo that quietly
		// leaves the old value is a debugging session about the wrong thing.
		const cases: [string, Record<string, unknown>][] = [
			['hostedAuthProvider', {hostedAuthProvider: 42}],
			['devMnemonic', {devMnemonic: ['test']}],
			['openfort', {openfort: 'pk_live_something'}],
			['openfort.publishableKey', {openfort: {publishableKey: 7}}],
			['allowLoopbackRequesters', {allowLoopbackRequesters: 'true'}],
			['originAllowlist', {originAllowlist: [{chainId: 1}]}],
			['crossOriginAllowlist', {crossOriginAllowlist: '*'}],
			['autoSignedLifetimeSeconds', {autoSignedLifetimeSeconds: '120'}],
			['autoSignedLifetimeSeconds', {autoSignedLifetimeSeconds: -1}],
			['autoSignedLifetimeSeconds', {autoSignedLifetimeSeconds: Number.NaN}],
			['promptedLifetimeSeconds', {promptedLifetimeSeconds: null}],
		];

		for (const [field, document] of cases) {
			it(`is refused, and named: ${field} = ${JSON.stringify(Object.values(document)[0])}`, () => {
				const merged = mergeDocument(defaults, document as never);
				expect(merged).toEqual(defaults);
				expect(errors.join('\n')).toContain(field);
			});
		}

		it('does not take the rest of the document down with it', () => {
			const merged = mergeDocument(defaults, {
				autoSignedLifetimeSeconds: 'soon' as never,
				devMnemonic: 'a b c d e f g h i j k l',
			});
			expect(merged.autoSignedLifetimeSeconds).toBe(defaults.autoSignedLifetimeSeconds);
			expect(merged.devMnemonic).toBe('a b c d e f g h i j k l');
		});
	});

	it('ignores a field it has never heard of, without complaining', () => {
		// The example document carries a `_readme`, and a document written for a newer host should
		// not stop an older one from starting.
		const merged = mergeDocument(defaults, {_readme: ['notes'], somethingNew: true} as never);
		expect(merged).toEqual(defaults);
		expect(errors).toEqual([]);
	});
});

describe('the two fields that decide whether a credential is minted with nobody in the loop', () => {
	// Checked hardest, because a malformed entry that gets through does not fail here: it fails
	// later as a pair that mysteriously never matches, at the moment somebody is signing in.
	it('accepts a well-formed entry', () => {
		const table = {'http://localhost:5173': [{chainId: 31337, contract: CONTRACT}]};
		expect(mergeDocument(defaults, {originAllowlist: table}).originAllowlist).toEqual(table);
	});

	it('accepts an origin that allowlists nothing', () => {
		expect(mergeDocument(defaults, {originAllowlist: {'http://localhost:5173': []}}).originAllowlist).toEqual({
			'http://localhost:5173': [],
		});
	});

	for (const [what, entry] of [
		['a missing chainId', {contract: CONTRACT}],
		['a chainId that is a string', {chainId: '31337', contract: CONTRACT}],
		['a fractional chainId', {chainId: 1.5, contract: CONTRACT}],
		['a missing contract', {chainId: 31337}],
		['a contract that is too short', {chainId: 31337, contract: '0xabc'}],
		['a contract without 0x', {chainId: 31337, contract: 'e7'.repeat(20)}],
		['a contract that is not a string', {chainId: 31337, contract: 31337}],
		['an entry that is not an object', 'everything'],
	] as [string, unknown][]) {
		it(`refuses ${what}, by name, and applies NONE of the table`, () => {
			const merged = mergeDocument(defaults, {
				originAllowlist: {'http://localhost:5173': [entry], 'http://ok.example': [{chainId: 1, contract: CONTRACT}]},
			});
			// All or nothing: a half-applied allowlist grants something nobody wrote down, and looks
			// like it worked.
			expect(merged.originAllowlist).toEqual({});
			expect(errors.join('\n')).toContain('originAllowlist["http://localhost:5173"][0]');
			expect(errors.join('\n')).toContain('not applied AT ALL');
		});
	}

	it('refuses an origin whose entries are not a list', () => {
		const merged = mergeDocument(defaults, {originAllowlist: {'http://localhost:5173': {chainId: 1}}} as never);
		expect(merged.originAllowlist).toEqual({});
		expect(errors.join('\n')).toContain('originAllowlist["http://localhost:5173"]');
	});

	it('accepts both shapes of cross-origin consent', () => {
		const table = {'http://a.example': '*', 'http://b.example': ['http://c.example']};
		expect(mergeDocument(defaults, {crossOriginAllowlist: table}).crossOriginAllowlist).toEqual(table);
	});

	for (const [what, consent] of [
		['a bare string that is not "*"', 'http://c.example'],
		['a list containing something that is not a string', ['http://c.example', 7]],
		['an object', {origin: 'http://c.example'}],
		['a wildcard spelled differently', 'ALL'],
	] as [string, unknown][]) {
		it(`refuses ${what}, and applies none of that table`, () => {
			const merged = mergeDocument(defaults, {crossOriginAllowlist: {'http://a.example': consent}} as never);
			expect(merged.crossOriginAllowlist).toEqual({});
			expect(errors.join('\n')).toContain('crossOriginAllowlist["http://a.example"]');
		});
	}

	it('lets a document say there is NO hosted provider, which is a real thing to run locally', () => {
		// Reachable, and `state.ts` depends on it being reachable: it is how a local host states that
		// it answers mnemonic and nothing else.
		expect(mergeDocument(defaults, {hostedAuthProvider: ''}).hostedAuthProvider).toBe('');
	});
});
