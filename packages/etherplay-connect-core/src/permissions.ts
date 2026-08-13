import type {PermissionOutcome, PermissionRequest, SavedDelegation} from './types.js';

/**
 * What the wallet knows how to grant. Anything else is a permission this wallet does not
 * understand, and the one thing that must never happen to it is being dropped quietly: a silent
 * drop is how an old host and a new app end up disagreeing about what was granted, with the app
 * believing it holds something it does not.
 */
const RECOGNIZED_TYPES = ['delegation'] as const;

/**
 * Turn whatever the app sent into a closed set of requests.
 *
 * Parsing is where the "never dropped" rule is enforced, so it happens ONCE, at the boundary, and
 * everything downstream works with a union it can exhaustively handle. An entry this wallet does
 * not recognise becomes `{type: 'unrecognized'}` carrying the type it asked for, so the UI can name
 * it and the app can be told it was refused rather than ignored.
 *
 * Malformed entries are unrecognized too, not errors: an app that sends a delegation request with
 * no contract has asked for something this wallet cannot act on, which is the same situation as an
 * unknown type and deserves the same visible refusal. Throwing here would fail the whole sign-in
 * over one bad entry.
 */
export function parsePermissionRequests(input: unknown): PermissionRequest[] {
	if (!Array.isArray(input)) {
		return [];
	}
	return input.map((entry): PermissionRequest => {
		const required = !!(entry && typeof entry === 'object' && (entry as {required?: unknown}).required === true);
		const type = entry && typeof entry === 'object' ? (entry as {type?: unknown}).type : undefined;

		if (type === 'delegation') {
			const {chainId, contract} = entry as {chainId?: unknown; contract?: unknown};
			const chainIdNumber = typeof chainId === 'string' ? Number(chainId) : chainId;
			if (
				typeof chainIdNumber === 'number' &&
				Number.isSafeInteger(chainIdNumber) &&
				chainIdNumber > 0 &&
				typeof contract === 'string' &&
				/^0x[0-9a-fA-F]{40}$/.test(contract)
			) {
				return {
					type: 'delegation',
					required,
					chainId: chainIdNumber,
					// Lowercased once, here, so the allowlist comparison, the signed message and the
					// stored record cannot disagree about the spelling of the same address.
					contract: contract.toLowerCase() as `0x${string}`,
				};
			}
		}

		return {
			type: 'unrecognized',
			required,
			requestedType: typeof type === 'string' ? type : String(type),
		};
	});
}

export function isRecognizedPermissionType(type: string): boolean {
	return (RECOGNIZED_TYPES as readonly string[]).includes(type);
}

/**
 * A request the host decides on its own, with no prompt.
 *
 * Auto-signing does not create authority, it removes a prompt exactly where the prompt was
 * worthless. An origin the host has allowlisted for a contract can already derive this account's
 * signer silently, because the origin mechanism grants that unconditionally, so auto-signing a
 * delegation bounded to that origin's own contract adds nothing an attacker who compromised that
 * origin did not already have, minus one click-through. The prompt is kept for the case that
 * carries information: an origin asking for a contract that is not its own.
 */
export type AllowlistLookup = (request: {chainId: number; contract: `0x${string}`}) => boolean;

/** One (chain, contract) pair: the whole extent of what a delegation authorises. */
export type DelegationTarget = {chainId: number; contract: `0x${string}`};

/**
 * Build the lookup {@link resolvePermissions} takes, from a host's hardcoded table.
 *
 * The comparison lives here rather than in the host because of what it decides: a match means a
 * credential is minted with nobody in the loop. Too loose and the wrong contract gets one silently.
 * The chain is compared exactly, since the same address on another chain is another contract
 * entirely; the address is compared case-insensitively, since EIP-55 spelling is presentation and
 * a table maintained by hand will not be consistent about it.
 */
