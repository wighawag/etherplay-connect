// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from "forge-std/Test.sol";
import {Delegation} from "contracts/Delegation.sol";
import {Payments} from "contracts/utils/Payments.sol";
import {SignatureUtils} from "contracts/utils/SignatureUtils.sol";

/// The smallest thing that USES {Delegation}: it declares the entry points a
/// real contract would, and asks who a call belongs to. Standing in for a real
/// contract keeps these tests about the mechanism rather than about whatever
/// the mechanism is used for.
///
/// That it has to declare them at all is the library's central trade-off, made
/// visible: nothing appears here that was not written here.
contract DelegationHarness {
    address public lastActor;

    function act(address onBehalfOf) external {
        lastActor = Delegation.requireAccountFor(msg.sender, onBehalfOf);
    }

    function canActFor(
        address caller,
        address onBehalfOf
    ) external view returns (bool) {
        return Delegation.canActFor(caller, onBehalfOf);
    }

    function registerDelegate(
        address delegate,
        address payable payee
    ) external payable {
        Delegation.register(msg.sender, delegate);
        Payments.forward(payee, msg.value);
    }

    function registerDelegateViaSignature(
        address owner,
        address delegate,
        uint256 deadline,
        bytes calldata signature
    ) external payable {
        Delegation.registerViaSignature(owner, delegate, deadline, signature);
        Payments.forward(payable(delegate), msg.value);
    }

    function revokeDelegate(address delegate) external {
        Delegation.revoke(msg.sender, delegate);
    }

    function delegationStatus(
        address owner,
        address delegate
    ) external view returns (bool allowed, bool withdrawn) {
        return Delegation.statusOf(owner, delegate);
    }

    function delegationMessage(
        address delegate,
        uint256 deadline
    ) external view returns (string memory) {
        return Delegation.message(delegate, deadline);
    }

    function delegationDigest(
        address delegate,
        uint256 deadline
    ) external view returns (bytes32) {
        return Delegation.digest(delegate, deadline);
    }
}

/// Refuses to be paid, to exercise the failure branch of value forwarding.
contract RejectsValue {
    receive() external payable {
        revert("no thanks");
    }
}

