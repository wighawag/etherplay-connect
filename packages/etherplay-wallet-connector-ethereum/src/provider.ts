import type {EIP1193Provider, EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {personalSign, withTimeout} from './utils.js';
import {
	AlwaysOnProviderWrapper,
	PendingRequest,
	RequestEvent,
	RequestEventHandler,
	RequestPurpose,
	TrackedRequestMethod,
	TRACKED_REQUEST_METHODS,
	TRANSACTION_METHODS,
	TransactionMethod,
	SignatureMethod,
} from '@etherplay/wallet-connector';
import {UnderlyingEthereumProvider} from './index.js';

// Type guard for transaction methods
function isTransactionMethod(method: TrackedRequestMethod): method is TransactionMethod {
	return (TRANSACTION_METHODS as readonly string[]).includes(method);
}

// Helper to create a properly typed PendingRequest
function createPendingRequest(
	id: string,
	method: TrackedRequestMethod,
	startedAt: number,
	purpose?: RequestPurpose,
): PendingRequest {
	// Spread rather than `purpose` directly, so a request without one has NO `purpose` key instead of
	// one set to `undefined`. The two are the same to `toEqual` and to `JSON.stringify`, and different
	// to `toStrictEqual` and to `'purpose' in request`, and this shape is handed to consumers whose
	// assertions we do not control.
	const withPurpose = purpose === undefined ? {} : {purpose};
	if (isTransactionMethod(method)) {
		return {id, method, kind: 'transaction', startedAt, ...withPurpose};
	}
	// TypeScript knows method is SignatureMethod here
	return {id, method: method as SignatureMethod, kind: 'signature', startedAt, ...withPurpose};
}

// Helper to check if method should be tracked
function isTrackedMethod(method: string): method is TrackedRequestMethod {
	return (TRACKED_REQUEST_METHODS as readonly string[]).includes(method);
}

const signerMethods = [
	'eth_accounts',
	'eth_sign',
	'eth_signTransaction',
	'personal_sign',
	'eth_signTypedData_v4',
	'eth_signTypedData',
];

const connectedAccountMethods = ['eth_sendTransaction'];

const walletOnlyMethods = ['eth_requestAccounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain'];

class AlwaysOnEthereumProviderWrapper implements AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
	public readonly chainId: string;
	public readonly provider: CurriedRPC<Methods>;
	private walletProvider?: CurriedRPC<Methods>;
	private jsonRPC: CurriedRPC<Methods>;
	private status: 'connected' | 'locked' | 'disconnected' = 'disconnected';

	// Request tracking fields
	private pendingRequests: Map<string, PendingRequest> = new Map();
	private requestHandlers: Set<RequestEventHandler> = new Set();
	private requestCounter = 0;

	constructor(params: {
		endpoint: string | UnderlyingEthereumProvider;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}) {
		const self = this;
		this.chainId = params.chainId;
		this.jsonRPC = createCurriedJSONRPC<Methods>(params.endpoint);

		const provider = {
			async request(req: {method: string; params?: any[]}) {
				// Check if this is a tracked method
				if (isTrackedMethod(req.method)) {
					return self.executeTrackedRequest(req, params.prioritizeWalletProvider);
				}

				// Non-tracked methods - execute directly
				return self.executeRequest(req, params.prioritizeWalletProvider);
			},
		} as unknown as EIP1193Provider;

		this.provider = createCurriedJSONRPC<Methods>(provider, {requestsPerSecond: params.requestsPerSecond});
	}

	// Event subscription
	onRequest(handler: RequestEventHandler): () => void {
		this.requestHandlers.add(handler);
		return () => {
			this.requestHandlers.delete(handler);
		};
	}

	// Get current pending requests
	getPendingRequests(): PendingRequest[] {
		return Array.from(this.pendingRequests.values());
	}

	// Emit event to all handlers
	private emitRequestEvent(event: RequestEvent): void {
		for (const handler of this.requestHandlers) {
			try {
				handler(event);
			} catch (e) {
				console.error('Request event handler error:', e);
			}
		}
	}

	// Generate unique request ID
	private generateRequestId(): string {
		return `req_${++this.requestCounter}_${Date.now()}`;
	}

	// Execute tracked request with event emission
	private executeTrackedRequest(
		req: {method: string; params?: any[]},
		prioritizeWalletProvider?: boolean,
	): Promise<any> {
		return this.announce(req.method as TrackedRequestMethod, undefined, () =>
			this.executeRequest(req, prioritizeWalletProvider),
		);
	}

	/**
	 * Run something that reaches the user's wallet, with the pending-request bookkeeping around it.
	 *
	 * Separated from HOW the request is delivered on purpose. Announcing and routing are different
	 * jobs, and `signMessage` needs the first without the second: it must be visible like every other
	 * wallet request, but it must not inherit the always-on provider's single-chain guard.
	 */
	private async announce<T>(
		method: TrackedRequestMethod,
		purpose: RequestPurpose | undefined,
		deliver: () => Promise<T>,
	): Promise<T> {
		const requestId = this.generateRequestId();
		const pendingRequest = createPendingRequest(requestId, method, Date.now(), purpose);

		// Track and emit start event
		this.pendingRequests.set(requestId, pendingRequest);
		this.emitRequestEvent({type: 'requestStart', request: pendingRequest});

		try {
			const result = await deliver();

			// Emit success event
			this.pendingRequests.delete(requestId);
			this.emitRequestEvent({
				type: 'requestEnd',
				request: pendingRequest,
				result: 'success',
			});

			return result;
		} catch (error) {
			// Determine if user rejected
			const isRejected = (error as any)?.code === 4001;

			// Emit end event
			this.pendingRequests.delete(requestId);
			this.emitRequestEvent({
				type: 'requestEnd',
				request: pendingRequest,
				result: isRejected ? 'rejected' : 'error',
				error: isRejected ? undefined : error,
			});

			throw error;
		}
	}

	/**
	 * See the interface doc on `AlwaysOnProviderWrapper.signMessage` for why this is its own surface
	 * rather than a call through `provider.request`.
	 *
	 * Delivery is deliberately identical to `EthereumWalletProvider.signMessage` — both go through
	 * `personalSign` — so routing a signature through here changes WHO CAN SEE IT and nothing else.
	 * That means it differs from the generic `executeRequest` path in BOTH of that path's guards, and
	 * both omissions are deliberate:
	 *
	 * - No CHAIN check. `personal_sign` over text is chain-independent, and a delegation names the
	 *   chain it authorises INSIDE the signed bytes, so `getDelegation` is expected to mint one for a
	 *   chain the connection is not on.
	 * - No `status === 'connected'` check. Not because the check would be wrong, but because adding it
	 *   here would be a behaviour change smuggled in with an observability fix: the calls being moved
	 *   onto this method never had one. If it turns out to be wanted, it should land as its own
	 *   change, with its own reasoning about what a caller should do when it fails.
	 *
	 * The one thing it does insist on is a registered wallet: signing has no meaningful fallback, so
	 * there is nothing sensible to do without one. That rejection happens BEFORE `announce`, so a
	 * request that never reached the wallet is never announced as pending.
	 */
	async signMessage(
		message: string,
		account: `0x${string}`,
		options?: {purpose?: RequestPurpose},
	): Promise<`0x${string}`> {
		const walletProvider = this.walletProvider;
		if (!walletProvider) {
			return Promise.reject(new Error('wallet provider is not connected'));
		}
		return this.announce('personal_sign', options?.purpose, () => personalSign(walletProvider, message, account));
	}

	// Execute request (original request routing logic)
	private async executeRequest(
		req: {method: string; params?: any[]},
		prioritizeWalletProvider?: boolean,
	): Promise<any> {
		const signingMethod =
			signerMethods.includes(req.method) ||
			connectedAccountMethods.includes(req.method) ||
			walletOnlyMethods.includes(req.method) ||
			req.method.indexOf('sign') != -1;

		if (this.walletProvider) {
			if (prioritizeWalletProvider || signingMethod) {
				if (signingMethod) {
					if (this.status !== 'connected') {
						return Promise.reject({message: 'wallet provider is not connected', code: 4001});
					}
				}

				let currentChainIdAsHex: string;
				try {
					currentChainIdAsHex = await withTimeout(
						this.walletProvider.request({
							method: 'eth_chainId',
						}),
					);
				} catch (err) {
					if (signingMethod) {
						return Promise.reject(err);
					} else {
						// we fallback on jsonRPc if error while getting  chain and not a signing method
						return this.jsonRPC.request(req as any);
					}
				}

				const currentChainId = Number(currentChainIdAsHex).toString();
				if (this.chainId !== currentChainId) {
					if (signingMethod) {
						return Promise.reject({
							message: `wallet provider is connected to a different chain, expected ${this.chainId} but got ${currentChainId}`,
							code: 4001,
						});
					} else {
						// we fallback on jsonRPc if invalid chain and not a signing method
						return this.jsonRPC.request(req as any);
					}
				}
				return this.walletProvider.request(req as any);
			}
		}

		if (signingMethod) {
			return Promise.reject(new Error('wallet provider is not connected'));
		}

		return this.jsonRPC.request(req as any);
	}

	setWalletProvider(walletProvider: CurriedRPC<Methods> | undefined) {
		this.walletProvider = walletProvider;
	}

	setWalletStatus(newStatus: 'connected' | 'locked' | 'disconnected') {
		this.status = newStatus;
	}
}

export function createProvider(params: {
	endpoint: string | UnderlyingEthereumProvider;
	chainId: string;
	prioritizeWalletProvider?: boolean;
	requestsPerSecond?: number;
}): AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
	return new AlwaysOnEthereumProviderWrapper(params);
}
