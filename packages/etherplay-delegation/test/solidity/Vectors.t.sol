// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {Delegation} from "contracts/Delegation.sol";
import {PlainAdopter} from "./PlainAdopter.sol";

/// One row of `vectors.json`.
///
/// The members are in ALPHABETICAL ORDER of the JSON keys, which is how
/// `vm.parseJson` abi-encodes an object; the names here are irrelevant, only
/// the order and the types matter. `contract` is a reserved word, hence
/// `verifyingContract`.
struct Vector {
    uint256 chainId;
    address verifyingContract;
    uint256 deadline;
    address delegate;
    bytes32 digest;
    string message;
    string name;
    string why;
}

/// @notice The consensus check, from the Solidity side.
///
/// `vectors.json` is not a fixture, it is the specification: the same file is
/// read by the TypeScript suite (test/js/vectors.test.ts), and a third-party
/// wallet implementing this message has nothing else to check itself against.
/// A change to the wording that is not also a change to that file fails here,
/// which is the point, because the failure it replaces is every signature ever
/// generated silently ceasing to verify.
///
/// The cases are reproduced rather than approximated: `vm.etch` puts an adopter
/// at the exact address each vector names and `vm.chainId` sets the chain it
/// names, because the contract and the chain are read from `address(this)` and
/// `block.chainid` and are not arguments anyone can pass.
contract VectorsTest is Test {
    PlainAdopter internal adopter;

    function setUp() public {
        adopter = new PlainAdopter();
    }

    function _vectors() internal view returns (Vector[] memory) {
        return
            abi.decode(
                vm.parseJson(vm.readFile("vectors.json"), ".cases"),
                (Vector[])
            );
    }

    /// @notice An adopter deployed at a vector's contract address, on its chain.
    function _adopterAt(Vector memory vector) internal returns (PlainAdopter) {
        vm.etch(vector.verifyingContract, address(adopter).code);
        vm.chainId(vector.chainId);
        return PlainAdopter(vector.verifyingContract);
    }

    function test_everyVectorMessageIsReproducedExactly() public {
        Vector[] memory vectors = _vectors();
        assertGt(vectors.length, 0, "vectors.json parsed to nothing");

        for (uint256 i = 0; i < vectors.length; i++) {
            Vector memory vector = vectors[i];
            assertEq(
                _adopterAt(vector).delegationMessage(
                    vector.delegate,
                    vector.deadline
                ),
                vector.message,
                vector.name
            );
        }
    }

    /// @notice The digest as well as the string, because the two can disagree.
    ///
    /// The EIP-191 prefix carries the message's own LENGTH IN BYTES. An
    /// implementation that counts characters instead produces an
    /// identical-looking message and a different digest, and nothing about the
    /// string comparison above would notice.
    function test_everyVectorDigestIsReproducedExactly() public {
        Vector[] memory vectors = _vectors();

        for (uint256 i = 0; i < vectors.length; i++) {
            Vector memory vector = vectors[i];
            assertEq(
                _adopterAt(vector).delegationDigest(
                    vector.delegate,
                    vector.deadline
                ),
                vector.digest,
                vector.name
            );
        }
    }

    /// @notice A signature made over a vector verifies against the contract that
    /// vector names, and against no other.
    ///
    /// The vectors pin bytes; this pins what the bytes are FOR. It also
    /// exercises the bound that motivates the whole design: the same credential
    /// presented at a different contract recovers a different address and is
    /// refused.
    function test_aSignatureOverAVectorRegistersAtThatContractAndNoOther()
        public
    {
        Vector[] memory vectors = _vectors();
        uint256 ownerKey = 0xA11CE;
        address owner = vm.addr(ownerKey);

        for (uint256 i = 0; i < vectors.length; i++) {
            Vector memory vector = vectors[i];
            // A deadline in the past is a valid vector but an unregistrable
            // credential, which is its own test elsewhere.
            if (vector.deadline != 0 && vector.deadline <= block.timestamp) {
                continue;
            }

            (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, vector.digest);
            bytes memory signature = abi.encodePacked(r, s, v);

            PlainAdopter here = _adopterAt(vector);
            here.registerDelegateViaSignature(
                owner,
                vector.delegate,
                vector.deadline,
                signature
            );
            (bool allowed, ) = here.delegationStatus(owner, vector.delegate);
            assertTrue(allowed, vector.name);

            // The same bytes, at a contract this credential does not name.
            PlainAdopter elsewhere = new PlainAdopter();
            vm.expectRevert(Delegation.InvalidSignature.selector);
            elsewhere.registerDelegateViaSignature(
                owner,
                vector.delegate,
                vector.deadline,
                signature
            );
        }
    }
}
