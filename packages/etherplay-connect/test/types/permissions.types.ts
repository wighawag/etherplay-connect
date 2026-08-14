// Type-surface lock for `permissions`, the connect-time declaration of onchain authority.
//
// No runtime tests here. This file is checked by `pnpm test:types` (`tsc -p tsconfig.types.json`)
// and FAILS TO COMPILE if the promise below is broken.
//
// The promise: you may only declare permissions on a configuration that can actually honour them.
//
// A declaration is honoured by the HOST, at sign-in, because a hosted account holds its key there
// and sign-in is the only moment a credential can be minted for it. A configuration with no host to
// reach cannot mint anything, so a declaration on one would be a silent no-op, and the app would be
// left unable to tell "you declined" from "nobody asked" - which is precisely the ambiguity the
// per-entry outcomes exist to remove. Better a compile error than a promise nothing keeps.
//
// The other half of that promise is runtime, and belongs to the wallet path rather than to the
// types: on a host-capable connection the user may still pick the injected wallet as owner, which
// no overload can express. That case answers the declaration with `sign-on-demand` instead of
// ignoring it. See `test/permissions.test.ts`.

import {createConnection, type PermissionDeclaration} from '../../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const permissions: PermissionDeclaration[] = [
	{type: 'delegation', chainId: 1, contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512'},
];

// ---------------------------------------------------------------------------
// 1. Allowed where a host can honour it.
// ---------------------------------------------------------------------------

createConnection({walletHost: 'https://wallet.example.com', chainInfo, permissions});
createConnection({
	targetStep: 'SignedIn',
	walletOnly: false,
	walletHost: 'https://wallet.example.com',
	chainInfo,
	permissions,
});

// ---------------------------------------------------------------------------
// 2. Refused where nothing could honour it.
// ---------------------------------------------------------------------------
// If these ever stop erroring, `@ts-expect-error` becomes an unused-directive compile failure,
// which is the intended alarm.

// @ts-expect-error - wallet-only has no host to mint credentials; the owner signs on demand instead
createConnection({targetStep: 'SignedIn', walletOnly: true, chainInfo, permissions});

// Kept on ONE line deliberately: `@ts-expect-error` only suppresses an error reported on the very
// next line, and for a multi-line call TypeScript attributes "no overload matches" to the offending
// property rather than to the opening line, so the directive would sit unused and this file would
// fail for the wrong reason.
// prettier-ignore
// @ts-expect-error - still refused when a host is configured but the mechanisms are wallet-only
createConnection({targetStep: 'SignedIn', walletOnly: true, walletHost: 'https://w.example', chainInfo, permissions});

// @ts-expect-error - a WalletConnected connection has no session signer to delegate TO
createConnection({targetStep: 'WalletConnected', chainInfo, permissions});

// ---------------------------------------------------------------------------
// 3. The shape of a declaration.
// ---------------------------------------------------------------------------

// A delegation names one contract on one chain: that pair is the whole extent of the authority.
const delegation: PermissionDeclaration = {
	type: 'delegation',
	required: true,
	chainId: 31337,
	contract: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
};

// The escape hatch: a type this version does not know about still type-checks, because a newer app
// asking an older host for something and being TOLD it did not get it is the designed behaviour.
const future: PermissionDeclaration = {type: 'teleport', required: false, destination: 'moon'};

export type {delegation, future};
