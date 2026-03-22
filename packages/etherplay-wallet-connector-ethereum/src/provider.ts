import type {EIP1193Provider, EIP1193WalletProvider, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {withTimeout} from './utils.js';
import {
	AlwaysOnProviderWrapper,
	PendingRequest,
	RequestEvent,
	RequestEventHandler,
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
function createPendingRequest(id: string, method: TrackedRequestMethod, startedAt: number): PendingRequest {
	if (isTransactionMethod(method)) {
		return {id, method, kind: 'transaction', startedAt};
	}
	// TypeScript knows method is SignatureMethod here
	return {id, method: method as SignatureMethod, kind: 'signature', startedAt};
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
	private async executeTrackedRequest(
		req: {method: string; params?: any[]},
		prioritizeWalletProvider?: boolean,
	): Promise<any> {
		const method = req.method as TrackedRequestMethod;
		const requestId = this.generateRequestId();
		const pendingRequest = createPendingRequest(requestId, method, Date.now());

		// Track and emit start event
		this.pendingRequests.set(requestId, pendingRequest);
		this.emitRequestEvent({type: 'requestStart', request: pendingRequest});

		try {
			const result = await this.executeRequest(req, prioritizeWalletProvider);

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
