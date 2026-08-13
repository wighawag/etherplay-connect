/**
 * The delegation surface as an ABI, for a client that calls a contract it does not compile against.
 *
 * The same six functions {@link file://../contracts/IDelegation.sol} declares, plus the event and
 * the errors an adopter of `UsingDelegation` actually exposes - the event because it IS the
 * enumeration API (there is no onchain list of an account's delegates, so the set is reconstructed
 * by replaying these logs), and the errors so a revert decodes into something an app can act on
 * rather than a hex blob.
 *
 * Hand-written rather than generated, so it reads as the contract's surface and ships without a
 * build artifact. Drift is caught instead of prevented: a test compiles the Solidity and asserts
 * this is exactly its ABI, so adding a parameter on one side and not the other fails in CI.
 *
 * `as const`, so viem infers argument and return types from it.
 */
export const DELEGATION_ABI = [
	{
		type: 'function',
		name: 'registerDelegate',
		stateMutability: 'payable',
		inputs: [
			{name: 'delegate', type: 'address'},
			{name: 'payee', type: 'address'},
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'registerDelegateViaSignature',
		stateMutability: 'payable',
		inputs: [
			{name: 'owner', type: 'address'},
			{name: 'delegate', type: 'address'},
			{name: 'deadline', type: 'uint256'},
			{name: 'signature', type: 'bytes'},
		],
		outputs: [],
	},
	{
		type: 'function',
		name: 'revokeDelegate',
		stateMutability: 'nonpayable',
		inputs: [{name: 'delegate', type: 'address'}],
		outputs: [],
	},
	{
		type: 'function',
		name: 'delegationStatus',
		stateMutability: 'view',
		inputs: [
			{name: 'owner', type: 'address'},
			{name: 'delegate', type: 'address'},
		],
		outputs: [
			{name: 'allowed', type: 'bool'},
			{name: 'withdrawn', type: 'bool'},
		],
	},
	{
		// `view`, not `pure`: the contract and the chain come from `address(this)` and
		// `block.chainid` rather than from arguments, which is what stops a caller choosing them.
		type: 'function',
		name: 'delegationMessage',
		stateMutability: 'view',
		inputs: [
			{name: 'delegate', type: 'address'},
			{name: 'deadline', type: 'uint256'},
		],
		outputs: [{name: '', type: 'string'}],
	},
	{
		type: 'function',
		name: 'delegationDigest',
		stateMutability: 'view',
		inputs: [
			{name: 'delegate', type: 'address'},
			{name: 'deadline', type: 'uint256'},
		],
		outputs: [{name: '', type: 'bytes32'}],
	},
	{
		type: 'event',
		name: 'DelegationChanged',
		anonymous: false,
		inputs: [
			{name: 'owner', type: 'address', indexed: true},
			{name: 'delegate', type: 'address', indexed: true},
			{name: 'allowed', type: 'bool', indexed: false},
		],
	},
	{
		type: 'error',
		name: 'NotDelegate',
		inputs: [
			{name: 'owner', type: 'address'},
			{name: 'sender', type: 'address'},
		],
	},
	{
		type: 'error',
		name: 'DelegationWithdrawn',
		inputs: [
			{name: 'owner', type: 'address'},
			{name: 'delegate', type: 'address'},
		],
	},
	{
		type: 'error',
		name: 'InvalidSignature',
		inputs: [],
	},
	{
		type: 'error',
		name: 'InvalidDelegate',
		inputs: [],
	},
	{
		type: 'error',
		name: 'SignatureExpired',
		inputs: [{name: 'deadline', type: 'uint256'}],
	},
	{
		type: 'error',
		name: 'MalformedSignature',
		inputs: [],
	},
	{
		type: 'error',
		name: 'UnrecoverableSignature',
		inputs: [],
	},
	{
		type: 'error',
		name: 'TransferFailed',
		inputs: [{name: 'payee', type: 'address'}],
	},
	{
		type: 'error',
		name: 'ValueWithNoPayee',
		inputs: [{name: 'amount', type: 'uint256'}],
	},
] as const;
