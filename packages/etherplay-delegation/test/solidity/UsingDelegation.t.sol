// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {Delegation} from "contracts/Delegation.sol";
import {UsingDelegation} from "contracts/UsingDelegation.sol";

/// A contract that inherits the mixin AND has state of its own.
///
/// The state matters: `label` is declared here, in the DERIVED contract, which
/// is the position a base contract's storage would normally push out of slot 0.
/// If {UsingDelegation} ever gains a state variable, the assertion below stops
/// holding and this test fails, which is the point of it.
contract Adopter is UsingDelegation {
    string public label;
    uint256 public counter;

    address public lastActor;

    constructor(string memory initialLabel) {
        label = initialLabel;
    }

    function act(address onBehalfOf) external {
        lastActor = _requireAccountForSender(onBehalfOf);
        counter++;
    }
}

/// An adopter whose effective sender is NOT `msg.sender`.
///
/// Stands in for a relayed or signature-based contract, where the address that
/// sent the transaction is not the address whose authority is being used. It
/// overrides the one function {UsingDelegation} documents as the seam for
/// exactly this; a real one would recover the address from a signature rather
/// than being told it.
///
/// A TEST ARTIFACT, deliberately. Relayed execution is not something this
/// package ships (it needs nonces and replay protection that delegation itself
/// does not), but the override IS documented as supported, and a `virtual` that
/// nothing exercises is a promise nobody has checked.
contract RelayedAdopter is UsingDelegation {
    address public effectiveSender;
    address public lastActor;

    function setEffectiveSender(address sender) external {
        effectiveSender = sender;
    }

    function _requireAccountForSender(
        address onBehalfOf
    ) internal view override returns (address) {
        return Delegation.requireAccountFor(effectiveSender, onBehalfOf);
    }

    function act(address onBehalfOf) external {
        lastActor = _requireAccountForSender(onBehalfOf);
    }
}

