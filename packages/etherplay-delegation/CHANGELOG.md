# @etherplay/delegation

## 0.1.0

### Minor Changes

- 8ed45d3: New package: `@etherplay/delegation`, the onchain half of delegation, shipped as one feature with three faces - the Solidity library (`contracts/`), the TypeScript builder for the message it verifies, and the ABI - kept in agreement by a shared `vectors.json` that both languages are tested against.

  It ports `contracts/src/core` out of `jolly-roger`, where the test pinning the Solidity message against the TypeScript one lived in a downstream template that neither upstream ran in CI. That is the deciding argument for the package: a mismatch between the two is catastrophic and silent, since a signature over a message that differs by one byte does not fail, it recovers a different address. Co-located, the pinning test runs on every change to either side, in CI.

  **There is nothing to deploy, and that is the design.** The package ships source, compiled into each adopter. A shared `DelegationRegistry` would make the verifying contract in every signature that registry, so a credential granted for one game would be valid at every game on it, which is exactly the unbounded authority this removes.

  The design is redesigned rather than ported verbatim, on two counts:

  _The message_ loses its `Origin:` line and gains the chain id, the verifying contract and a deadline. The old text named no chain and no contract, so a signature pre-generated at sign-in was a standing credential usable at **any** contract adopting the library on **any** chain. The contract and the chain now come from `address(this)` and `block.chainid` and can never be caller-supplied; the deadline is in calldata because the contract cannot know it, which is safe because it is recovered against rather than trusted. Dropping the `Origin:` prefix is semantically required, not tidying: under the etherplay convention that prefix means "safe to sign without asking", which is the property being removed. `delegationMessage` and `delegationDigest` are therefore `view`, not `pure`.

  _The contract_ moves from one delegate per account to a membership set, so a second front-end no longer evicts the first and "replace a signer" stops being entangled with "withdraw a signer". Two mappings collapse into one `mapping(owner => mapping(delegate => Status))` with an exclusive three-state enum; the hot path is still a single cold SLOAD and revoke drops from about 29k gas to about 5k. The external surface goes from seven functions to six: `delegateOf` is gone (under a set, any single address it returned would be a lie), `delegationStatus` answers both questions in one call as two bools, `revokeDelegate` takes an address, and `DelegateChanged` becomes `DelegationChanged(owner, delegate, allowed)` - renamed on purpose, so anything still listening for the old topic0 breaks loudly rather than quietly mis-reading a set as a single value. The event is now the enumeration API: there is no onchain list.

  The ERC-7201 id is `etherplay.storage.Delegation`. Renaming and changing the layout are free, and verified so: `jolly-roger`'s Sepolia `GreetingsRegistry` ABI has no delegation functions, so the library has never been deployed anywhere but local dev chains.

  Nothing consumes this yet. `@etherplay/connect-core` and `jolly-roger`'s web follow in their own steps.
