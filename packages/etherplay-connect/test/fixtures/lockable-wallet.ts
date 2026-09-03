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
	/**
	 * Lock WITHOUT announcing it, which is what MetaMask actually does.
	 *
	 * It emits no `accountsChanged` on lock, so the only way to find out is to ask. That is why the
	 * connection polls `eth_accounts`, and this is how a test reaches that path.
	 */
	lockSilently: () => void;
	/** How many handlers the connection currently has attached, to catch watchers left behind. */
	listenerCount: (event: string) => number;
	/** Make `eth_chainId` fail, which is how an unusable wallet presents itself. */
	setChainIdFailure: (fail: boolean) => void;
	/** Give the accounts back and announce it, as the user unlocking the extension themselves does. */
	unlock: () => void;
	/** The user picks a different account in the wallet, and the wallet says so. */
	switchAccount: (account: `0x${string}`) => void;
	/**
	 * ANNOUNCE an accounts list without changing what `eth_accounts` will answer.
	 *
	 * A wallet whose announcement and whose answer disagree, which is the only way to reach the
	 * "asked, answered with something else, ask again" loop deliberately: every honest wallet makes
	 * the two agree, so an attempt started because the announcement offered the account would find
	 * it and finish. Here the attempt comes back denying what the announcement promised, which is
	 * what the retry guard has to survive.
	 */
	announceAccounts: (accounts: `0x${string}`[]) => void;
	/** Park an `eth_sendTransaction` until `releaseTransaction`, which is what waiting on a human is. */
	releaseTransaction: (hash?: string) => void;
	/** Make the password prompt fail, so a test can watch a FAILED reconnect. */
	rejectRequestAccounts: (error: unknown) => void;
	/**
	 * Never answer `eth_requestAccounts`: the wallet popup is open and the user has not decided.
	 *
	 * The only honest way to hold a connection at `WaitingForWalletConnection`, which is a state a
	 * test needs to ENTER from rather than merely pass through, and the state that makes "waiting is
	 * fine while a human is deciding" true.
	 */
	stallRequestAccounts: () => void;
	/**
	 * How the wallet answers `wallet_switchEthereumChain` / `wallet_addEthereumChain`.
	 *
	 * Both are EIP-1193 methods with an unusual contract: null means SUCCESS, and a non-null result
	 * is an error rather than a value, which is why the code under test checks the result as well as
	 * catching. A handler may return either, or throw (`{code: 4001}` is the user refusing).
	 */
	setChainHandlers: (handlers: {
		switchChain?: (chainId: string) => unknown;
		addChain?: (params: any) => unknown;
	}) => void;
	switchChainCalls: () => {chainId: string}[];
	addChainCalls: () => any[];
	/** The chain the wallet reports, as a wallet does after the user approves a switch. */
	setChainId: (chainIdAsHex: string) => void;
	/** Run while the wallet is holding a `personal_sign`, the only moment worth looking at. */
	set whileSigning(hook: (() => void | Promise<void>) | undefined);
	requestAccountsCalls: () => number;
	/** `eth_accounts` is the SILENT question; a flow that promises not to ask must not ask it either. */
	getAccountsCalls: () => number;
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
	let chainId = options?.chainId ?? '0x1';
	const switchChainCalls: {chainId: string}[] = [];
	const addChainCalls: any[] = [];
	let switchChainHandler: ((chainId: string) => unknown) | undefined;
	let addChainHandler: ((params: any) => unknown) | undefined;

	let locked = false;
	let failChainId = false;
	let requestAccountsError: unknown | undefined;
	let stallAccounts = false;
	let requestAccountsCount = 0;
	let getAccountsCount = 0;
	let whileSigning: (() => void | Promise<void>) | undefined;
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
					if (failChainId) {
						throw new Error('chain id unavailable');
					}
					return chainId;
				case 'eth_accounts':
					getAccountsCount++;
					return locked ? [] : accounts;
				case 'eth_requestAccounts':
					requestAccountsCount++;
					if (stallAccounts) {
						// Held forever, as an unanswered wallet popup is.
						return new Promise<never>(() => {});
					}
					if (requestAccountsError) {
						throw requestAccountsError;
					}
					// The extension's own password prompt: answering it unlocks the wallet.
					locked = false;
					return accounts;
				case 'personal_sign': {
					// A hook may return a promise to HOLD the wallet inside the request, which is how a
					// test gets two signature requests outstanding at the same time.
					const held = whileSigning?.();
					if (held) {
						await held;
					}
					return `0x${'ab'.repeat(65)}`;
				}
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
				case 'wallet_switchEthereumChain': {
					const requested = (params?.[0] as {chainId: string})?.chainId;
					switchChainCalls.push({chainId: requested});
					// null is SUCCESS for this method. A wallet that accepts also announces the new
					// chain, which is what actually updates the connection.
					if (!switchChainHandler) {
						chainId = requested;
						emit('chainChanged', requested);
						return null;
					}
					return switchChainHandler(requested);
				}
				case 'wallet_addEthereumChain': {
					const added = params?.[0];
					addChainCalls.push(added);
					if (!addChainHandler) {
						chainId = added?.chainId ?? chainId;
						emit('chainChanged', chainId);
						return null;
					}
					return addChainHandler(added);
				}
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
		lockSilently: () => {
			locked = true;
		},
		listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
		setChainIdFailure: (fail: boolean) => {
			failChainId = fail;
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
		announceAccounts: (announced: `0x${string}`[]) => {
			emit('accountsChanged', announced);
		},
		releaseTransaction: (hash = '0xhash') => releaseTransaction?.(hash),
		rejectRequestAccounts: (error: unknown) => {
			requestAccountsError = error;
		},
		stallRequestAccounts: () => {
			stallAccounts = true;
		},
		setChainHandlers: (handlers) => {
			switchChainHandler = handlers.switchChain;
			addChainHandler = handlers.addChain;
		},
		switchChainCalls: () => switchChainCalls,
		addChainCalls: () => addChainCalls,
		setChainId: (chainIdAsHex: string) => {
			chainId = chainIdAsHex;
			emit('chainChanged', chainIdAsHex);
		},
		requestAccountsCalls: () => requestAccountsCount,
		getAccountsCalls: () => getAccountsCount,
		set whileSigning(hook: (() => void | Promise<void>) | undefined) {
			whileSigning = hook;
		},
	};
}
