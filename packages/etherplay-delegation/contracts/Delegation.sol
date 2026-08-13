// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

import {StringUtils} from "./utils/StringUtils.sol";
import {SignatureUtils} from "./utils/SignatureUtils.sol";

/// @title Delegation
/// @notice Lets an account authorise other addresses to act in its name, at
/// the contract that adopts this library and nowhere else.
///
/// The problem it solves: an app that acts on its user's behalf sends from a
/// key of its own, so the address that signs a transaction is not the account
/// the action belongs to. A contract that records `msg.sender` records the
/// wrong one, and the user sees one address in the app and another against
/// their actions, with nothing onchain connecting them.
///
/// THE UNIT OF AUTHORITY IS ONE CONTRACT: yours. A delegate authorised here may
/// act for its owner here, and an identical signature is worth nothing at any
/// other contract, because the contract's own address is part of what was
/// signed. There is no scope, no capability and no per-route key: this library
/// answers "whose action is this", which is identity, not permission. An
/// adopter that needs narrower authority than "the whole contract" has a seam
/// for it in {UsingDelegation-_requireAccountForSender}, which is more
/// expressive than a storage key and costs nothing when unused.
///
/// A SET, NOT A SLOT: an owner may have any number of delegates at once, so a
/// second front-end does not evict the first, and withdrawing one signer is not
/// entangled with replacing another. The membership check costs exactly what an
/// equality check did.
///
/// A LIBRARY, NOT A BASE CONTRACT, and deliberately. Inheriting would give a
/// contract external functions that appear in its ABI without appearing in its
/// source, which is the opposite of what a contract you are about to deploy
/// should do, and it would stop an adopter declining a path it does not want.
/// As a library neither applies: you write your own entry points, and you can
/// see all of them.
///
/// The price is that you write those entry points, and they are lines that say
/// exactly what your contract exposes. If the standard shape is what you want,
/// {UsingDelegation} is that same set written once and ready to inherit - read
/// it for the full set - and inheriting it is safe for the same reason this is
/// a library at all, since the namespaced storage below means it declares no
/// state and so shifts none of yours.
///
/// NOT A REGISTRY, and this is the one mistake that undoes everything above.
/// "A registry" is the obvious noun for what this looks like, and a shared
/// `DelegationRegistry` that many contracts point at is not a variation on this
/// design, it is its opposite: the verifying contract in every signature would
/// be that registry, so every credential granted for one game would be valid
/// at every game on it, which is exactly the unbounded authority the contract
/// field exists to remove. This package ships SOURCE. Each adopter compiles it
/// into its own contract and owns its own delegations.
///
/// STORAGE IS NAMESPACED (ERC-7201), so this owns a region nothing else can
/// collide with, at a slot derived from a name rather than from a position.
/// A contract already live behind a proxy can therefore adopt delegation on an
/// upgrade without disturbing the layout it already has.
///
/// Every function is `internal`, so they inline into your contract: no library
/// deployment, no linking, no `delegatecall`, and `msg.sender` is still the
/// caller you expect. It is also what makes `address(this)` in the signed text
/// below mean YOUR contract rather than some library address.
library Delegation {
    /// @notice the standing of one (owner, delegate) pair.
    ///
    /// The three states are exclusive, which is why one word per pair is
    /// faithful rather than a compression of two flags: {revoke} sets
    /// `Withdrawn` and removes authority in the same write, an owner-sent
    /// {register} clears `Withdrawn` because it is a fresh decision, and the
    /// signature path refuses to cross it.
    ///
    /// `None` is the zero value, so an untouched pair reads as no authority
    /// without anything ever having been written.
    enum Status {
        None,
        Allowed,
        Withdrawn
    }

    /// @notice emitted whenever a (owner, delegate) pair changes standing.
    ///
    /// THIS EVENT IS THE ENUMERATION API. There is no onchain list of an
    /// account's delegates - a linked set was costed and rejected, since few
    /// delegates are expected and signer management belongs to the application
    /// rather than to the library - so reconstructing the set means replaying
    /// these logs in order. Both addresses are indexed, which gives a
    /// per-account `eth_getLogs` query with no indexer; the flag is not, since
    /// nobody filters on it.
    ///
    /// One event rather than an authorise/revoke pair, because a replay wants
    /// both kinds in order and a single topic0 is one filter and one decode.
    ///
    /// The wart, and it belongs to the app rather than to this library: many
    /// public and wallet-supplied RPCs cap `eth_getLogs` ranges, so a fresh
    /// browser reconstructing from genesis needs a stored deployment block and
    /// paging.
    ///
    /// @param owner the account being represented
    /// @param delegate the address whose standing changed
    /// @param allowed true when it may now act for `owner`, false when its
    ///        authorisation was withdrawn
    event DelegationChanged(
        address indexed owner,
        address indexed delegate,
        bool allowed
    );

    /// @notice `sender` is not a delegate of `owner` at this contract
    error NotDelegate(address owner, address sender);

    /// @notice the owner withdrew its authorisation for `delegate`; only the
    /// owner itself can authorise that delegate again (see {revoke})
    error DelegationWithdrawn(address owner, address delegate);

    /// @notice the signature was not produced by `owner`, or was produced for a
    /// different delegate, deadline, contract or chain
    error InvalidSignature();

    /// @notice a delegate must be a real address; use {revoke} to withdraw one
    error InvalidDelegate();

    /// @notice the signature named a deadline that has already passed
    error SignatureExpired(uint256 deadline);

    /// @custom:storage-location erc7201:etherplay.storage.Delegation
    struct Layout {
        /// owner => delegate => whether that delegate may act for that owner
        /// here, has been withdrawn, or was never authorised.
        ///
        /// Keyed by OWNER first, deliberately. The reverse mapping would let
        /// anyone claim someone else's delegate address (which is public the
        /// moment that delegate sends anything) and have that owner's actions
        /// attributed to the claimer. Keyed this way, the worst an attacker
        /// achieves is making their OWN account answer to an address they do
        /// not control, which harms nobody.
        ///
        /// The inner key is the DELEGATE, so withdrawing one signer says
        /// nothing about any other: a registration signature is permanently
        /// derivable by whatever produced it, and a per-owner withdrawal would
        /// make it impossible to add a new signer by signature alone once any
        /// old one had been withdrawn.
        mapping(address owner => mapping(address delegate => Status)) status;
    }

    /// keccak256(abi.encode(uint256(keccak256("etherplay.storage.Delegation")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE_LOCATION =
        0xe3a6fc8979f365f798ce92a5c63aa15935638389b80320c807252f142f884200;

    /// @dev this library's storage, inside the CALLING contract.
    ///
    /// Internal library functions are inlined rather than `delegatecall`ed, so
    /// the slot below resolves against the caller's own storage. That is what
    /// lets a library own state without having any.
    ///
    /// PRIVATE, so an adopting contract cannot reach past the functions below
    /// and write the mapping directly. `internal` would hand every adopter a
    /// route around the zero-delegate check, the withdrawn state and the event,
    /// which is a wide hole to leave in something meant to be handed to people
    /// writing their own contracts. Nothing outside this library needs it.
    function layout() private pure returns (Layout storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    // ------------------------------------------------------------------------
    // READING
    // ------------------------------------------------------------------------

    /// @notice the standing of one (owner, delegate) pair, as two flags.
    ///
    /// Two bools rather than the {Status} value itself, at the same single
    /// SLOAD. It keeps an enum out of every interface, ABI and client that
    /// would otherwise have to remember whether 2 means withdrawn, and both
    /// questions an app has - may this signer act, and do I need a transaction
    /// from the owner to fix it - are answered by one call.
    ///
    /// @return allowed whether `delegate` may act for `owner` here
    /// @return withdrawn whether `owner` withdrew `delegate`, which blocks
    ///         {registerViaSignature} for that delegate until `owner`
    ///         authorises it again itself
    function statusOf(
        address owner,
        address delegate
    ) internal view returns (bool allowed, bool withdrawn) {
        Status current = layout().status[owner][delegate];
        return (current == Status.Allowed, current == Status.Withdrawn);
    }

    /// @notice whether `sender` may act as `onBehalfOf`.
    ///
    /// Asks; does not enforce. For a view a UI can call before offering an
    /// action, and for a call site that wants to do something other than revert.
    /// Anyone may always act as themselves, and a zero `onBehalfOf` means
    /// exactly that, so neither costs an SLOAD.
    ///
    /// @param sender normally `msg.sender`, but see UsingDelegation for the
    ///        case where a contract resolves its effective sender differently
    /// @param onBehalfOf the account being claimed, or zero for none
    function canActFor(
        address sender,
        address onBehalfOf
    ) internal view returns (bool) {
        if (onBehalfOf == address(0) || onBehalfOf == sender) {
            return true;
        }
        return layout().status[onBehalfOf][sender] == Status.Allowed;
    }

    /// @notice the account this action belongs to, or revert.
    ///
    /// THE FUNCTION YOUR CONTRACT ACTUALLY USES. Call it wherever you would
    /// have taken `msg.sender` as the identity an action belongs to, and record
    /// what it returns. A zero `onBehalfOf` means "acting for myself", so an
    /// entry point can pass one through unconditionally and behave exactly as
    /// it did before delegation existed.
    ///
    /// NAMED FOR THE ENFORCEMENT, not just the lookup: it reverts on an
    /// unauthorised claim rather than falling back to the sender. Somebody
    /// trying to act as somebody else is not a request to act as themselves,
    /// and quietly recording it that way would store an action nobody asked
    /// for. Use {canActFor} when a question rather than a requirement is what
    /// you want.
    ///
    /// @param sender normally `msg.sender`, but see UsingDelegation for the
    ///        case where a contract resolves its effective sender differently
    /// @param onBehalfOf the account being claimed, or zero for none
    function requireAccountFor(
        address sender,
        address onBehalfOf
    ) internal view returns (address) {
        if (!canActFor(sender, onBehalfOf)) {
            revert NotDelegate(onBehalfOf, sender);
        }
        return onBehalfOf == address(0) ? sender : onBehalfOf;
    }

    // ------------------------------------------------------------------------
    // GRANTING
    // ------------------------------------------------------------------------

    /// @notice authorise `delegate` to act for `owner` here, on `owner`'s own
    /// say-so.
    ///
    /// AUTHORISES NOTHING ITSELF: the adopting contract must already have
    /// established that `owner` is the one asking, normally by passing
    /// `msg.sender`. It also CLEARS a previous withdrawal of `delegate`, which
    /// is only sound BECAUSE the owner is acting directly - that is a fresh
    /// decision, not a signature presented again - so passing anything else
    /// here would let one account undo another's revocation.
    ///
    /// @param owner the account authorising, i.e. `msg.sender`
    /// @param delegate the address to authorise; use {revoke} to withdraw it
    function register(address owner, address delegate) internal {
        if (delegate == address(0)) {
            revert InvalidDelegate();
        }
        layout().status[owner][delegate] = Status.Allowed;
        emit DelegationChanged(owner, delegate, true);
    }

    /// @notice authorise `delegate` to act for `owner` here, proven by
    /// `owner`'s signature, whoever is sending the transaction.
    ///
    /// The point: an owner that can sign but cannot send, or that holds no
    /// funds, can still delegate. It signs, somebody else submits and pays.
    ///
    /// The signature carries no nonce, on purpose. It grants a standing
    /// authorisation to one named address at one named contract on one named
    /// chain, so presenting it a second time only re-asserts what is already
    /// true, at the submitter's expense. The one thing repetition could undo is
    /// a revocation, which is why {revoke} leaves a state this refuses to cross
    /// for THAT delegate only - a different delegate can still be authorised by
    /// a fresh signature.
    ///
    /// WHAT IS AND IS NOT CALLER-SUPPLIED. The contract and the chain come from
    /// `address(this)` and `block.chainid` and can never be passed in, because
    /// they are the bounds the whole design rests on and a caller-supplied
    /// bound is no bound at all. The deadline HAS to be passed in: it was
    /// chosen by whoever produced the signature and this contract has no other
    /// way to learn it. That is safe because it is not trusted - a deadline
    /// that does not match the one that was signed simply recovers a different
    /// address, and lying about it in either direction fails, since a later
    /// deadline breaks the signature and an earlier one only expires sooner.
    ///
    /// THE OWNER MUST BE A KEY, not a contract. Verification is `ecrecover`, so
    /// an ERC-1271 smart account cannot register this way and there is no
    /// `isValidSignature` fallback. Such an account is not locked out, it takes
    /// the other path: {register}, which proves who is asking by who is sending.
    /// The two suit opposite shapes, and this one exists for a signer that can
    /// sign and cannot send, which is the thing a contract account is not.
    ///
    /// WHAT THE DEADLINE BOUNDS is how long the credential may be PRESENTED,
    /// not how long the authority lasts. Once registered, a delegate stands
    /// until it is revoked. That is the honest reading of a standing
    /// authorisation, and it is why a deadline is worth having anyway: it is
    /// the only bound on a credential that was minted without a human in the
    /// loop and has since turned out to be a mistake.
    ///
    /// @param owner the account being represented
    /// @param delegate the address to authorise
    /// @param deadline the unix time after which this signature stops being
    ///        accepted, or zero for no expiry
    /// @param signature `owner`'s signature over {message}
    function registerViaSignature(
        address owner,
        address delegate,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (delegate == address(0)) {
            revert InvalidDelegate();
        }
        if (deadline != 0 && block.timestamp > deadline) {
            revert SignatureExpired(deadline);
        }
        Layout storage $ = layout();
        if ($.status[owner][delegate] == Status.Withdrawn) {
            revert DelegationWithdrawn(owner, delegate);
        }
        if (
            SignatureUtils.recover(digest(delegate, deadline), signature) !=
            owner
        ) {
            revert InvalidSignature();
        }

        $.status[owner][delegate] = Status.Allowed;
        emit DelegationChanged(owner, delegate, true);
    }

    /// @notice withdraw `owner`'s authorisation of `delegate`: it can no longer
    /// act here, and no signature can put THAT delegate back.
    ///
    /// AUTHORISES NOTHING ITSELF: the adopting contract must already have
    /// established that `owner` is the one asking, normally by passing
    /// `msg.sender`.
    ///
    /// Takes the delegate as an argument, because an owner may have several and
    /// "withdraw everything" is not what someone replacing one signer means.
    /// Withdrawing an address that was never authorised is allowed and is not a
    /// no-op: it pre-empts a signature that may already exist for it, which is a
    /// real case, since a credential is derivable by whatever produced it long
    /// before anyone submits it.
    ///
    /// The zero delegate is the one exception, and is refused. Neither register
    /// path can ever have accepted it, so there is nothing to withdraw and no
    /// signature to pre-empt: it can only be a caller passing an address it
    /// failed to set. Refusing costs one comparison and keeps a meaningless
    /// entry out of {DelegationChanged}, which matters more than it sounds,
    /// because that log IS the enumeration API and an app replaying it would
    /// have to know to ignore the entry.
    ///
    /// One-way as far as signatures are concerned, deliberately. Re-authorising
    /// the SAME delegate takes a transaction from the owner ({register}),
    /// because a signature that carries no nonce can state a standing
    /// authorisation but cannot express a decision to reverse one, and reading
    /// it as such would let an old signature outrank a newer intent. A DIFFERENT
    /// delegate can still be authorised by a fresh signature.
    ///
    /// This is withdrawal of consent, not key rotation. If a delegate key leaks
    /// there is nothing to rotate to that the same leak would not also expose,
    /// so the useful response is to stop.
    function revoke(address owner, address delegate) internal {
        if (delegate == address(0)) {
            revert InvalidDelegate();
        }
        layout().status[owner][delegate] = Status.Withdrawn;
        emit DelegationChanged(owner, delegate, false);
    }

    // ------------------------------------------------------------------------
    // THE SIGNED TEXT
    // ------------------------------------------------------------------------

    // Prose, then a block of labelled fields.
    //
    // Readable text rather than typed data, because the owner is being asked to
    // hand another address authority over their account, and what they can read
    // in the signing dialog matters more than what it costs to check here. The
    // shape borrows from EIP-4361 without being it: 4361 is built around a
    // domain, a URI and a nonce, all three deliberately absent here.
    //
    // The prose comes FIRST so the first thing a human sees is what they are
    // agreeing to, and so the field block cannot be mistaken for the leading
    // `Origin:` line of the etherplay convention, which tells a conforming
    // wallet a message is safe to sign without asking. It is not: a wallet
    // implementing only that rule must fall through to prompting.
    //
    // EVERYTHING THAT MATTERS IS A FIELD, none of it inline in the prose,
    // because a wallet has to extract the delegate (to compare against the
    // signer it derives) and the contract and chain (to check against whatever
    // it auto-signs), and one extraction strategy is better than two.
    //
    // There is no origin in it. The wallet always knows the true origin of the
    // page asking, so a claimed one tells it nothing, and the delegate address
    // already carries the origin binding by being a pure function of (account
    // key, origin). There is no version field either: any change to these bytes
    // invalidates every signature regardless, so there is no negotiation to be
    // had, and a wallet that cannot parse what it sees falls back to showing
    // raw text and prompting.
    //
    // `Expires: never` stays a line rather than being omitted, since an absent
    // line is easy for a human to miss and easy for a parser to treat as an
    // unset default.
    //
    // WHATEVER PRODUCES THE SIGNATURE BUILDS THIS SAME STRING, so the wording,
    // the field order and the address casing are consensus, not style. Changing
    // any of it invalidates every signature ever generated, silently. The other
    // implementations in this package are the TypeScript builder in `src/` and
    // the ABI it is exercised through; all of them are pinned against
    // `vectors.json`, and a change to one without the others is a change that
    // will pass review and fail in production.
    string internal constant MESSAGE_HEAD =
        "IMPORTANT: Only sign this on a site you trust.\n\n"
        "This authorizes another address to act in your name onchain, at one contract.\n"
        "You can withdraw it at any time by revoking it there.\n\n"
        "Delegate: ";
    string internal constant MESSAGE_CONTRACT = "\nContract: ";
    string internal constant MESSAGE_CHAIN_ID = "\nChain ID: ";
    string internal constant MESSAGE_EXPIRES = "\nExpires: ";
    string internal constant MESSAGE_NO_EXPIRY = "never";

    /// @notice the exact text an owner signs to authorise `delegate` here.
    ///
    /// Expose it, so a caller can display it and so whatever produces the
    /// signature can be asserted byte-for-byte against it. The two have to
    /// agree exactly or every signature is rejected, so the agreement is worth
    /// being checkable from outside rather than by reading both sides.
    ///
    /// `view` rather than `pure`: the contract and the chain are read from
    /// `address(this)` and `block.chainid` rather than taken as arguments,
    /// which is what stops a caller choosing them.
    ///
    /// Both addresses are rendered lowercase; see {StringUtils-toHexString}.
    /// The deadline is decimal unix seconds, or the word `never` for zero.
    function message(
        address delegate,
        uint256 deadline
    ) internal view returns (string memory) {
        return
            string(
                abi.encodePacked(
                    MESSAGE_HEAD,
                    StringUtils.toHexString(delegate),
                    MESSAGE_CONTRACT,
                    StringUtils.toHexString(address(this)),
                    MESSAGE_CHAIN_ID,
                    StringUtils.toString(block.chainid),
                    MESSAGE_EXPIRES,
                    deadline == 0
                        ? MESSAGE_NO_EXPIRY
                        : StringUtils.toString(deadline)
                )
            );
    }

    /// @notice the EIP-191 digest of {message}.
    function digest(
        address delegate,
        uint256 deadline
    ) internal view returns (bytes32) {
        return SignatureUtils.textDigest(bytes(message(delegate, deadline)));
    }
}
