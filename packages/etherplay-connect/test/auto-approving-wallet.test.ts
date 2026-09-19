// A wallet can declare that IT NEVER ASKS THE USER ANYTHING, and the library stops claiming it did.
//
// `connection.pendingRequests` means "your wallet is holding something and is waiting for you", and
// consumers render it as exactly that: a modal saying the wallet will ask you to confirm in a
// moment, a cancel affordance, an unload guard. For a wallet that holds its own key and signs with
// no dialog, all three describe an interaction that never happens. The consumer that hit this ran a
// chain in the browser tab with a generated wallet and had to mount NO wallet UI at all for that
// route, which is right for the route and wrong as an answer, because the same fact then has to be
// re-inferred by every app that shows such a surface.
//
// So the fact belongs beside the wallet's name and icon (`WalletInfo.autoApproves`), and this file
// pins both halves: the declaration is readable from the connection store, and the library acts on
// it in exactly one way.
//
// The control cases matter as much as the suppression: a wallet that says nothing is a wallet that
// prompts, and every assertion below has a twin proving the announcement is still made for one.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {
	createConnection,
	walletPrompts,
	type Connection,
	type RequestEvent,
	type UnderlyingEthereumProvider,
} from '../src/index.js';
import {createBroughtWallet, type BroughtWallet} from './fixtures/brought-wallet.js';

const CONTRACT = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512' as const;
const PAGE_ORIGIN = 'http://localhost:3000';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const MESSAGE_HEX = `0x${Buffer.from('hello').toString('hex')}` as `0x${string}`;

function snapshotOf(connection: {
	subscribe: (run: (value: Connection<UnderlyingEthereumProvider>) => void) => () => void;
}) {
	return () => {
		let state!: Connection<UnderlyingEthereumProvider>;
		connection.subscribe((value) => {
			state = value;
		})();
		return state;
	};
}