contract UsingDelegationTest is Test {
    Adopter internal adopter;

    uint256 internal ownerKey = 0xA11CE;
    address internal delegate = address(0xDE1E6A7E);
    address internal otherDelegate = address(0x5EC0AD);
    address internal submitter = address(0xB0B);
    address internal stranger = address(0xC4A121E);

    function setUp() public {
        adopter = new Adopter("hello");
    }

    function _owner() internal view returns (address) {
        return vm.addr(ownerKey);
    }

    function _sign(
        address forDelegate,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            ownerKey,
            adopter.delegationDigest(forDelegate, deadline)
        );
        return abi.encodePacked(r, s, v);
    }

    // ==================== the reason it is safe to inherit ====================

    /// @notice The mixin adds nothing to the adopter's storage layout.
    ///
    /// A base contract's state normally precedes the derived contract's, so
    /// inheriting one is inheriting a slot offset. {UsingDelegation} declares no
    /// state at all - {Delegation} keeps everything in a namespaced region - so
    /// the adopter's own first variable stays exactly where it would have been
    /// without the inheritance. That is what makes this mixin safe to add to a
    /// contract already live behind a proxy.
    function test_inheritingAddsNothingToTheLayout() public view {
        // `label` is a short string, so it lives inline in slot 0.
        bytes32 slot0 = vm.load(address(adopter), bytes32(0));
        assertEq(bytes5(slot0), bytes5(bytes("hello")));

        // and `counter` follows immediately in slot 1.
        assertEq(uint256(vm.load(address(adopter), bytes32(uint256(1)))), 0);
    }

    function test_delegationStateLivesInTheNamespacedRegion() public {
        bytes32 location =
            keccak256(
                abi.encode(
                    uint256(keccak256("etherplay.storage.Delegation")) - 1
                )
            ) & ~bytes32(uint256(0xff));
        assertEq(location, Delegation.STORAGE_LOCATION);

        vm.prank(stranger);
        adopter.registerDelegate(delegate, payable(address(0)));

        // `status` is the only struct member, so its mapping base is the
        // location itself, and the inner mapping hangs off the owner slot.
        bytes32 ownerSlot = keccak256(abi.encode(stranger, location));
        bytes32 pairSlot = keccak256(abi.encode(delegate, ownerSlot));
        assertEq(
            uint256(vm.load(address(adopter), pairSlot)),
            uint256(Delegation.Status.Allowed)
        );

        // The adopter's own state is untouched by any of it.
        assertEq(adopter.label(), "hello");
        assertEq(adopter.counter(), 0);
    }

    /// @notice Adopting delegation does not disturb what was already stored.
    function test_adoptersOwnStateSurvivesDelegationUse() public {
        vm.prank(stranger);
        adopter.act(address(0));
        assertEq(adopter.counter(), 1);

        address owner = _owner();
        vm.prank(owner);
        adopter.registerDelegate(delegate, payable(address(0)));

        vm.prank(delegate);
        adopter.act(owner);

        assertEq(adopter.lastActor(), owner);
        assertEq(adopter.counter(), 2);
        assertEq(adopter.label(), "hello");
    }

    // ==================== the entry points are wired ====================
    //
    // The mechanism itself is covered in Delegation.t.sol. What is checked here
    // is only that each inherited function reaches it, since a mixin that
    // forwards to the wrong thing would fail nowhere else.

    function test_registerAndRead() public {
        vm.prank(stranger);
        adopter.registerDelegate(delegate, payable(address(0)));

        (bool allowed, bool withdrawn) = adopter.delegationStatus(
            stranger,
            delegate
        );
        assertTrue(allowed);
        assertFalse(withdrawn);
    }

    function test_registerForwardsValue() public {
        address payable payee = payable(address(0xFEE));
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        adopter.registerDelegate{value: 0.3 ether}(delegate, payee);

        assertEq(payee.balance, 0.3 ether);
    }

    function test_registerViaSignatureAndFundTheDelegate() public {
        address owner = _owner();

        vm.deal(submitter, 1 ether);
        vm.prank(submitter);
        adopter.registerDelegateViaSignature{value: 0.2 ether}(
            owner,
            delegate,
            0,
            _sign(delegate, 0)
        );

        (bool allowed, ) = adopter.delegationStatus(owner, delegate);
        assertTrue(allowed);
        assertEq(delegate.balance, 0.2 ether);
    }

    function test_registerViaSignatureCarriesTheDeadline() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 7 days;

        vm.prank(submitter);
        adopter.registerDelegateViaSignature(
            owner,
            delegate,
            deadline,
            _sign(delegate, deadline)
        );

        (bool allowed, ) = adopter.delegationStatus(owner, delegate);
        assertTrue(allowed);
    }

    /// @notice Revoking names the delegate, so the others survive it.
    function test_revokeTakesADelegate() public {
        vm.startPrank(stranger);
        adopter.registerDelegate(delegate, payable(address(0)));
        adopter.registerDelegate(otherDelegate, payable(address(0)));
        adopter.revokeDelegate(delegate);
        vm.stopPrank();

        (bool allowed, bool withdrawn) = adopter.delegationStatus(
            stranger,
            delegate
        );
        assertFalse(allowed);
        assertTrue(withdrawn);

        (bool otherAllowed, ) = adopter.delegationStatus(
            stranger,
            otherDelegate
        );
        assertTrue(otherAllowed);
    }

    function test_digestMatchesTheMessage() public view {
        string memory message = adopter.delegationMessage(delegate, 0);
        assertEq(
            adopter.delegationDigest(delegate, 0),
            keccak256(
                abi.encodePacked(
                    "\x19Ethereum Signed Message:\n",
                    vm.toString(bytes(message).length),
                    message
                )
            )
        );
    }

    /// @notice The mixin's message names the ADOPTER, not the library and not
    /// whoever called it, because `address(this)` resolves in the contract the
    /// internal function was inlined into. That is what makes the credential
    /// good at this contract only, and it is the property a proxy preserves:
    /// behind one, `address(this)` is the proxy, which is the unit of authority.
    function test_messageNamesTheAdopter() public view {
        assertTrue(
            _contains(
                adopter.delegationMessage(delegate, 0),
                vm.toLowercase(vm.toString(address(adopter)))
            )
        );
    }

    function _contains(
        string memory haystack,
        string memory needle
    ) internal pure returns (bool) {
        bytes memory hay = bytes(haystack);
        bytes memory pin = bytes(needle);
        if (pin.length > hay.length) {
            return false;
        }
        for (uint256 i = 0; i <= hay.length - pin.length; i++) {
            bool matching = true;
            for (uint256 j = 0; j < pin.length; j++) {
                if (hay[i + j] != pin[j]) {
                    matching = false;
                    break;
                }
            }
            if (matching) {
                return true;
            }
        }
        return false;
    }

    // ==================== the override seam ====================
    //
    // The documented route to relayed or signature-based execution: override
    // one function and every call site in the contract follows it.

    function test_overridingTheSenderIsEnough() public {
        RelayedAdopter relayed = new RelayedAdopter();
        address owner = _owner();

        // Registration still reads msg.sender - only the ACTING path is
        // overridden, which is the common case and worth showing.
        vm.prank(owner);
        relayed.registerDelegate(delegate, payable(address(0)));

        // Now somebody else entirely sends the transaction, and the contract
        // still says the delegate is the one acting.
        relayed.setEffectiveSender(delegate);
        vm.prank(submitter);
        relayed.act(owner);

        assertEq(relayed.lastActor(), owner);
    }

    function test_overridingStillEnforces() public {
        RelayedAdopter relayed = new RelayedAdopter();
        address owner = _owner();

        // An effective sender that was never authorised is refused, even though
        // the transaction itself is perfectly well-formed.
        relayed.setEffectiveSender(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.NotDelegate.selector,
                owner,
                stranger
            )
        );
        relayed.act(owner);
    }

    /// @notice The override really does displace `msg.sender`, rather than this
    /// passing because the two happen to coincide.
    ///
    /// Without this one, the two above would pass even if the override did
    /// nothing at all.
    function test_overridingIgnoresTheRealMsgSender() public {
        RelayedAdopter relayed = new RelayedAdopter();
        address owner = _owner();

        vm.prank(owner);
        relayed.registerDelegate(delegate, payable(address(0)));

        // msg.sender IS the authorised delegate, but the effective sender is
        // not, so this must still fail.
        relayed.setEffectiveSender(stranger);
        vm.prank(delegate);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.NotDelegate.selector,
                owner,
                stranger
            )
        );
        relayed.act(owner);
    }

    function test_requireAccountForSenderRevertsOnAnUnauthorisedClaim() public {
        address owner = _owner();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.NotDelegate.selector,
                owner,
                stranger
            )
        );
        adopter.act(owner);
    }
}
