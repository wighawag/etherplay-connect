import {describe, expect, it} from 'vitest';
import {
	allowlistLookup,
	deadlineIn,
	parsePermissionRequests,
	resolvePermissions,
	deniedRequiredPermissions,
	delegationsToSign,
	findSavedDelegation,
} from '../src/permissions.js';
import type {PermissionOutcome, PermissionRequest} from '../src/types.js';

const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;
const OTHER = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const;

const never = () => false;
const always = () => true;

describe('parsePermissionRequests', () => {
	it('reads a delegation request', () => {
		expect(parsePermissionRequests([{type: 'delegation', required: true, chainId: 1, contract: CONTRACT}])).toEqual([
			{type: 'delegation', required: true, chainId: 1, contract: CONTRACT},
		]);
	});

	it('defaults an unmarked entry to optional', () => {
		// Optional is the safe default: a required entry can fail sign-in outright, so an app has to
		// say so deliberately rather than get it by omission.
		const [request] = parsePermissionRequests([{type: 'delegation', chainId: 1, contract: CONTRACT}]);
		expect(request.required).toBe(false);
	});

	it('lowercases the contract', () => {
		// One spelling from here on, so the allowlist comparison, the signed message and the stored
		// record cannot disagree about the same address.
		const [request] = parsePermissionRequests([
			{type: 'delegation', chainId: 1, contract: '0xE7F1725E7734CE288F8367E1BB143E90BB3F0512'},
		]);
		expect(request).toMatchObject({contract: CONTRACT});
	});

	it('keeps an unknown type as a request rather than dropping it', () => {
		// The rule that matters most in this file. A silent drop is how an old host and a new app end
		// up disagreeing about what was granted, with the app believing it holds something it does
		// not. It survives parsing so it can be shown and reported.
		expect(parsePermissionRequests([{type: 'teleport', required: true}])).toEqual([
			{type: 'unrecognized', required: true, requestedType: 'teleport'},
		]);
	});

	it('treats a malformed delegation request as unrecognized, not as an error', () => {
		// An app asking for a delegation with no contract has asked for something this wallet cannot
		// act on, which is the same situation as an unknown type and deserves the same visible
		// refusal. Throwing would fail the whole sign-in over one bad entry.
		const requests = parsePermissionRequests([
			{type: 'delegation', chainId: 1},
			{type: 'delegation', chainId: 1, contract: 'not-an-address'},
			{type: 'delegation', chainId: 0, contract: CONTRACT},
			{type: 'delegation', chainId: 'abc', contract: CONTRACT},
			null,
		]);
		expect(requests.map((r) => r.type)).toEqual(Array(5).fill('unrecognized'));
	});

	it('accepts a chain id that arrived as a string, since a URL has only strings', () => {
		const [request] = parsePermissionRequests([{type: 'delegation', chainId: '31337', contract: CONTRACT}]);
		expect(request).toMatchObject({type: 'delegation', chainId: 31337});
	});

	it('never drops an entry, whatever the input', () => {
		const input = [{type: 'delegation', chainId: 1, contract: CONTRACT}, {type: 'teleport'}, {}, 42];
		expect(parsePermissionRequests(input)).toHaveLength(input.length);
	});

	it('treats a non-list as no request at all', () => {
		expect(parsePermissionRequests(undefined)).toEqual([]);
		expect(parsePermissionRequests('delegation')).toEqual([]);
	});
});

