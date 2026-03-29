import type {
	WalletConnector,
	ChainInfo,
	WalletProvider,
	WalletHandle,
	AlwaysOnProviderWrapper,
	AccountGenerator,
	PrivateKeyAccount,
} from '@etherplay/wallet-connector';
import type {EIP1193ChainId, EIP1193WindowWalletProvider, Methods} from 'eip-1193';
import {hashMessage} from './utils.js';
import {createProvider} from './provider.js';
import {createCurriedJSONRPC, CurriedRPC} from 'remote-procedure-call';
import {HDKey} from '@scure/bip32';
import {mnemonicToSeedSync} from '@scure/bip39';
import {bytesToHex} from '@noble/hashes/utils';
import {secp256k1} from '@noble/curves/secp256k1';
import {keccak_256} from '@noble/hashes/sha3';
import {getPublicKey} from '@noble/secp256k1';

///////////////////////////////////////////////////////////////////////////////////////////////////
// TAKEN FROM https://github.com/paulmillr/micro-eth-signer/
///////////////////////////////////////////////////////////////////////////////////////////////////
const ethHexStartRe = /^0[xX]/;
export function strip0x(hex: string): string {
	return hex.replace(ethHexStartRe, '');
}
export function add0x(hex: string): string {
	return ethHexStartRe.test(hex) ? hex : `0x${hex}`;
}

export function astr(str: unknown) {
	if (typeof str !== 'string') throw new Error('string expected');
}

const RE = /^(0[xX])?([0-9a-fA-F]{40})?$/;
export function parse(address: string) {
	astr(address);
	const res = address.match(RE) || [];
	const hasPrefix = res[1] != null;
	const data = res[2];
	if (!data) {
		const len = hasPrefix ? 42 : 40;
		throw new Error(`address must be ${len}-char hex, got ${address.length}-char ${address}`);
	}
	return {hasPrefix, data};
}

export function addChecksum(nonChecksummedAddress: string): string {
	const low = parse(nonChecksummedAddress).data.toLowerCase();
	const hash = bytesToHex(keccak_256(low));
	let checksummed = '';
	for (let i = 0; i < low.length; i++) {
		const hi = Number.parseInt(hash[i], 16);
		const li = low[i];
		checksummed += hi <= 7 ? li : li.toUpperCase(); // if char is 9-f, upcase it
	}
	return add0x(checksummed);
}

export function fromPublicKey(key: string | Uint8Array): string {
	if (!key) throw new Error('invalid public key: ' + key);
	const pub65b = secp256k1.ProjectivePoint.fromHex(key).toRawBytes(false);
	const hashed = keccak_256(pub65b.subarray(1, 65));
	return addChecksum(bytesToHex(hashed).slice(24)); // slice 24..64
}

export function fromPrivateKey(key: string | Uint8Array): string {
	if (typeof key === 'string') key = strip0x(key);
	return fromPublicKey(secp256k1.getPublicKey(key, false));
}
///////////////////////////////////////////////////////////////////////////////////////////////////

export type UnderlyingEthereumProvider = CurriedRPC<Methods>;

interface EIP6963ProviderInfo {
	uuid: string;
	name: string;
	icon: string;
	rdns: string;
}

interface EIP6963ProviderDetail {
	info: EIP6963ProviderInfo;
	provider: EIP1193WindowWalletProvider;
}

function detectWindowEthereumInfo(provider: EIP1193WindowWalletProvider): EIP6963ProviderInfo {
	const p = provider as any;

	// Check for common wallet flags
	// Order matters - more specific checks first
	let name = 'Browser Wallet';

	if (p.isMetaMask && !p.isRabby && !p.isBraveWallet) {
		name = 'MetaMask';
	} else if (p.isCoinbaseWallet) {
		name = 'Coinbase Wallet';
	} else if (p.isTrust) {
		name = 'Trust Wallet';
	} else if (p.isRabby) {
		name = 'Rabby';
	} else if (p.isBraveWallet) {
		name = 'Brave Wallet';
	} else if (p.isPhantom) {
		name = 'Phantom';
	} else if (p.isRainbow) {
		name = 'Rainbow';
	} else if (p.isTokenPocket) {
		name = 'TokenPocket';
	} else if (p.isOKExWallet || p.isOkxWallet) {
		name = 'OKX Wallet';
	} else if (p.isBitKeep) {
		name = 'BitKeep';
	} else if (p.isZerion) {
		name = 'Zerion';
	} else if (p.isFrame) {
		name = 'Frame';
	} else if (p.isTally) {
		name = 'Taho';
	} else if (p.isOneInch) {
		name = '1inch Wallet';
	} else if (p.isImToken) {
		name = 'imToken';
	} else if (p.isMathWallet) {
		name = 'MathWallet';
	} else if (p.isTokenary) {
		name = 'Tokenary';
	} else if (p.isStatus) {
		name = 'Status';
	} else if (p.isXDEFI) {
		name = 'XDEFI';
	} else if (p.isExodus) {
		name = 'Exodus';
	} else if (p.isOpera) {
		name = 'Opera Wallet';
	} else if (p.isGamestop) {
		name = 'GameStop Wallet';
	}

	return {
		uuid: 'window.ethereum',
		name,
		icon: '', // No icon available for window.ethereum
		rdns: 'window.ethereum',
	};
}