contract DelegationTest is Test {
    DelegationHarness internal harness;

    // An owner as a KEY, because half of these need it to sign. It stands for
    // an account that can sign and can never send.
    uint256 internal ownerKey = 0xA11CE;
    address internal delegate = address(0xDE1E6A7E);
    address internal otherDelegate = address(0x5EC0AD);
    address internal submitter = address(0xB0B);
    address internal stranger = address(0xC4A121E);
    address payable internal payee = payable(address(0xFEE));

    function setUp() public {
        harness = new DelegationHarness();
    }

    function _owner() internal view returns (address) {
        return vm.addr(ownerKey);
    }

    function _sign(
        uint256 key,
        address forDelegate,
        uint256 deadline
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            key,
            harness.delegationDigest(forDelegate, deadline)
        );
        return abi.encodePacked(r, s, v);
    }

    function _allowed(
        address owner,
        address who
    ) internal view returns (bool allowed) {
        (allowed, ) = harness.delegationStatus(owner, who);
    }

    function _withdrawn(
        address owner,
        address who
    ) internal view returns (bool withdrawn) {
        (, withdrawn) = harness.delegationStatus(owner, who);
    }

    // ==================== requireAccountFor ====================

    function test_requireAccountFor_returnsTheCallerWhenNothingIsClaimed()
        public
    {
        vm.prank(stranger);
        harness.act(address(0));
        assertEq(harness.lastActor(), stranger);
    }

    function test_requireAccountFor_lettingTheCallerNameItself() public {
        // No authorisation needed to act as yourself, so a call site can pass
        // an owner through unconditionally without a delegation existing.
        vm.prank(stranger);
        harness.act(stranger);
        assertEq(harness.lastActor(), stranger);
    }

    function test_requireAccountFor_returnsTheOwnerForItsDelegate() public {
        address owner = _owner();
        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.prank(delegate);
        harness.act(owner);
        assertEq(harness.lastActor(), owner);
    }

    /// @notice Reverts rather than quietly falling back to the caller. An
    /// unauthorised claim is somebody trying to act as somebody else, and
    /// attributing it to them instead would record an action nobody asked for.
    function test_requireAccountFor_revertsOnAnUnauthorisedClaim() public {
        address owner = _owner();

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.NotDelegate.selector,
                owner,
                stranger
            )
        );
        harness.act(owner);
    }

    // ==================== canActFor ====================
    //
    // The question {requireAccountFor} is the assertion of. Kept separate so a
    // caller that wants to offer or hide an action, rather than to fail one,
    // does not have to provoke a revert to find out.

    function test_canActFor_isTrueForYourself() public view {
        assertTrue(harness.canActFor(stranger, stranger));
        assertTrue(harness.canActFor(stranger, address(0)));
    }

    function test_canActFor_followsTheRegistration() public {
        address owner = _owner();
        assertFalse(harness.canActFor(delegate, owner));

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));
        assertTrue(harness.canActFor(delegate, owner));

        vm.prank(owner);
        harness.revokeDelegate(delegate);
        assertFalse(harness.canActFor(delegate, owner));
    }

    /// @notice It asks, it does not enforce: no revert for an answer of no.
    function test_canActFor_doesNotRevert() public view {
        assertFalse(harness.canActFor(stranger, _owner()));
    }

    // ==================== a set, not a slot ====================

    /// @notice The reason this is a mapping per pair rather than one address.
    ///
    /// Two front-ends, two signers, both live at once. Under a single-delegate
    /// design the second registration evicted the first and the first app
    /// started reverting, which is the noise a membership set removes.
    function test_severalDelegatesActAtOnce() public {
        address owner = _owner();

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));
        vm.prank(owner);
        harness.registerDelegate(otherDelegate, payable(address(0)));

        assertTrue(_allowed(owner, delegate));
        assertTrue(_allowed(owner, otherDelegate));

        vm.prank(delegate);
        harness.act(owner);
        assertEq(harness.lastActor(), owner);

        vm.prank(otherDelegate);
        harness.act(owner);
        assertEq(harness.lastActor(), owner);
    }

    /// @notice Withdrawing one signer leaves the others alone.
    ///
    /// "Replace a signer" and "withdraw a signer" are different operations, and
    /// this is the one that makes them different.
    function test_revokingOneDelegateLeavesTheOthers() public {
        address owner = _owner();

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));
        vm.prank(owner);
        harness.registerDelegate(otherDelegate, payable(address(0)));

        vm.prank(owner);
        harness.revokeDelegate(delegate);

        assertFalse(_allowed(owner, delegate));
        assertTrue(_withdrawn(owner, delegate));
        assertTrue(_allowed(owner, otherDelegate));
        assertFalse(_withdrawn(owner, otherDelegate));
    }

    // ==================== registerDelegate ====================

    function test_registerDelegate_setsAndReportsTheDelegate() public {
        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));

        (bool allowed, bool withdrawn) = harness.delegationStatus(
            stranger,
            delegate
        );
        assertTrue(allowed);
        assertFalse(withdrawn);
    }

    /// @notice An untouched pair reads as no authority, having never been
    /// written: `None` is the zero value on purpose.
    function test_registerDelegate_saysNothingAboutOtherPairs() public view {
        (bool allowed, bool withdrawn) = harness.delegationStatus(
            stranger,
            delegate
        );
        assertFalse(allowed);
        assertFalse(withdrawn);
    }

    function test_registerDelegate_emits() public {
        vm.expectEmit(true, true, false, true);
        emit Delegation.DelegationChanged(stranger, delegate, true);
        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));
    }

    function test_registerDelegate_rejectsTheZeroDelegate() public {
        vm.prank(stranger);
        vm.expectRevert(Delegation.InvalidDelegate.selector);
        harness.registerDelegate(address(0), payable(address(0)));
    }

    function test_registerDelegate_forwardsValueToThePayee() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        harness.registerDelegate{value: 0.4 ether}(delegate, payee);

        assertEq(payee.balance, 0.4 ether);
        assertEq(address(harness).balance, 0);
    }

    /// @notice Value with no payee reverts rather than being kept.
    ///
    /// A zero payee is how an entry point says "no funding this time", so
    /// attaching value to one is a caller mistake. Keeping it would be the
    /// worst possible response: this contract has no way to release money, so
    /// the mistake would become funds nobody can ever recover. Failing leaves
    /// them where they started.
    function test_registerDelegate_refusesValueWithNoPayee() public {
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                Payments.ValueWithNoPayee.selector,
                uint256(1 ether)
            )
        );
        harness.registerDelegate{value: 1 ether}(delegate, payable(address(0)));

        // Nothing was kept, and nothing was registered: the whole call is off.
        assertEq(address(harness).balance, 0);
        assertEq(stranger.balance, 1 ether);
        assertFalse(_allowed(stranger, delegate));
    }

    /// @notice A zero payee is still fine when there is nothing to forward,
    /// which is the ordinary "register without funding" case.
    function test_registerDelegate_allowsNoPayeeWhenNoValueIsSent() public {
        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));
        assertTrue(_allowed(stranger, delegate));
    }

    function test_registerDelegate_forwardsNothingWhenNothingIsSent() public {
        vm.prank(stranger);
        harness.registerDelegate(delegate, payee);
        assertEq(payee.balance, 0);
    }

    function test_registerDelegate_revertsWhenThePayeeRefuses() public {
        address payable refuser = payable(address(new RejectsValue()));
        vm.deal(stranger, 1 ether);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Payments.TransferFailed.selector, refuser)
        );
        harness.registerDelegate{value: 1}(delegate, refuser);
    }

    // ==================== registerDelegateViaSignature ====================

    function test_viaSignature_registersAndIsPaidForBySomebodyElse() public {
        address owner = _owner();
        vm.deal(submitter, 1 ether);

        vm.prank(submitter);
        harness.registerDelegateViaSignature{value: 0.25 ether}(
            owner,
            delegate,
            0,
            _sign(ownerKey, delegate, 0)
        );

        assertTrue(_allowed(owner, delegate));
        // The value goes to the delegate and nowhere else, and the owner never
        // held or spent anything.
        assertEq(delegate.balance, 0.25 ether);
        assertEq(owner.balance, 0);
    }

    function test_viaSignature_rejectsAnotherKeysSignature() public {
        // Signed and recovered BEFORE expectRevert is armed: it applies to the
        // next call, and building the signature makes calls of its own.
        address owner = _owner();
        bytes memory signature = _sign(0xB0B, delegate, 0);

        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidSignature.selector);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);
    }

    function test_viaSignature_rejectsADifferentDelegate() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidSignature.selector);
        harness.registerDelegateViaSignature(
            owner,
            otherDelegate,
            0,
            signature
        );
    }

    /// @notice A deadline that was not the one signed does not verify.
    ///
    /// This is what makes it safe to take the deadline in calldata: the
    /// contract cannot know it, but it does not have to trust it either.
    /// Claiming a longer one breaks the signature, and claiming a shorter one
    /// only expires sooner.
    function test_viaSignature_rejectsADifferentDeadline() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 30 days;
        bytes memory signature = _sign(ownerKey, delegate, deadline);

        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidSignature.selector);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            deadline + 1,
            signature
        );
    }

    /// @notice THE BOUND THE WHOLE DESIGN RESTS ON.
    ///
    /// A credential granted at one contract is worth nothing at another, because
    /// the contract's own address is in the signed bytes and comes from
    /// `address(this)` rather than from the caller. Without this, signing in to
    /// any site using this scheme would hand it a standing authority usable at
    /// every contract adopting the library.
    function test_viaSignature_rejectsASignatureForADifferentContract() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        DelegationHarness elsewhere = new DelegationHarness();
        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidSignature.selector);
        elsewhere.registerDelegateViaSignature(owner, delegate, 0, signature);
    }

    /// @notice ...and the same for the chain, which `block.chainid` supplies.
    function test_viaSignature_rejectsASignatureFromADifferentChain() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.chainId(block.chainid + 1);
        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidSignature.selector);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);
    }

    function test_viaSignature_rejectsAMalformedSignature() public {
        address owner = _owner();

        vm.prank(submitter);
        vm.expectRevert(SignatureUtils.MalformedSignature.selector);
        harness.registerDelegateViaSignature(owner, delegate, 0, hex"1234");
    }

    function test_viaSignature_rejectsTheZeroDelegate() public {
        address owner = _owner();
        // Signed before expectRevert is armed: it applies to the next call, and
        // building the signature makes calls of its own.
        bytes memory signature = _sign(ownerKey, address(0), 0);

        vm.prank(submitter);
        vm.expectRevert(Delegation.InvalidDelegate.selector);
        harness.registerDelegateViaSignature(owner, address(0), 0, signature);
    }

    /// @notice No nonce, so this succeeds - and that is the design, not an
    /// oversight. It re-asserts a standing authorisation at the submitter's
    /// expense and changes nothing.
    function test_viaSignature_presentingItAgainIsHarmless() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.prank(submitter);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);
        vm.prank(stranger);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);

        assertTrue(_allowed(owner, delegate));
    }

    // ==================== deadlines ====================

    function test_deadline_acceptedWhileItHasNotPassed() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 30 days;
        bytes memory signature = _sign(ownerKey, delegate, deadline);

        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            deadline,
            signature
        );
        assertTrue(_allowed(owner, delegate));
    }

    /// @notice Inclusive: a credential is still good in its final second.
    function test_deadline_acceptedExactlyOnIt() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _sign(ownerKey, delegate, deadline);

        vm.warp(deadline);
        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            deadline,
            signature
        );
        assertTrue(_allowed(owner, delegate));
    }

    function test_deadline_refusedOneSecondLater() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 1 days;
        bytes memory signature = _sign(ownerKey, delegate, deadline);

        vm.warp(deadline + 1);
        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.SignatureExpired.selector,
                deadline
            )
        );
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            deadline,
            signature
        );
        assertFalse(_allowed(owner, delegate));
    }

    /// @notice Zero is no expiry, not a deadline at the epoch. The distinction
    /// an implementation loses the moment it treats a falsy deadline as absent.
    function test_deadline_zeroNeverExpires() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.warp(4102444800); // year 2100
        vm.prank(submitter);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);
        assertTrue(_allowed(owner, delegate));
    }

    /// @notice The deadline bounds how long the credential may be PRESENTED,
    /// not how long the authority lasts.
    ///
    /// Once registered, a delegate stands until it is revoked. Anyone reading
    /// the deadline as an onchain expiry would be wrong about who can act, so
    /// it is pinned here rather than left to be inferred.
    function test_deadline_doesNotExpireAnAlreadyRegisteredDelegate() public {
        address owner = _owner();
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            deadline,
            _sign(ownerKey, delegate, deadline)
        );

        vm.warp(deadline + 365 days);
        assertTrue(_allowed(owner, delegate));

        vm.prank(delegate);
        harness.act(owner);
        assertEq(harness.lastActor(), owner);
    }

    // ==================== revokeDelegate ====================

    function test_revoke_endsTheAuthorisation() public {
        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.prank(stranger);
        harness.revokeDelegate(delegate);

        (bool allowed, bool withdrawn) = harness.delegationStatus(
            stranger,
            delegate
        );
        assertFalse(allowed);
        assertTrue(withdrawn);
    }

    function test_revoke_emits() public {
        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.expectEmit(true, true, false, true);
        emit Delegation.DelegationChanged(stranger, delegate, false);
        vm.prank(stranger);
        harness.revokeDelegate(delegate);
    }

    /// @notice Revoking an address that was never authorised is allowed, and is
    /// not a no-op: it pre-empts a signature that may already exist for it.
    ///
    /// A credential is derivable by whatever produced it long before anyone
    /// submits it, so "block this address" has to be sayable in advance.
    function test_revoke_worksBeforeAnythingWasRegistered() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.prank(owner);
        harness.revokeDelegate(delegate);

        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.DelegationWithdrawn.selector,
                owner,
                delegate
            )
        );
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);
    }

    /// @notice ...but not the zero delegate, which no register path can ever
    /// have accepted. There is nothing to withdraw and no signature to pre-empt,
    /// so it can only be a caller passing an address it failed to set - and
    /// letting it through would write a meaningless entry into the log an app
    /// replays to reconstruct the set.
    function test_revoke_rejectsTheZeroDelegate() public {
        vm.prank(stranger);
        vm.expectRevert(Delegation.InvalidDelegate.selector);
        harness.revokeDelegate(address(0));
    }

    /// @notice The reason the withdrawn state exists at all.
    ///
    /// The signature has no nonce, so without it anyone could present the
    /// credential again and quietly undo a revocation the owner meant. It is
    /// per delegate, so only the REVOKED delegate is blocked.
    function test_revoke_cannotBeUndoneByPresentingTheSignatureAgain() public {
        address owner = _owner();
        bytes memory signature = _sign(ownerKey, delegate, 0);

        vm.prank(submitter);
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);

        vm.prank(owner);
        harness.revokeDelegate(delegate);

        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(
                Delegation.DelegationWithdrawn.selector,
                owner,
                delegate
            )
        );
        harness.registerDelegateViaSignature(owner, delegate, 0, signature);

        assertFalse(_allowed(owner, delegate));
    }

    /// @notice Withdrawing one delegate does not block a different one, so a
    /// user can add or replace a signer by signature alone, without sending a
    /// transaction.
    function test_revoke_aDifferentDelegateCanStillRegisterViaSignature()
        public
    {
        address owner = _owner();

        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            0,
            _sign(ownerKey, delegate, 0)
        );

        vm.prank(owner);
        harness.revokeDelegate(delegate);

        // The withdrawn delegate is still blocked ...
        assertTrue(_withdrawn(owner, delegate));
        // ... but a new delegate registers by signature just fine.
        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            otherDelegate,
            0,
            _sign(ownerKey, otherDelegate, 0)
        );
        assertTrue(_allowed(owner, otherDelegate));
        assertFalse(_withdrawn(owner, otherDelegate));
    }

    /// @notice Withdrawal is one-way for signatures, but the OWNER can always
    /// change its mind: sending the transaction is live consent, not a static
    /// message presented again. Re-authorising clears the withdrawn state for
    /// that delegate.
    function test_revoke_isClearedByTheOwnerRegisteringAgain() public {
        address owner = _owner();

        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            0,
            _sign(ownerKey, delegate, 0)
        );

        vm.prank(owner);
        harness.revokeDelegate(delegate);
        assertTrue(_withdrawn(owner, delegate));

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));
        assertTrue(_allowed(owner, delegate));
        assertFalse(_withdrawn(owner, delegate));

        // ...and signatures work again from here on.
        vm.prank(submitter);
        harness.registerDelegateViaSignature(
            owner,
            delegate,
            0,
            _sign(ownerKey, delegate, 0)
        );
        assertTrue(_allowed(owner, delegate));
    }

    // ==================== keyed by owner ====================

    /// @notice One account cannot damage another by claiming its delegate.
    ///
    /// The mapping is keyed by OWNER first precisely so this is a no-op against
    /// the victim: the claimer only makes their own account answer to an address
    /// they do not control.
    function test_claimingSomebodyElsesDelegateDoesNotAffectThem() public {
        address owner = _owner();

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.prank(delegate);
        harness.act(owner);

        assertEq(harness.lastActor(), owner);
        assertTrue(_allowed(owner, delegate));
    }

    /// @notice Nor by revoking it: a revocation touches the revoker's own pair.
    function test_revokingSomebodyElsesDelegateDoesNotAffectThem() public {
        address owner = _owner();

        vm.prank(owner);
        harness.registerDelegate(delegate, payable(address(0)));

        vm.prank(stranger);
        harness.revokeDelegate(delegate);

        assertTrue(_allowed(owner, delegate));
        assertFalse(_withdrawn(owner, delegate));
        assertTrue(_withdrawn(stranger, delegate));
    }

    // ==================== the signed text ====================

    /// @notice The exact bytes whatever produces the signature has to
    /// reproduce.
    ///
    /// Pinned as a literal rather than rebuilt, so changing the wording is a
    /// deliberate act with a failing test attached, instead of something that
    /// silently invalidates every signature ever generated. The cross-language
    /// version of this lives in Vectors.t.sol and test/js/vectors.test.ts.
    function test_delegationMessage_isExactlyThis() public {
        vm.chainId(1);
        assertEq(
            harness.delegationMessage(delegate, 0),
            string(
                abi.encodePacked(
                    "IMPORTANT: Only sign this on a site you trust.\n\n",
                    "This authorizes another address to act in your name onchain, at one contract.\n",
                    "You can withdraw it at any time by revoking it there.\n\n",
                    "Delegate: 0x00000000000000000000000000000000de1e6a7e\n",
                    "Contract: ",
                    vm.toLowercase(vm.toString(address(harness))),
                    "\n",
                    "Chain ID: 1\n",
                    "Expires: never"
                )
            )
        );
    }

    function test_delegationMessage_carriesTheDeadlineAndTheChain() public {
        vm.chainId(31337);
        assertEq(
            harness.delegationMessage(delegate, 1767225600),
            string(
                abi.encodePacked(
                    "IMPORTANT: Only sign this on a site you trust.\n\n",
                    "This authorizes another address to act in your name onchain, at one contract.\n",
                    "You can withdraw it at any time by revoking it there.\n\n",
                    "Delegate: 0x00000000000000000000000000000000de1e6a7e\n",
                    "Contract: ",
                    vm.toLowercase(vm.toString(address(harness))),
                    "\n",
                    "Chain ID: 31337\n",
                    "Expires: 1767225600"
                )
            )
        );
    }

    /// @notice The contract and the chain are READ, not taken as arguments, so
    /// the same call at two contracts produces two different messages.
    function test_delegationMessage_namesThisContractAndThisChain() public {
        DelegationHarness elsewhere = new DelegationHarness();
        assertTrue(
            keccak256(bytes(harness.delegationMessage(delegate, 0))) !=
                keccak256(bytes(elsewhere.delegationMessage(delegate, 0)))
        );

        string memory onThisChain = harness.delegationMessage(delegate, 0);
        vm.chainId(block.chainid + 1);
        assertTrue(
            keccak256(bytes(onThisChain)) !=
                keccak256(bytes(harness.delegationMessage(delegate, 0)))
        );
    }

    /// @notice There is no `Origin:` first line any more, and its absence is
    /// load-bearing.
    ///
    /// Under the etherplay convention that prefix tells a conforming wallet a
    /// message is safe to sign without asking, which is exactly the property
    /// being removed: auto-signing now comes from the host's allowlist, not
    /// from the shape of the message.
    function test_delegationMessage_doesNotStartWithAnOriginLine() public view {
        bytes memory message = bytes(harness.delegationMessage(delegate, 0));
        assertEq(bytes8(message), bytes8("IMPORTAN"));
    }

    // ==================== storage layout ====================

    /// @notice Namespaced storage (ERC-7201) is what makes this safe to inherit.
    ///
    /// Storage of a base contract precedes that of the contract inheriting it,
    /// so plain state here would shift every slot of an adopting contract and
    /// corrupt anything already live behind a proxy. This asserts the status
    /// mapping really does live at the namespaced location and not at slot 0.
    function test_storageLivesAtTheNamespacedLocation() public {
        bytes32 location =
            keccak256(
                abi.encode(
                    uint256(keccak256("etherplay.storage.Delegation")) - 1
                )
            ) & ~bytes32(uint256(0xff));
        assertEq(location, Delegation.STORAGE_LOCATION);

        vm.prank(stranger);
        harness.registerDelegate(delegate, payable(address(0)));

        // `status` is the only member of the struct, so its mapping base is the
        // location itself, and the inner mapping hangs off the owner slot.
        bytes32 ownerSlot = keccak256(abi.encode(stranger, location));
        bytes32 pairSlot = keccak256(abi.encode(delegate, ownerSlot));
        assertEq(
            uint256(vm.load(address(harness), pairSlot)),
            uint256(Delegation.Status.Allowed)
        );

        // ...and nothing landed at slot 0, where an adopting contract's own
        // first variable has to stay.
        assertEq(vm.load(address(harness), bytes32(0)), bytes32(0));
    }
}
