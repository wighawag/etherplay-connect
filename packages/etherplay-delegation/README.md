# @etherplay/delegation

Onchain delegation: an account authorises other addresses to act in its name, **at one contract**.

The problem it solves: an app that acts on its user's behalf sends from a key of its own, so the address that signs a transaction is not the account the action belongs to. A contract that records `msg.sender` records the wrong one.

This package ships one feature with three faces, and they are here together on purpose:

| face                           | where                            | who consumes it                                         |
| ------------------------------ | -------------------------------- | ------------------------------------------------------- |
| the Solidity library           | `contracts/`                     | your contract, compiled in from `node_modules`          |
| the TypeScript message builder | `src/message.ts` (package entry) | whatever produces the signature, e.g. a wallet          |
| the ABI                        | `src/abi.ts` (package entry)     | a client calling a contract it does not compile against |

They are together because what breaks is the agreement between them, and it breaks silently: a signature over a message that differs by one byte does not fail loudly, it recovers a different address. Co-located, the test that pins them runs on every change to either. That is `vectors.json`, read from both languages.

## There is nothing to deploy

**This package ships source.** Each adopter compiles the library into its own contract and owns its own delegations.

A shared `DelegationRegistry` that many contracts point at is not a variation on this design, it is its opposite. The verifying contract named in every signature would be that registry, so a credential granted for one game would be valid at every game on it, which is precisely the unbounded authority this design exists to remove.

## Solidity

```bash
pnpm add -D @etherplay/delegation
```

The standard shape, ready to inherit:

```solidity
import {UsingDelegation} from '@etherplay/delegation/contracts/UsingDelegation.sol';

contract MyGame is UsingDelegation {
	mapping(address account => uint256) public scores;

	function score(address onBehalfOf, uint256 points) external {
		// where you would have written msg.sender
		scores[_requireAccountForSender(onBehalfOf)] += points;
	}
}
```

That is the whole adoption. `UsingDelegation` declares **no storage of its own** (the library keeps its state in an ERC-7201 namespaced region), so it adds nothing to your layout and shifts nothing you already have, which is what makes it safe to add to a contract already live behind a proxy.

It gives your contract six external functions:

```solidity
function registerDelegate(address delegate, address payable payee) external payable;
function registerDelegateViaSignature(
	address owner,
	address delegate,
	uint256 deadline,
	bytes calldata signature
) external payable;
function revokeDelegate(address delegate) external;
function delegationStatus(address owner, address delegate) external view returns (bool allowed, bool withdrawn);
function delegationMessage(address delegate, uint256 deadline) external view returns (string memory);
function delegationDigest(address delegate, uint256 deadline) external view returns (bytes32);
```

If you want fewer, or different ones, use `Delegation` (the library) directly and write your own; `UsingDelegation` is only those six written once. `IDelegation` is the same set as a type, for a router composing a selector list or a caller that does not compile against you.

**What you are handing over:** a delegate authorised at your contract may do anything at your contract that its owner could do through the paths you resolve with `_requireAccountForSender`. Not a scope, not one action. It can do nothing anywhere else. If that is more than you mean to grant, narrow it in the override.

**Enumeration is the event.** There is no onchain list of an account's delegates; `DelegationChanged(owner, delegate, allowed)` is indexed on both addresses, and the set is reconstructed by replaying it. Note that many public RPCs cap `eth_getLogs` ranges, so a browser reconstructing from genesis wants a stored deployment block and paging.

## TypeScript

```ts
import {delegationMessage, delegationDigest, DELEGATION_ABI} from '@etherplay/delegation';

const message = delegationMessage({
	delegate: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
	contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
	chainId: 31337,
	deadline: 1767225600, // unix seconds; 0 means no expiry
});

const signature = await owner.signMessage({message}); // EIP-191 personal_sign
```

Anyone can then submit it, and pays for it:

```ts
await client.writeContract({
	address: contract,
	abi: DELEGATION_ABI,
	functionName: 'registerDelegateViaSignature',
	args: [owner, delegate, deadline, signature],
	value: fundingForTheDelegate,
});
```

An owner that can sign but cannot send, or holds nothing, can still delegate.

**The owner must be a key, not a contract.** `registerDelegateViaSignature` verifies with `ecrecover` and has no ERC-1271 `isValidSignature` fallback, so a smart account cannot register that way. It is not locked out: it calls `registerDelegate` directly, which proves who is asking by who is sending. The two paths suit opposite shapes, and the signature one exists for a signer that can sign and cannot send, which is precisely what a contract account is not.

## The message

```
IMPORTANT: Only sign this on a site you trust.

This authorizes another address to act in your name onchain, at one contract.
You can withdraw it at any time by revoking it there.

Delegate: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8
Contract: 0xe7f1725e7734ce288f8367e1bb143e90bb3f0512
Chain ID: 31337
Expires: 1767225600
```

Readable text rather than EIP-712, because this is about to be shown to a human. Prose first, so the first thing read is what is being agreed to; everything that matters in labelled fields, so a wallet has one extraction strategy rather than two. Both addresses lowercase. `Expires: never` for a deadline of zero, as a line rather than an omission.

The contract and the chain come from `address(this)` and `block.chainid`, never from the caller: they are the bound the design rests on. The deadline is passed in calldata because the contract cannot know it, which is safe because it is not trusted, only recovered against.

There is no origin and no version field. A wallet always knows the true origin of the page asking, and the delegate address already carries the origin binding by being a pure function of (account key, origin). Note that the absent leading `Origin:` line is deliberate: under the etherplay convention that prefix means "safe to sign without asking", which is exactly the property being removed here.

## `vectors.json`

Not a fixture. It is the specification: `(delegate, contract, chainId, deadline)` with the exact message and its EIP-191 digest, covering both deadline branches, chain ids of 1 and 31337, and checksummed inputs that must render lowercase.

Three implementations must agree on these bytes: `contracts/Delegation.sol`, `src/message.ts`, and whatever a third-party wallet writes. **Never change one without the others and the vectors, in the same commit.** A change here invalidates every signature ever generated.

```bash
pnpm test   # hardhat: the Solidity suite and the TypeScript one, both against vectors.json
```

## Deadlines

Zero means no expiry, and is right for a credential a human was prompted for: refreshing one costs a popup and re-consent in the middle of a game.

A credential minted with **no human in the loop** should carry a real deadline. It is the only lever anyone has if the decision to mint it turns out to be wrong: removing whatever authorised it stops future minting and reaches nobody who already holds one.

The deadline bounds how long the credential may be **presented**, not how long the authority lasts. Once registered, a delegate stands until it is revoked.
