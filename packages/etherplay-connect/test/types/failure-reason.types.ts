// Type-surface lock for `ConnectionFailureReason`, the discriminant on a failed connection.
//
// No runtime here: `tsc -p tsconfig.types.json` IS the test, and a compile error is a failing one.
// This file exists because the runtime suite CANNOT hold these promises. `tsconfig.types.json`
// deliberately excludes `test/**/*.test.ts`, and vitest transpiles without type-checking, so a
// type-level assertion written in a `.test.ts` file is never checked by anything. An exhaustiveness
// guard was written there first and was silently inert: adding a member to the union left it green.
//
// What is pinned:
//
// 1. THE VOCABULARY IS EXACTLY THESE TEN MEMBERS. Adding one (or removing, or renaming one) fails
//    here until the list is updated, which is the intended cost: a new member is a documented,
//    minor-version event that consumers are told about, not something to slip in. It also keeps the
//    runtime membership list in `test/ensure-connected-settles.test.ts` honest, since the two are
//    meant to say the same thing and only this one is checked by a compiler.
// 2. `reason` is REQUIRED on the connection's resting error, which is the mechanism that makes the
//    compiler enumerate every producer rather than leaving the next one to remember.
// 3. `reason` is present on the thrown failure, and `cause`/`code` are still there beside it, since
//    the whole change is additive.
// 4. A consumer can exhaustively switch on it TODAY (that is the point of a closed union), while
//    being told to keep a `default` because it may gain members in a minor.

import {ConnectionFailure, type ConnectionError, type ConnectionFailureReason} from '../../src/index.js';

// 1. Exhaustive both ways. `Record<ConnectionFailureReason, true>` fails if a member is added
// (missing property) or renamed; the annotation on each key fails if one is removed or misspelled.
const EVERY_REASON = {
	cancelled: true,
	'address-unavailable-acknowledged': true,
	superseded: true,
	unreachable: true,
	'wallet-rejected': true,
	'wallet-unavailable': true,
	'no-accounts': true,
	'cross-origin-blocked': true,
	'host-refused': true,
	failed: true,
} satisfies Record<ConnectionFailureReason, true>;
const _everyReasonIsAReason: ConnectionFailureReason[] = Object.keys(EVERY_REASON) as ConnectionFailureReason[];

// 2. The resting error REQUIRES a reason: this is what makes the compiler enumerate the producers.
const _restingError: ConnectionError = {message: 'failed to connect to wallet', reason: 'wallet-rejected'};
// @ts-expect-error - an error without a reason is not a `ConnectionError`
const _unlabelledRestingError: ConnectionError = {message: 'failed to connect to wallet'};
// ...and only a real member will do.
// @ts-expect-error - 'user-cancelled' is not one of the ten
const _misspeltReason: ConnectionError = {message: 'nope', reason: 'user-cancelled'};

// 3. Additive: the thrown failure carries the reason AND everything it carried before.
declare const failure: ConnectionFailure;
const _reason: ConnectionFailureReason = failure.reason;
const _cause: unknown = failure.cause;
const _code: unknown = failure.code;
const _message: string = failure.message;
// Constructing one by hand still works with the old two arguments, so a consumer's own test double
// or re-throw keeps compiling: the third argument is optional and defaults to `failed`.
const _oldShape = new ConnectionFailure('could not reach WalletConnected', new Error('boom'));
const _newShape = new ConnectionFailure('could not reach WalletConnected', undefined, 'unreachable');

// 4. A consumer can switch exhaustively. `assertNever` compiles only while the switch below covers
// every member, so this is the consumer's side of the same guarantee as (1).
function assertNever(value: never): never {
	throw new Error(`unhandled reason: ${String(value)}`);
}
function describe(reason: ConnectionFailureReason): string {
	switch (reason) {
		case 'cancelled':
		case 'address-unavailable-acknowledged':
			return 'the user decided';
		case 'superseded':
			return 'another request took the account slot';
		case 'unreachable':
			return 'the connection came to rest';
		case 'wallet-rejected':
			return 'the wallet prompt was declined';
		case 'wallet-unavailable':
			return 'the wallet cannot authorise accounts';
		case 'no-accounts':
			return 'the wallet offered no accounts';
		case 'cross-origin-blocked':
			return 'the host blocked a cross-origin request';
		case 'host-refused':
			return 'the host refused';
		case 'failed':
			return 'something else went wrong';
		default:
			// The branch consumers are ADVISED to keep, for the member that does not exist yet. It is
			// unreachable today, which is why `assertNever` type-checks here.
			return assertNever(reason);
	}
}

export {_everyReasonIsAReason, _restingError, _reason, _cause, _code, _message, _oldShape, _newShape, describe};
