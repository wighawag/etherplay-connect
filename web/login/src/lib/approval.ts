import type {
	AccessDecision,
	OriginApprovalRequest,
	PermissionOutcome,
	PermissionRequest,
} from '@etherplay/connect-core';

/**
 * What the site asked for, what has been answered, and how to answer the rest.
 *
 * Declared ONCE, here, because five components handle it: {Login.svelte} builds it, the three
 * mechanism components pass it through, and {Permissions.svelte} renders it. Written out five
 * times, adding a field means four chances to describe the same security decision differently, and
 * the component that renders it is the one that would end up lying.
 */
export type ApprovalUI = {
	request: false | OriginApprovalRequest;
	/**
	 * How this host answered "may this window be signed for at all", decided before anything was
	 * derived or signed. `undefined` only until the (asynchronous) lookup has answered.
	 */
	access: AccessDecision | undefined;
	accessGranted: boolean;
	/**
	 * How many times access must be confirmed, and how many times it has been.
	 *
	 * Two where nobody vouched for the requester: a signing origin that accepts anyone, or a local
	 * development page admitted by a build flag. The second step is not ceremony, it is the
	 * difference between clicking through a dialog and answering it.
	 */
	confirmationsRequired: number;
	confirmationsGiven: number;
	pending: PermissionRequest[];
	outcomes: PermissionOutcome[];
	blocking: PermissionOutcome[];
	complete: boolean;
	grantAccess: () => void;
	grant: (request: PermissionRequest) => void;
	deny: (request: PermissionRequest) => void;
};
