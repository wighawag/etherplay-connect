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

type WalletAnnouncementFunction = (walletInfo: WalletHandle<CurriedRPC<Methods>>) => void;
function createWalletFetcher() {
	const walletHandles: WalletHandle<CurriedRPC<Methods>>[] = [];
	const walletAnnouncementFunctions: WalletAnnouncementFunction[] = [];
	let requesting = false;

	function onWalletAnnounced(event: EIP6963AnnounceProviderEvent) {
		const {detail} = event;
		// const { info, provider } = detail;
		// const { uuid, name, icon, rdns } = info;
		// console.log('provider', provider);
		// console.log(`isDefault: ${provider === defaultProvider}`);
		// console.log('info', info);
		const walletHandle = {
			walletProvider: new EthereumWalletProvider(detail.provider),
			info: detail.info,
		};
		walletHandles.push(walletHandle);
		for (const walletAnnounced of walletAnnouncementFunctions) {
			walletAnnounced(walletHandle);
		}
	}
	function fetchWallets(walletAnnounced: WalletAnnouncementFunction) {
		walletAnnouncementFunctions.push(walletAnnounced);
		if (requesting) {
			for (const walletHandle of walletHandles) {
				walletAnnounced(walletHandle);
			}
		} else if (typeof window !== 'undefined') {
			requesting = true;
			// const defaultProvider = (window as any).ethereum;
			// console.log(defaultProvider);
			// TODO ?
			(window as any).addEventListener('eip6963:announceProvider', onWalletAnnounced);
			window.dispatchEvent(new Event('eip6963:requestProvider'));
		}
	}
	return {
		fetchWallets,
	};
}

const walletFetcher = createWalletFetcher();

export interface EIP6963AnnounceProviderEvent extends CustomEvent {
	type: 'eip6963:announceProvider';
	detail: EIP6963ProviderDetail;
}

export class EthereumWalletConnector implements WalletConnector<CurriedRPC<Methods>> {
	accountGenerator: AccountGenerator = new EthereumAccountGenerator();
	fetchWallets(walletAnnounced: (walletInfo: WalletHandle<CurriedRPC<Methods>>) => void): void {
		walletFetcher.fetchWallets(walletAnnounced);
	}

	createAlwaysOnProvider(params: {
		endpoint: string;
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
