// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {UsingDelegation} from "contracts/UsingDelegation.sol";

/// The mixin and nothing else: what an adopter gets for one line of
/// inheritance, with no state and no behaviour of its own to confuse a result.
///
/// Shared rather than declared per file, because three suites want the same
/// thing - the interface check (IDelegation.t.sol), the vectors
/// (Vectors.t.sol) and the TypeScript suite, which deploys this across the ABI
/// boundary the way an app would.
contract PlainAdopter is UsingDelegation {}
