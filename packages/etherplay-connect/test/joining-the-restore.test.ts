// An attempt that names NOTHING NEW joins the auto-connect in flight instead of superseding it.
//
// 0.17.1 made the construction-time restore yield to anything that moved the flow while it waited
// on a slow wallet (see `late-auto-connect.test.ts`). That is right for an attempt that asks for
// something else (another wallet, another account, a `disconnect`), and wrong for one that asks for
// nothing the restore is not already doing. Measured downstream (template-commit-reveal's
// `table.e2e.ts`, against 0.17.1): sign in, reload, click at once. The click calls
// `ensureConnected()` before the restore has landed, the restore is dropped, and the page asks the
// user to sign in again although a stored session exists. On 0.17.0 the restore landed and the
// action carried on signed in.

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createConnection, type Connection} from '../src/index.js';
import {installLockableWallet, type LockableWallet} from './fixtures/lockable-wallet.js';
import {keySetOf} from './fixtures/current-accounts.js';

const chainInfo = {
	id: 1,
	name: 'Ethereum Mainnet',
	rpcUrls: {default: {http: ['https://eth-mainnet.example.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
} as const;

const A = '0xaaaa00000000000000000000000000000000000a' as `0x${string}`;
const B = '0xbbbb00000000000000000000000000000000000b' as `0x${string}`;
const STORED_SIGNER = '0x5555000000000000000000000000000000000005' as `0x${string}`;
const PAGE_ORIGIN = 'http://localhost:3000';
const WALLET_NAME = 'Slow Wallet';

/** What a previous session signed in as `address` left behind. */
function rememberSignedInAs(address: `0x${string}`) {
	const mechanism = {type: 'wallet', name: WALLET_NAME, address};
	const account = JSON.stringify({
		address,
		signer: {
			origin: PAGE_ORIGIN,
			address: STORED_SIGNER,
			publicKey: `0x${'cd'.repeat(33)}`,
			privateKey: `0x${'ef'.repeat(32)}`,
		},
		// No publication signature yet, as the wallet path stores it until the app asks for one.
		keySet: keySetOf(`0x${'ef'.repeat(32)}`),
		metadata: {},
		mechanismUsed: mechanism,
		savedDelegations: [],
	});
	localStorage.setItem('__origin_account', account);
	sessionStorage.setItem('__origin_account', account);
	const lastWallet = JSON.stringify(mechanism);
	localStorage.setItem('__last_wallet', lastWallet);
	sessionStorage.setItem('__last_wallet', lastWallet);
}

/** The steps the flow showed, in order, so a test can say "never asked to sign in". */
const SIGN_IN_PROMPTS = ['MechanismToChoose', 'WalletToChoose', 'ChooseWalletAccount', 'WaitingForSignature'];

describe('an attempt made while the restore is in flight', () => {
	let wallet: LockableWallet | undefined;
	let signatures = 0;

	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		(globalThis as {origin?: string}).origin = PAGE_ORIGIN;
		vi.useFakeTimers();
		signatures = 0;
	});

	afterEach(() => {
		wallet?.uninstall();
		wallet = undefined;
		delete (globalThis as {origin?: string}).origin;
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	function installSlowWallet(accounts: `0x${string}`[] = [A, B]) {
		wallet = installLockableWallet({uuid: 'uuid-slow', name: WALLET_NAME, rdns: 'com.example.slow', accounts});
		wallet.whileSigning = () => {
			signatures++;
		};
		return wallet;
	}

	function createRestoringConnection(walletOnly: boolean) {
		const connection = createConnection({
			chainInfo,
			walletOnly,
			walletHost: walletOnly ? undefined : 'https://wallet-host.example.com',
			targetStep: 'SignedIn',
			requestSignatureAutomaticallyIfPossible: true,
		} as any);
		const steps: string[] = [];
		let state!: Connection<any>;
		connection.subscribe((v) => {
			state = v;
			if (steps[steps.length - 1] !== v.step) {
				steps.push(v.step);
			}
		});
		return {connection, steps, snapshot: () => state as any};
	}

	function settledOf<T>(promise: Promise<T>) {
		const outcome: {value?: T; error?: unknown; done: boolean} = {done: false};
		promise.then(
			(value) => {
				outcome.value = value;
				outcome.done = true;
			},
			(error) => {
				outcome.error = error;
				outcome.done = true;
			},
		);
		return outcome;
	}

	for (const walletOnly of [true, false]) {
		for (const slowRead of ['eth_chainId', 'eth_accounts'] as const) {
			const calls = {
				'ensureConnected()': (c: any) => c.ensureConnected(),
				"ensureConnected('SignedIn')": (c: any) => c.ensureConnected('SignedIn'),
				"ensureConnected('WalletConnected')": (c: any) => c.ensureConnected('WalletConnected'),
				"ensureConnected({type: 'wallet', name})": (c: any) => c.ensureConnected({type: 'wallet', name: WALLET_NAME}),
				"ensureConnected({type: 'wallet', name: uuid})": (c: any) =>
					c.ensureConnected({type: 'wallet', name: 'uuid-slow'}),
				"ensureConnected('SignedIn', the stored account)": (c: any) =>
					c.ensureConnected('SignedIn', {type: 'wallet', name: WALLET_NAME, address: A}),
			};
			for (const [label, call] of Object.entries(calls)) {
				it(`${label} joins it and resolves signed in as the stored account (walletOnly: ${walletOnly}, slow ${slowRead})`, async () => {
					rememberSignedInAs(A);
					const release = installSlowWallet().holdNext(slowRead);
					const {connection, steps, snapshot} = createRestoringConnection(walletOnly);
					// The wallet announces and the restore starts, then waits on the held read.
					await vi.advanceTimersByTimeAsync(200);
					expect(snapshot().step).toBe('Idle');

					const outcome = settledOf(call(connection));
					await vi.advanceTimersByTimeAsync(200);
					expect(outcome.done).toBe(false);

					release();
					await vi.advanceTimersByTimeAsync(2000);

					expect(outcome.error).toBeUndefined();
					expect(outcome.done).toBe(true);
					expect((outcome.value as any).step).toBe('SignedIn');
					expect((outcome.value as any).account.address).toBe(A);
					expect(snapshot().step).toBe('SignedIn');
					expect(snapshot().account.address).toBe(A);
					expect(snapshot().account.signer.address).toBe(STORED_SIGNER);
					expect(signatures).toBe(0);
					expect(steps.filter((step) => SIGN_IN_PROMPTS.includes(step))).toEqual([]);
				});
			}
		}
	}

	it('connect() with no argument joins it too: no signature, no picker', async () => {
		rememberSignedInAs(A);
		const release = installSlowWallet().holdNext('eth_accounts');
		const {connection, steps, snapshot} = createRestoringConnection(false);
		await vi.advanceTimersByTimeAsync(200);

		const outcome = settledOf(connection.connect());
		await vi.advanceTimersByTimeAsync(200);
		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(outcome.done).toBe(true);
		expect(outcome.error).toBeUndefined();
		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().account.address).toBe(A);
		expect(snapshot().account.signer.address).toBe(STORED_SIGNER);
		expect(signatures).toBe(0);
		expect(steps.filter((step) => SIGN_IN_PROMPTS.includes(step))).toEqual([]);
	});

	it('ensureConnected() joins the last-wallet restore too (targetStep: WalletConnected)', async () => {
		const lastWallet = JSON.stringify({type: 'wallet', name: WALLET_NAME, address: A});
		localStorage.setItem('__last_wallet', lastWallet);
		sessionStorage.setItem('__last_wallet', lastWallet);
		const release = installSlowWallet().holdNext('eth_accounts');
		const connection = createConnection({chainInfo, targetStep: 'WalletConnected'});
		const steps: string[] = [];
		let state!: Connection<any>;
		connection.subscribe((v) => {
			state = v;
			steps.push(v.step);
		});
		await vi.advanceTimersByTimeAsync(200);

		const outcome = settledOf(connection.ensureConnected());
		await vi.advanceTimersByTimeAsync(200);
		expect(outcome.done).toBe(false);
		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(outcome.error).toBeUndefined();
		expect((outcome.value as any).step).toBe('WalletConnected');
		expect((state as any).account.address).toBe(A);
		expect(wallet!.requestAccountsCalls()).toBe(0);
		expect(steps).not.toContain('ChooseWalletAccount');
		expect(steps).not.toContain('WaitingForWalletConnection');
	});

	// THE RESTORE LANDS SHORT of what the call reaches: the joined call drives on from there.

	function rememberLastWallet(address?: `0x${string}`) {
		const lastWallet = JSON.stringify(
			address ? {type: 'wallet', name: WALLET_NAME, address} : {type: 'wallet', name: WALLET_NAME},
		);
		localStorage.setItem('__last_wallet', lastWallet);
		sessionStorage.setItem('__last_wallet', lastWallet);
	}

	const driveOnCalls = {
		'connect()': (c: any) => c.connect(),
		'ensureConnected()': (c: any) => c.ensureConnected(),
	};
	for (const [label, call] of Object.entries(driveOnCalls)) {
		it(`${label} joins a last-wallet restore under targetStep SignedIn and asks for the one signature left`, async () => {
			// No stored origin account, only the last wallet: the restore lands `WalletConnected` as A, and
			// the signature is the only thing between there and `SignedIn`. One prompt, no picker.
			rememberLastWallet(A);
			const release = installSlowWallet().holdNext('eth_accounts');
			const {connection, steps, snapshot} = createRestoringConnection(true);
			await vi.advanceTimersByTimeAsync(200);

			const outcome = settledOf(call(connection));
			await vi.advanceTimersByTimeAsync(200);
			expect(outcome.done).toBe(false);
			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(outcome.error).toBeUndefined();
			expect(outcome.done).toBe(true);
			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(A);
			expect(signatures).toBe(1);
			expect(steps).not.toContain('ChooseWalletAccount');
			expect(steps).not.toContain('WalletToChoose');
			expect(steps).not.toContain('WaitingForWalletConnection');
		});
	}

	const upgradeCalls = {
		"connect({type: 'wallet', name})": (c: any) => c.connect({type: 'wallet', name: WALLET_NAME}),
		"ensureConnected('WalletConnected')": (c: any) => c.ensureConnected('WalletConnected'),
	};
	for (const [label, call] of Object.entries(upgradeCalls)) {
		it(`${label} joins a WalletChosen restore and still connects the chosen wallet`, async () => {
			// Choosing a wallet asks it for no accounts, and accounts are what this call is for: landing
			// on the choice is not landing on what was asked, so the call carries on and connects.
			rememberLastWallet();
			const release = installSlowWallet([A]).holdNext('eth_chainId');
			const connection = createConnection({chainInfo, targetStep: 'WalletChosen', prioritizeWalletProvider: true});
			let state!: Connection<any>;
			connection.subscribe((v) => {
				state = v;
			});
			await vi.advanceTimersByTimeAsync(200);

			const outcome = settledOf(call(connection));
			await vi.advanceTimersByTimeAsync(200);
			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(outcome.error).toBeUndefined();
			expect(outcome.done).toBe(true);
			expect((state as any).step).toBe('WalletConnected');
			expect((state as any).account.address).toBe(A);
			expect((state as any).wallet.status).toBe('connected');
		});
	}

	it('a joined ensureConnected() runs its own flow when the restore fails', async () => {
		// The held read never comes back inside the restore's 5s `withTimeout`, so the restore rests at
		// `Idle`. The joined call then does what it does from `Idle`: connect, and with
		// `requestSignatureAutomaticallyIfPossible`, ask for the signature. One account, so that own
		// flow does not stop at the account picker.
		rememberSignedInAs(A);
		installSlowWallet([A]).holdNext('eth_accounts');
		const {connection, snapshot} = createRestoringConnection(true);
		await vi.advanceTimersByTimeAsync(200);

		const outcome = settledOf(connection.ensureConnected());
		await vi.advanceTimersByTimeAsync(6000);
		await vi.advanceTimersByTimeAsync(200);

		expect(outcome.error).toBeUndefined();
		expect(outcome.done).toBe(true);
		expect(snapshot().step).toBe('SignedIn');
		expect(snapshot().account.address).toBe(A);
		expect(snapshot().account.signer.address).not.toBe(STORED_SIGNER);
		expect(signatures).toBe(1);
	});

	// THE NEGATIVE TWINS: an attempt that names something the restore is not doing still wins,
	// exactly as 0.17.1 made it.

	for (const slowRead of ['eth_chainId', 'eth_accounts'] as const) {
		it(`ensureConnected('SignedIn', another account) still wins over it (slow ${slowRead})`, async () => {
			rememberSignedInAs(A);
			const release = installSlowWallet([B, A]).holdNext(slowRead);
			const {connection, snapshot} = createRestoringConnection(true);
			await vi.advanceTimersByTimeAsync(200);

			const outcome = settledOf(
				connection.ensureConnected('SignedIn', {type: 'wallet', name: WALLET_NAME, address: B}),
			);
			await vi.advanceTimersByTimeAsync(200);
			expect(outcome.done).toBe(true);
			expect(outcome.error).toBeUndefined();
			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);
			const signerOfB = snapshot().account.signer.address;
			expect(signerOfB).not.toBe(STORED_SIGNER);
			expect(signatures).toBe(1);

			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);
			expect(snapshot().account.signer.address).toBe(signerOfB);
			expect(snapshot().mechanism.address).toBe(B);
		});

		it(`connect() to another account still wins over it (slow ${slowRead})`, async () => {
			rememberSignedInAs(A);
			const release = installSlowWallet([B, A]).holdNext(slowRead);
			const {connection, snapshot} = createRestoringConnection(true);
			await vi.advanceTimersByTimeAsync(200);

			await connection.connect({type: 'wallet', name: WALLET_NAME, address: B});
			await vi.advanceTimersByTimeAsync(200);
			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);

			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(snapshot().step).toBe('SignedIn');
			expect(snapshot().account.address).toBe(B);
			expect(snapshot().mechanism.address).toBe(B);
		});
	}

	it('connect() to another wallet still wins over it', async () => {
		rememberSignedInAs(A);
		const release = installSlowWallet().holdNext('eth_accounts');
		const other = installLockableWallet({
			uuid: 'uuid-other',
			name: 'Other Wallet',
			rdns: 'com.example.other',
			accounts: [B],
		});
		try {
			const {connection, snapshot} = createRestoringConnection(true);
			await vi.advanceTimersByTimeAsync(200);

			await connection.connect({type: 'wallet', name: 'Other Wallet'});
			await vi.advanceTimersByTimeAsync(200);
			expect(snapshot().mechanism.name).toBe('Other Wallet');
			expect(snapshot().account.address).toBe(B);

			release();
			await vi.advanceTimersByTimeAsync(2000);

			expect(snapshot().mechanism.name).toBe('Other Wallet');
			expect(snapshot().account.address).toBe(B);
		} finally {
			other.uninstall();
		}
	});

	it('a disconnect made while a joined call waits still wins over the restore', async () => {
		rememberSignedInAs(A);
		const release = installSlowWallet().holdNext('eth_accounts');
		const {connection, snapshot} = createRestoringConnection(true);
		await vi.advanceTimersByTimeAsync(200);

		const outcome = settledOf(connection.connect());
		connection.disconnect();
		release();
		await vi.advanceTimersByTimeAsync(2000);

		expect(outcome.done).toBe(true);
		expect(snapshot().step).toBe('Idle');
		expect(snapshot().wallet).toBeUndefined();
		expect(localStorage.getItem('__origin_account')).toBeNull();
		expect(signatures).toBe(0);
	});
});
