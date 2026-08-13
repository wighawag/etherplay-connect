/**
 * One feature with three faces, shipped together on purpose.
 *
 *  - the Solidity, in `contracts/`, consumed through node_modules and compiled INTO each adopter;
 *  - the TypeScript builder below, which produces the exact bytes that Solidity verifies;
 *  - the ABI, for a client calling a contract it does not compile against.
 *
 * They are together because the thing that breaks is agreement between them, and it breaks
 * silently: a signature over a message that differs by one byte does not fail loudly, it simply
 * recovers a different address. Co-located, the test that pins them runs on every change to either.
 */
export {delegationMessage, delegationDigest, type DelegationTerms} from './message.js';
export {DELEGATION_ABI} from './abi.js';
