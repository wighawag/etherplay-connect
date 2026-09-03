// Type-surface lock for the target `ensureConnected` promises, and for the resting state it can
// come back with.
//
// No runtime here: `tsc -p tsconfig.types.json` IS the test, and a compile error is a failing one.
//
// What is pinned:
//
// 1. The mechanism shapes a caller actually passes when it names an account still compile, in both
//    spellings (with a wallet name and without). A consumer had to hand-write this union to call
//    the library at all, so it is exactly the shape to keep from regressing.
// 2. A real store still satisfies the STRUCTURAL type that consumer declares, so the two spellings
//    of the same thing cannot drift apart silently.
// 3. `addressUnavailable` is readable off a `Connection` at any step, which is what makes it
//    renderable beside `error` rather than something a consumer has to narrow to reach.
// 4. `acknowledgeAddressUnavailable` and `canActAs` exist on every store shape, since the state
//    they answer can arise on any of them.

import {
	createConnection,
	canActAs,
	type AddressUnavailable,
	type AnyConnectionStore,
	type Connection,
} from '../../src/index.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const ADDRESS = '0xaaaa000000000000000000000000000000000aaa' as `0x${string}`;

const payment = createConnection({targetStep: 'WalletConnected', chainInfo, autoConnect: false});

// 1. Naming an account, with the wallet named and without.
payment.ensureConnected(
	'WalletConnected',
	{type: 'wallet', name: 'Rabby', address: ADDRESS},
	{doNotStoreLocally: true},
);
payment.ensureConnected('WalletConnected', {type: 'wallet', address: ADDRESS}, {doNotStoreLocally: true});
// ...and the forms that existed before, unchanged.
payment.ensureConnected();
payment.ensureConnected({doNotStoreLocally: true});
payment.ensureConnected('WalletConnected', {type: 'wallet', name: 'Rabby'});

// 2. The structural shape a consumer declares for "a connection I can ask to sign as X", which both
// its app connection and its payment rail have to fit despite being differently-typed stores.
type SignableConnection = {
	subscribe: (run: (value: any) => void) => () => void;
	ensureConnected: (
		step: 'WalletConnected',
		mechanism?:
			| {type: 'wallet'; name: string; address: `0x${string}`}
			| {type: 'wallet'; name?: undefined; address: `0x${string}`},
		options?: {doNotStoreLocally?: boolean},
	) => Promise<unknown>;
};
const signable: SignableConnection = payment;
void signable;

// 3. The resting reason, beside `error`, on any state.
function render(connection: Connection<unknown>): string | undefined {
	const unavailable: AddressUnavailable | undefined = connection.addressUnavailable;
	if (!unavailable) {
		return undefined;
	}
	// Every field the instruction needs, without narrowing the step first.
	const {requested, selected, available, walletName, message} = unavailable;
	void requested;
	void selected;
	void available;
	void walletName;
	return message;
}
void render;

// 4. Present on every store shape, and answering without initiating anything.
function readiness(store: AnyConnectionStore<unknown>, connection: Connection<unknown>): boolean {
	store.acknowledgeAddressUnavailable();
	const fromStore: boolean = store.canActAs(ADDRESS);
	const fromState: boolean = canActAs(connection, ADDRESS);
	return fromStore && fromState;
}
void readiness;