type WalletAnnouncementFunction = (walletInfo: WalletHandle<CurriedRPC<Methods>>) => void;
export type WalletFetcher = {
	fetchWallets(walletAnnounced: WalletAnnouncementFunction): void;
};
function createWalletFetcher(): WalletFetcher {
	const walletHandles: WalletHandle<CurriedRPC<Methods>>[] = [];
	const walletAnnouncementFunctions: WalletAnnouncementFunction[] = [];
	let requesting = false;
	let eip6963Received = false;
	// Track the actual window.ethereum provider reference for late EIP-6963 comparison
	let windowEthereumProviderAdded: EIP1193WindowWalletProvider | undefined;

	function announceWallet(walletHandle: WalletHandle<CurriedRPC<Methods>>) {
		walletHandles.push(walletHandle);
		for (const walletAnnounced of walletAnnouncementFunctions) {
			walletAnnounced(walletHandle);
		}
	}

	function onWalletAnnounced(event: EIP6963AnnounceProviderEvent) {
		const {detail} = event;

		// Mark that we received at least one EIP6963 announcement
		eip6963Received = true;

		// If window.ethereum was already added (late EIP-6963 arrival),
		// skip if this provider is the same object as window.ethereum
		// This handles wallets that provide the same provider object in both
		if (windowEthereumProviderAdded && detail.provider === windowEthereumProviderAdded) {
			return;
		}

		const walletHandle = {
			walletProvider: new EthereumWalletProvider(detail.provider),
			info: detail.info,
		};
		announceWallet(walletHandle);
	}

	function addWindowEthereumIfNeeded() {
		if (windowEthereumProviderAdded) return;

		// If any EIP6963 providers were announced, skip window.ethereum entirely
		// This avoids duplicates since wallets like Rabby provide different provider objects
		// in EIP6963 vs window.ethereum, making equality comparison unreliable
		if (eip6963Received) return;

		const windowEthereumProvider = (window as any).ethereum as EIP1193WindowWalletProvider | undefined;
		if (!windowEthereumProvider) return;

		// Store the reference for late EIP-6963 comparison
		windowEthereumProviderAdded = windowEthereumProvider;

		// Add window.ethereum with fallback info (for mobile wallet browsers without EIP6963)
		const walletHandle = {
			walletProvider: new EthereumWalletProvider(windowEthereumProvider),
			info: detectWindowEthereumInfo(windowEthereumProvider),
		};
		announceWallet(walletHandle);
	}

	function fetchWallets(walletAnnounced: WalletAnnouncementFunction) {
		walletAnnouncementFunctions.push(walletAnnounced);
		if (requesting) {
			for (const walletHandle of walletHandles) {
				walletAnnounced(walletHandle);
			}
		} else if (typeof window !== 'undefined') {
			requesting = true;

			// First listen for EIP6963 announcements (they have proper name/icon info)
			(window as any).addEventListener('eip6963:announceProvider', onWalletAnnounced);
			window.dispatchEvent(new Event('eip6963:requestProvider'));

			// After a short delay, add window.ethereum only if no EIP6963 providers were announced
			// This handles mobile wallet browsers that don't support EIP6963
			// we also stop listenning for more
			setTimeout(() => {
				(window as any).removeListener('eip6963:announceProvider', onWalletAnnounced);
				addWindowEthereumIfNeeded();
			}, 100);
		}
	}
	return {
		fetchWallets,
	};
}

export interface EIP6963AnnounceProviderEvent extends CustomEvent {
	type: 'eip6963:announceProvider';
	detail: EIP6963ProviderDetail;
}

export class EthereumWalletConnector implements WalletConnector<CurriedRPC<Methods>> {
	accountGenerator: AccountGenerator = new EthereumAccountGenerator();
	walletFetcher: WalletFetcher;

	constructor() {
		this.walletFetcher = createWalletFetcher();
	}

	fetchWallets(walletAnnounced: (walletInfo: WalletHandle<CurriedRPC<Methods>>) => void): void {
		this.walletFetcher.fetchWallets(walletAnnounced);
	}