describe('a wallet that declares it never prompts', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
	});

	afterEach(() => {
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
	});

	async function connectedTo(wallet: BroughtWallet, storagePrefix: string) {
		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix,
			wallets: [wallet.handle],
		});
		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		return {connection, snapshot: snapshotOf(connection)};
	}

	it('says so on the connection store, beside the name and the icon', async () => {
		const silent = createBroughtWallet({autoApproves: true});
		const {snapshot} = await connectedTo(silent, 'silent:');

		const state = snapshot();
		// On the announced handle, which is what a picker renders from...
		expect(state.wallets[0].info.autoApproves).toBe(true);
		// ...and on the wallet the connection is actually using, which is what a "your wallet will
		// ask you" surface renders from. An app should not have to match a name against a list to
		// find out whether the thing it is connected to asks anybody anything.
		expect(state.wallet?.info?.autoApproves).toBe(true);
		expect(walletPrompts(state.wallet?.info)).toBe(false);
	});

	it('defaults to the loud behaviour when the wallet says nothing', async () => {
		const loud = createBroughtWallet();
		const {snapshot} = await connectedTo(loud, 'loud:');

		const state = snapshot();
		expect('autoApproves' in state.wallets[0].info).toBe(false);
		// The default is not "unknown", it is "it prompts": that is what every wallet UI was written
		// under and the only safe reading of a wallet that has not said.
		expect(walletPrompts(state.wallet?.info)).toBe(true);
	});

	it('announces nothing while it signs, because there is nothing to announce', async () => {
		const silent = createBroughtWallet({autoApproves: true});
		const {connection, snapshot} = await connectedTo(silent, 'silent:');

		const events: RequestEvent[] = [];
		connection.onRequest((event) => events.push(event));

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		silent.whileSigning = () => {
			during = snapshot();
		};

		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, silent.account],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		// DURING the signature, which is the only moment that can distinguish this from a wallet that
		// answered too fast to see.
		expect(during?.pendingRequests).toEqual([]);
		expect(during?.wallet?.pendingRequests).toEqual([]);
		// And the event stream says the same thing: a consumer driving its own dialog from
		// `onRequest` must not be handed a start it should render, nor an end for a start it never saw.
		expect(events).toEqual([]);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('still announces for a wallet that has not declared anything', async () => {
		// The control. Suppression that is not conditional on the declaration is just the missing
		// modal bug of `docs/adr/0001-...` reintroduced behind a new name.
		const loud = createBroughtWallet();
		const {connection, snapshot} = await connectedTo(loud, 'loud:');

		const events: RequestEvent[] = [];
		connection.onRequest((event) => events.push(event));

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		loud.whileSigning = () => {
			during = snapshot();
		};

		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, loud.account],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(during?.pendingRequests).toHaveLength(1);
		expect(during?.pendingRequests[0].kind).toBe('signature');
		expect(events.map((event) => event.type)).toEqual(['requestStart', 'requestEnd']);
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('says nothing about a transaction either', async () => {
		const silent = createBroughtWallet({autoApproves: true});
		const {connection, snapshot} = await connectedTo(silent, 'silent:');

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		silent.whileSigning = () => {
			during = snapshot();
		};

		const sending = connection.provider.request({
			method: 'eth_sendTransaction',
			params: [{from: silent.account, to: silent.account}],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await sending;

		expect(during?.pendingRequests).toEqual([]);
	});

	it('is decided when the request STARTS, so a switch cannot silence a real prompt', async () => {
		// A request outlives the wallet state it started under: the user is free to switch wallet
		// while one is outstanding (see the ADR), and the request stays with the wallet actually
		// holding it. "Was anybody ever going to be asked about this" is therefore a fact about the
		// wallet that TOOK the request, not about whichever wallet is current when it ends. Deciding
		// again later would erase a prompt that is genuinely on the user's screen.
		const loud = createBroughtWallet({name: 'Loud Wallet', uuid: 'uuid-loud', rdns: 'com.example.loud'});
		const silent = createBroughtWallet({
			name: 'Silent Wallet',
			uuid: 'uuid-silent',
			rdns: 'com.example.silent',
			autoApproves: true,
			account: '0x3333333333333333333333333333333333333333',
		});

		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'both:',
			wallets: [loud.handle, silent.handle],
		});
		const snapshot = snapshotOf(connection);

		const connecting = connection.connect({type: 'wallet', name: 'Loud Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		// The loud wallet takes a signature and holds it, as a wallet waiting on a human does.
		let releaseSignature!: () => void;
		loud.whileSigning = () => new Promise<void>((resolve) => (releaseSignature = resolve));
		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, loud.account],
		} as never);
		await vi.advanceTimersByTimeAsync(10);
		expect(snapshot().pendingRequests).toHaveLength(1);

		// The user switches to the silent wallet while the first prompt is still up.
		const switching = connection.connect({type: 'wallet', name: 'Silent Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().wallet?.info?.autoApproves).toBe(true);
		// The prompt is still on the user's screen, so it is still announced.
		expect(snapshot().pendingRequests).toHaveLength(1);

		releaseSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(snapshot().pendingRequests).toEqual([]);
	});

	it('keeps a silenced request silent even after switching to a wallet that prompts', async () => {
		// The same rule read the other way round: a request the silent wallet took was never a
		// question, and a later switch must not turn it into one retroactively.
		const silent = createBroughtWallet({
			name: 'Silent Wallet',
			uuid: 'uuid-silent',
			rdns: 'com.example.silent',
			autoApproves: true,
		});
		const loud = createBroughtWallet({
			name: 'Loud Wallet',
			uuid: 'uuid-loud',
			rdns: 'com.example.loud',
			account: '0x3333333333333333333333333333333333333333',
		});

		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'both:',
			wallets: [silent.handle, loud.handle],
		});
		const snapshot = snapshotOf(connection);
		const events: RequestEvent[] = [];
		connection.onRequest((event) => events.push(event));

		const connecting = connection.connect({type: 'wallet', name: 'Silent Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		let releaseSignature!: () => void;
		silent.whileSigning = () => new Promise<void>((resolve) => (releaseSignature = resolve));
		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, silent.account],
		} as never);
		await vi.advanceTimersByTimeAsync(10);
		expect(snapshot().pendingRequests).toEqual([]);

		const switching = connection.connect({type: 'wallet', name: 'Loud Wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await switching;

		expect(snapshot().pendingRequests).toEqual([]);
		releaseSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(events).toEqual([]);
	});

	it('says nothing when such a wallet REFUSES either', async () => {
		// The end of a silenced request travels the error branch of the wrapper's bookkeeping, which is
		// a different path from the success one. A silenced request that ends there must stay silent,
		// and must not leave its decision behind: an id that is never forgotten is a leak, and one
		// forgotten too early hands a consumer an end for a start it never saw.
		const silent = createBroughtWallet({autoApproves: true});
		const {connection, snapshot} = await connectedTo(silent, 'silent:');

		const events: RequestEvent[] = [];
		connection.onRequest((event) => events.push(event));

		silent.whileSigning = () => {
			throw Object.assign(new Error('the embedded wallet said no'), {code: 4001});
		};

		// Attached before the clock is advanced: an unhandled rejection fails the run for a reason
		// that has nothing to do with this test.
		const rejected = expect(
			connection.provider.request({method: 'personal_sign', params: [MESSAGE_HEX, silent.account]} as never),
		).rejects.toBeDefined();
		await vi.advanceTimersByTimeAsync(200);
		await rejected;

		expect(events).toEqual([]);
		expect(snapshot().pendingRequests).toEqual([]);

		// And the next request is decided afresh rather than inheriting the forgotten one's answer.
		silent.whileSigning = undefined;
		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, silent.account],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await signing;
		expect(events).toEqual([]);
	});

	it('says nothing for the signatures the LIBRARY originates either', async () => {
		// `getDelegation` and `getSignatureForPublicKeyPublication` go through the wrapper's own
		// `signMessage`, which carries a `purpose` and is a separate surface from `provider.request`
		// (see ADR-0001). A delegation is the request this library is most careful to announce, which is
		// exactly why it needs saying that an auto-approving wallet is not exempted by a side door.
		const silent = createBroughtWallet({autoApproves: true});
		const connection = createConnection({
			walletOnly: true,
			chainInfo,
			autoConnect: false,
			storagePrefix: 'silent-signed:',
			wallets: [silent.handle],
		});
		const snapshot = snapshotOf(connection);

		const connecting = connection.connect({type: 'wallet'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;
		const signingIn = connection.requestSignature();
		await vi.advanceTimersByTimeAsync(200);
		await signingIn;

		const events: RequestEvent[] = [];
		connection.onRequest((event) => events.push(event));

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		silent.whileSigning = () => {
			during = snapshot();
		};

		const getting = connection.getDelegation({chainId: 1, contract: CONTRACT});
		await vi.advanceTimersByTimeAsync(200);
		await getting;

		// The hook ran, so the wallet really was asked to sign: this is not an empty list from an
		// attempt that never happened.
		expect(during).toBeDefined();
		expect(during?.pendingRequests).toEqual([]);
		expect(events).toEqual([]);
	});

	it('does not silence when two supplied handles wrap the SAME provider', async () => {
		// Provider identity is not a wallet identity. A caller may supply two handles over one provider
		// object (the same in-tab chain offered under two names, a test double reused), and the connected
		// one is then not recoverable by scanning the list for the provider. Inheriting the OTHER
		// handle's `autoApproves` would hide a prompt the user is looking at, so the declaration is read
		// from the handle that was actually chosen.
		const silent = createBroughtWallet({
			name: 'Silent Face',
			uuid: 'uuid-silent-face',
			rdns: 'com.example.face.silent',
			autoApproves: true,
		});
		const loudFace = {
			info: {uuid: 'uuid-loud-face', name: 'Loud Face', icon: '', rdns: 'com.example.face.loud'},
			// DELIBERATELY the same provider object as the silent handle above.
			walletProvider: silent.handle.walletProvider,
		};

		const connection = createConnection({
			targetStep: 'WalletConnected',
			chainInfo,
			autoConnect: false,
			storagePrefix: 'faces:',
			// The silent one FIRST, so a scan by provider identity would find it and be wrong.
			wallets: [silent.handle, loudFace],
		});
		const snapshot = snapshotOf(connection);

		const connecting = connection.connect({type: 'wallet', name: 'Loud Face'});
		await vi.advanceTimersByTimeAsync(200);
		await connecting;

		expect(snapshot().wallet?.info?.name).toBe('Loud Face');
		expect(walletPrompts(snapshot().wallet?.info)).toBe(true);

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		silent.whileSigning = () => {
			during = snapshot();
		};
		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, silent.account],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(during?.pendingRequests).toHaveLength(1);
	});

	it('does not silence a wallet whose declaration it cannot see', async () => {
		// `autoApproves: false` is a wallet saying the ordinary thing out loud, and must behave
		// exactly like one that said nothing.
		const explicitlyLoud = createBroughtWallet({autoApproves: false});
		const {connection, snapshot} = await connectedTo(explicitlyLoud, 'explicit:');

		let during: Connection<UnderlyingEthereumProvider> | undefined;
		explicitlyLoud.whileSigning = () => {
			during = snapshot();
		};

		const signing = connection.provider.request({
			method: 'personal_sign',
			params: [MESSAGE_HEX, explicitlyLoud.account],
		} as never);
		await vi.advanceTimersByTimeAsync(200);
		await signing;

		expect(during?.pendingRequests).toHaveLength(1);
	});
});