export function allowlistLookup(entries: DelegationTarget[]): AllowlistLookup {
	const normalised = entries.map((entry) => ({chainId: entry.chainId, contract: entry.contract.toLowerCase()}));
	return (request) => {
		const contract = request.contract.toLowerCase();
		return normalised.some((entry) => entry.chainId === request.chainId && entry.contract === contract);
	};
}

/**
 * A deadline `lifetimeSeconds` from now, in UNIX SECONDS.
 *
 * Trivial, and here rather than inline for the one bug it prevents: a millisecond value reaching
 * the signed message produces a credential that expires in the year 57000, which is indistinguishable
 * from no deadline at all and defeats the reason auto-signed credentials carry one.
 */
export function deadlineIn(lifetimeSeconds: number, now: number = Date.now()): number {
	return Math.floor(now / 1000) + lifetimeSeconds;
}

export type PermissionResolution = {
	/** decided without asking: allowlisted grants, and refusals nobody can consent their way out of */
	settled: PermissionOutcome[];
	/** what is left for the human, in the order the app asked for it */
	pending: PermissionRequest[];
};

/**
 * Split the requests into what the host decides itself and what the user must be asked.
 *
 * Kept out of the UI on purpose: which requests get auto-signed and which are refused outright is
 * the security-carrying part of this feature, and it belongs somewhere a test can reach without
 * rendering a component.
 */
export function resolvePermissions(
	requests: PermissionRequest[],
	options: {isAllowlisted: AllowlistLookup; deadline: number},
): PermissionResolution {
	const settled: PermissionOutcome[] = [];
	const pending: PermissionRequest[] = [];

	for (const request of requests) {
		if (request.type === 'unrecognized') {
			// Refused without asking, because there is nothing to ask: a user cannot meaningfully
			// consent to a capability the wallet cannot describe, and pretending otherwise would be
			// the worst kind of consent theatre. Reported, though, never dropped.
			settled.push({request, granted: false, reason: 'unsupported'});
			continue;
		}

		if (options.isAllowlisted({chainId: request.chainId, contract: request.contract})) {
			settled.push({request, granted: true, deadline: options.deadline});
			continue;
		}

		pending.push(request);
	}

	return {settled, pending};
}

/**
 * Whether sign-in can complete with these outcomes.
 *
 * A required entry that is denied fails sign-in; an optional one lets it proceed with that
 * credential missing. The distinction is the app's to make and the host's to honour.
 */
export function deniedRequiredPermissions(outcomes: PermissionOutcome[]): PermissionOutcome[] {
	return outcomes.filter((outcome) => !outcome.granted && outcome.request.required);
}

/**
 * The delegations to mint, in the order they were asked for.
 *
 * Only granted delegation entries produce a credential. Everything else reaches the app as an
 * outcome with a reason, which is the point: an app has to tell "you declined" from "nobody asked"
 * to offer the right remedy, and an absent credential says neither.
 */
export function delegationsToSign(outcomes: PermissionOutcome[]): {
	chainId: number;
	contract: `0x${string}`;
	deadline: number;
}[] {
	const toSign: {chainId: number; contract: `0x${string}`; deadline: number}[] = [];
	for (const outcome of outcomes) {
		if (outcome.granted && outcome.request.type === 'delegation') {
			toSign.push({
				chainId: outcome.request.chainId,
				contract: outcome.request.contract,
				deadline: outcome.deadline,
			});
		}
	}
	return toSign;
}

/**
 * Find the credential for a (chainId, contract) pair.
 *
 * The lookup an app performs every time it wants to act, so it is written once here rather than in
 * each app. Comparison is case-insensitive on the contract because an app that stores a
 * checksummed address should not silently miss a record stored lowercase.
 */
export function findSavedDelegation(
	delegations: SavedDelegation[] | undefined,
	target: {chainId: number; contract: `0x${string}`},
): SavedDelegation | undefined {
	const contract = target.contract.toLowerCase();
	return (delegations || []).find(
		(delegation) => delegation.chainId === target.chainId && delegation.contract.toLowerCase() === contract,
	);
}