describe('resolvePermissions', () => {
	const delegation = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
		type: 'delegation',
		required: false,
		chainId: 31337,
		contract: CONTRACT,
		...(over as object),
	});

	it('asks the human about a pair the host has not allowlisted', () => {
		// The case that carries information: an origin asking for a contract that is not its own.
		const {settled, pending} = resolvePermissions([delegation()], {isAllowlisted: never, deadline: 100});
		expect(settled).toEqual([]);
		expect(pending).toHaveLength(1);
	});

	it('auto-grants an allowlisted pair, with a real deadline', () => {
		// Auto-signing does not create authority, it removes a prompt where the prompt was worthless.
		// The deadline is not optional here: this is the credential minted with no human in the loop,
		// so it is the one an allowlist entry can keep producing after that entry turns out to be
		// wrong, and a date is the only lever anyone has over it.
		const {settled, pending} = resolvePermissions([delegation()], {isAllowlisted: always, deadline: 1767225600});
		expect(pending).toEqual([]);
		expect(settled).toEqual([{request: delegation(), granted: true, deadline: 1767225600}]);
	});

	it('only auto-grants the pair that is on the list', () => {
		const onlyOurs = (r: {chainId: number; contract: `0x${string}`}) => r.chainId === 31337 && r.contract === CONTRACT;
		const {settled, pending} = resolvePermissions(
			[delegation(), delegation({contract: OTHER}), delegation({chainId: 1})],
			{isAllowlisted: onlyOurs, deadline: 100},
		);

		expect(settled).toHaveLength(1);
		expect(pending).toHaveLength(2);
		// the chain is part of the pair, not decoration: same contract, other chain, still asked
		expect(pending[1]).toMatchObject({chainId: 1});
	});

	it('denies an unknown type without asking, and says why', () => {
		// Nobody is prompted, because a user cannot meaningfully consent to a capability the wallet
		// cannot describe. `unsupported` rather than `denied`, so the app can tell "this wallet is
		// too old for what I asked" from "the user said no".
		const request: PermissionRequest = {type: 'unrecognized', required: false, requestedType: 'teleport'};
		const {settled, pending} = resolvePermissions([request], {isAllowlisted: always, deadline: 100});

		expect(pending).toEqual([]);
		expect(settled).toEqual([{request, granted: false, reason: 'unsupported'}]);
	});

	it('preserves the order the app asked in', () => {
		const requests = [delegation({contract: OTHER}), delegation()];
		const {pending} = resolvePermissions(requests, {isAllowlisted: never, deadline: 100});
		expect(pending).toEqual(requests);
	});
});

describe('deniedRequiredPermissions', () => {
	it('reports a denied required entry, which must fail sign-in', () => {
		const outcomes: PermissionOutcome[] = [
			{request: {type: 'delegation', required: true, chainId: 1, contract: CONTRACT}, granted: false, reason: 'denied'},
			{request: {type: 'delegation', required: false, chainId: 1, contract: OTHER}, granted: false, reason: 'denied'},
			{request: {type: 'delegation', required: true, chainId: 1, contract: OTHER}, granted: true, deadline: 0},
		];
		// Only the first: an optional denial lets sign-in proceed with that credential missing, and a
		// granted required entry is the normal case.
		expect(deniedRequiredPermissions(outcomes)).toEqual([outcomes[0]]);
	});

	it('fails sign-in for a required permission this wallet cannot understand', () => {
		// The combination worth being explicit about: an app requiring something the host is too old
		// to grant cannot be signed into, and that is correct. The alternative is letting it in
		// believing it holds a capability nobody has.
		const outcomes: PermissionOutcome[] = [
			{
				request: {type: 'unrecognized', required: true, requestedType: 'teleport'},
				granted: false,
				reason: 'unsupported',
			},
		];
		expect(deniedRequiredPermissions(outcomes)).toHaveLength(1);
	});
});

