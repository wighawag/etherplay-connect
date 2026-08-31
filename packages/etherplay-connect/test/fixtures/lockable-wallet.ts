// A test wallet that can be LOCKED while it is still holding a request.
//
// That combination is the whole point, and it is why this fixture exists rather than another
// inline `installWallet`. The bugs in this area all live in the window where the user's wallet is
// holding something AND the connection flow is rebuilding (or tearing down) the state on top of
// it, so a fixture that cannot be locked mid-request cannot reach them. The consumer that found
// them (jolly-roger, `web/e2e/fixtures/stalling-wallet.ts`) had to build the same thing.
//
// Two properties are load-bearing and easy to get wrong:
//
// 1. `on`/`removeListener` are a REAL registry. A provider whose listeners are no-ops cannot be
//    driven through a wallet-state rebuild at all: `accountsChanged` never arrives, the store
//    never reaches `status: 'locked'`, and every test written against it silently exercises the
//    happy path. That is a large part of why this class of bug went unnoticed.
// 2. Locking does NOT drop what is already parked. A real wallet holding a transaction still holds
//    it while the screen is locked; the user comes back to the same prompt. A fixture that cleared
//    it on lock would make the erasure bug untestable by hiding it behind an honest empty list.
//
// `eth_requestAccounts` succeeds and clears the locked flag, which models the extension's own
// password prompt. It is the only way a test can drive a reconnect past the lock, so a wallet that
// refused it could not test the SUCCESSFUL reconnect at all. `rejectRequestAccounts` covers the
// failed one.

type Handler = (payload: any) => void;

export type LockableWallet = {
	uninstall: () => void;
	/** Answer no accounts and announce it, exactly as a wallet does when the user locks it. */
	lock: () => void;
	/** Give the accounts back and announce it, as the user unlocking the extension themselves does. */
	unlock: () => void;
	/** The user picks a different account in the wallet, and the wallet says so. */
	switchAccount: (account: `0x${string}`) => void;
	/** Park an `eth_sendTransaction` until `releaseTransaction`, which is what waiting on a human is. */
	releaseTransaction: (hash?: string) => void;
	/** Make the password prompt fail, so a test can watch a FAILED reconnect. */
	rejectRequestAccounts: (error: unknown) => void;
	/** Run while the wallet is holding a `personal_sign`, the only moment worth looking at. */
	set whileSigning(hook: (() => void) | undefined);
	requestAccountsCalls: () => number;
	info: {uuid: string; name: string; icon: string; rdns: string};
};

export function installLockableWallet(options?: {
	uuid?: string;
	name?: string;
	rdns?: string;
	accounts?: `0x${string}`[];
	chainId?: string;
}): LockableWallet {
	const info = {
		uuid: options?.uuid ?? 'uuid-lockable-wallet',
		name: options?.name ?? 'Lockable Wallet',
		icon: '',
		rdns: options?.rdns ?? 'com.example.lockable',
	};
	let accounts = options?.accounts ?? ['0x1111111111111111111111111111111111111111'];
	const chainId = options?.chainId ?? '0x1';

	let locked = false;
	let requestAccountsError: unknown | undefined;
	let requestAccountsCount = 0;
	let whileSigning: (() => void) | undefined;
	let releaseTransaction: ((hash: string) => void) | undefined;

	const listeners = new Map<string, Set<Handler>>();
	const emit = (event: string, payload: any) => {
		for (const handler of listeners.get(event) ?? []) {
			handler(payload);
		}
	};

	const provider = {
		request: async ({method, params}: {method: string; params?: any[]}) => {
			switch (method) {
				case 'eth_chainId':
					return chainId;
				case 'eth_accounts':
					return locked ? [] : accounts;
				case 'eth_requestAccounts':
					requestAccountsCount++;
					if (requestAccountsError) {
						throw requestAccountsError;
					}
					// The extension's own password prompt: answering it unlocks the wallet.
					locked = false;
					return accounts;
				case 'personal_sign':
					whileSigning?.();
					return `0x${'ab'.repeat(65)}`;
				case 'eth_sendTransaction':
					// Held until the test releases it. Nothing about locking touches this promise,
					// because nothing about locking touches a real wallet's parked prompt.
					return new Promise<string>((resolve) => {
						releaseTransaction = resolve;
					});
				case 'eth_blockNumber':
					return '0x100';
				case 'eth_call':
					return '0x';
				default:
					throw new Error(`unexpected method ${method}`);
			}
		},
		on: (event: string, handler: Handler) => {
			const set = listeners.get(event) ?? new Set<Handler>();
			set.add(handler);
			listeners.set(event, set);
		},
		removeListener: (event: string, handler: Handler) => {
			listeners.get(event)?.delete(handler);
		},
	};

	const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: {info, provider}}));
	window.addEventListener('eip6963:requestProvider', announce);

	return {
		info,
		uninstall: () => window.removeEventListener('eip6963:requestProvider', announce),
		lock: () => {
			locked = true;
			emit('accountsChanged', []);
		},
		unlock: () => {
			locked = false;
			emit('accountsChanged', accounts);
		},
		switchAccount: (account: `0x${string}`) => {
			accounts = [account];
			locked = false;
			emit('accountsChanged', accounts);
		},
		releaseTransaction: (hash = '0xhash') => releaseTransaction?.(hash),
		rejectRequestAccounts: (error: unknown) => {
			requestAccountsError = error;
		},
		requestAccountsCalls: () => requestAccountsCount,
		set whileSigning(hook: (() => void) | undefined) {
			whileSigning = hook;
		},
	};
}