	createAlwaysOnProvider(params: {
		endpoint: string | UnderlyingEthereumProvider;
		chainId: string;
		prioritizeWalletProvider?: boolean;
		requestsPerSecond?: number;
	}): AlwaysOnProviderWrapper<CurriedRPC<Methods>> {
		return createProvider(params);
	}
}

function toHex(arr: Uint8Array): `0x${string}` {
	let str = `0x`;
	for (const element of arr) {
		str += element.toString(16).padStart(2, '0');
	}
	return str as `0x${string}`;
}

export function concatUint8Arrays(values: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const arr of values) {
		length += arr.length;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const arr of values) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

const EIP191MessagePrefix = '\x19Ethereum Signed Message:\n';
const encoder = new TextEncoder();

export function hashTextMessage(str: string): string {
	const bytes = encoder.encode(str);
	const prefixBytes = encoder.encode(`${EIP191MessagePrefix}${bytes.length}`);
	const fullBytes = concatUint8Arrays([prefixBytes, bytes]);
	return bytesToHex(keccak_256(fullBytes));
}

export function fromMnemonicToHDKey(mnemonic: string, index: number): HDKey {
	const seed = mnemonicToSeedSync(mnemonic);
	const hd = HDKey.fromMasterSeed(seed);
	return hd.derive(`m/44'/60'/0'/0/${index}`);
}

export class EthereumAccountGenerator implements AccountGenerator {
	type = 'ethereum';
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount {
		const hdkey = fromMnemonicToHDKey(mnemonic, index);
		if (!hdkey.privateKey) {
			throw new Error(`invalid key`);
		}
		return {
			address: fromPrivateKey(hdkey.privateKey).toLowerCase() as `0x${string}`,
			privateKey: `0x${bytesToHex(hdkey.privateKey)}` as `0x${string}`,
			publicKey: toHex(getPublicKey(hdkey.privateKey)),
		};
	}
	async signTextMessage(message: string, privateKey: `0x${string}`): Promise<`0x${string}`> {
		const hash = hashTextMessage(message);
		const signature = secp256k1.sign(hash, privateKey.slice(2));
		const r = signature.r;
		const s = signature.s;
		const v = signature.recovery ? 28n : 27n;
		const yParity = signature.recovery;
		let postfix = '';
		if (v === 27n || yParity === 0) {
			postfix = '1b';
		} else if (v === 28n || yParity === 1) {
			postfix = '1c';
		} else {
			throw new Error('Invalid v value');
		}
		return `0x${new secp256k1.Signature(r, s).toCompactHex()}${postfix}`;
	}
}

export class EthereumWalletProvider implements WalletProvider<CurriedRPC<Methods>> {
	public readonly underlyingProvider: CurriedRPC<Methods>;
	constructor(protected windowProvider: EIP1193WindowWalletProvider) {
		this.underlyingProvider = createCurriedJSONRPC<Methods>(windowProvider as any);
	}
	async signMessage(message: string, account: `0x${string}`): Promise<`0x${string}`> {
		return this.underlyingProvider.request({
			method: 'personal_sign',
			params: [hashMessage(message), account],
		}) as Promise<`0x${string}`>;
	}

	async getChainId(): Promise<`0x${string}`> {
		return this.underlyingProvider.request({
			method: 'eth_chainId',
		});
	}

	async getAccounts(): Promise<`0x${string}`[]> {
		return this.underlyingProvider.request({
			method: 'eth_accounts',
		});
	}
	async requestAccounts(): Promise<`0x${string}`[]> {
		return this.underlyingProvider.request({
			method: 'eth_requestAccounts',
		});
	}

	listenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		this.windowProvider.on('accountsChanged', handler);
	}
	stopListenForAccountsChanged(handler: (accounts: `0x${string}`[]) => void) {
		this.windowProvider.removeListener('accountsChanged', handler);
	}
	listenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		this.windowProvider.on('chainChanged', handler);
	}
	stopListenForChainChanged(handler: (chainId: `0x${string}`) => void) {
		this.windowProvider.removeListener('chainChanged', handler);
	}
	async switchChain(chainId: string): Promise<null | any> {
		const result = await this.underlyingProvider.request({
			method: 'wallet_switchEthereumChain',
			params: [
				{
					chainId: ('0x' + parseInt(chainId).toString(16)) as EIP1193ChainId,
				},
			],
		});
		return result;
	}
	async addChain(chainInfo: ChainInfo): Promise<null | any> {
		const result = await this.underlyingProvider.request({
			method: 'wallet_addEthereumChain',
			params: [
				{
					chainId: chainInfo.chainId,
					rpcUrls: chainInfo.rpcUrls,
					chainName: chainInfo.chainName,
					blockExplorerUrls: chainInfo.blockExplorerUrls,
					iconUrls: chainInfo.iconUrls,
					nativeCurrency: chainInfo.nativeCurrency,
				},
			],
		});
		return result;
	}
}