describe('delegationsToSign', () => {
	it('mints only what was granted', () => {
		const outcomes: PermissionOutcome[] = [
			{request: {type: 'delegation', required: false, chainId: 1, contract: CONTRACT}, granted: true, deadline: 500},
			{request: {type: 'delegation', required: false, chainId: 1, contract: OTHER}, granted: false, reason: 'denied'},
			{
				request: {type: 'unrecognized', required: false, requestedType: 'teleport'},
				granted: false,
				reason: 'unsupported',
			},
		];
		expect(delegationsToSign(outcomes)).toEqual([{chainId: 1, contract: CONTRACT, deadline: 500}]);
	});

	it('carries each grant own deadline rather than one for all of them', () => {
		const outcomes: PermissionOutcome[] = [
			{request: {type: 'delegation', required: false, chainId: 1, contract: CONTRACT}, granted: true, deadline: 0},
			{
				request: {type: 'delegation', required: false, chainId: 1, contract: OTHER},
				granted: true,
				deadline: 1767225600,
			},
		];
		expect(delegationsToSign(outcomes).map((d) => d.deadline)).toEqual([0, 1767225600]);
	});
});

describe('findSavedDelegation', () => {
	const saved = [
		{chainId: 1, contract: CONTRACT, delegate: OTHER, deadline: 0, signature: '0xaa' as `0x${string}`},
		{chainId: 31337, contract: CONTRACT, delegate: OTHER, deadline: 0, signature: '0xbb' as `0x${string}`},
	];

	it('selects by the whole pair, not by the contract alone', () => {
		expect(findSavedDelegation(saved, {chainId: 31337, contract: CONTRACT})?.signature).toBe('0xbb');
	});

	it('matches a checksummed contract against a lowercase record', () => {
		expect(
			findSavedDelegation(saved, {chainId: 1, contract: '0xE7F1725E7734CE288F8367E1BB143E90BB3F0512'}),
		).toBeDefined();
	});

	it('returns nothing rather than something wrong when the pair is absent', () => {
		expect(findSavedDelegation(saved, {chainId: 999, contract: CONTRACT})).toBeUndefined();
		expect(findSavedDelegation(undefined, {chainId: 1, contract: CONTRACT})).toBeUndefined();
	});
});

describe('allowlistLookup', () => {
	// A match here means a credential is minted with nobody in the loop, so these are the
	// comparisons that decide whether the prompt is skipped for the right thing.
	const lookup = allowlistLookup([{chainId: 31337, contract: CONTRACT}]);

	it('matches the pair it was given', () => {
		expect(lookup({chainId: 31337, contract: CONTRACT})).toBe(true);
	});

	it('ignores the spelling of the address, on both sides', () => {
		// A table maintained by hand will not be consistent about EIP-55, and neither will an app.
		expect(lookup({chainId: 31337, contract: '0xE7F1725E7734CE288F8367E1BB143E90BB3F0512'})).toBe(true);
		expect(
			allowlistLookup([{chainId: 1, contract: '0xE7F1725E7734CE288F8367E1BB143E90BB3F0512'}])({
				chainId: 1,
				contract: CONTRACT,
			}),
		).toBe(true);
	});

	it('does not match the same address on another chain', () => {
		// The same address on another chain is another contract entirely, usually with other code.
		expect(lookup({chainId: 1, contract: CONTRACT})).toBe(false);
	});

	it('does not match another address on the same chain', () => {
		expect(lookup({chainId: 31337, contract: OTHER})).toBe(false);
	});

	it('matches nothing when the list is empty', () => {
		// The shipped default. An empty list must auto-grant nothing at all, rather than everything.
		expect(allowlistLookup([])({chainId: 1, contract: CONTRACT})).toBe(false);
	});
});

describe('deadlineIn', () => {
	it('returns unix SECONDS, not milliseconds', () => {
		// The bug this exists to prevent: a millisecond value in the signed message is a credential
		// expiring in the year 57000, which is no deadline at all, on exactly the credentials that
		// most need one.
		expect(deadlineIn(90 * 24 * 60 * 60, 1_700_000_000_000)).toBe(1_700_000_000 + 90 * 24 * 60 * 60);
	});

	it('is in the future by the lifetime it was given', () => {
		const now = Date.now();
		expect(deadlineIn(60, now) - Math.floor(now / 1000)).toBe(60);
	});
});
