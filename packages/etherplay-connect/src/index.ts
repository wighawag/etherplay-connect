import type {AlchemyMechanism, OriginAccount} from '@etherplay/alchemy';
import {writable} from 'svelte/store';
import {createPopupLauncher, type PopupPromise} from './popup.js';
import type {EIP1193ChainId, EIP1193WindowWalletProvider} from 'eip-1193';
import {
	fromEntropyKeyToMnemonic,
	fromMnemonicToFirstAccount,
	fromSignatureToKey,
	originKeyMessage,
	originPublicKeyPublicationMessage,
} from '@etherplay/alchemy';
import {hashMessage, withTimeout} from './utils.js';
import {createProvider} from './provider.js';

export {fromEntropyKeyToMnemonic, originPublicKeyPublicationMessage, originKeyMessage};
export type {OriginAccount};

export type PopupSettings = {
	walletHost: string;
	mechanism: AlchemyMechanism;
	// extraParams?: Record<string, string>;
};

export type WalletMechanism<WalletName extends string | undefined, Address extends `0x${string}` | undefined> = {
	type: 'wallet';
} & (WalletName extends undefined ? {name?: undefined} : {name: WalletName}) &
	(Address extends undefined ? {address?: undefined} : {address: Address});

export type Mechanism = AlchemyMechanism | WalletMechanism<string | undefined, `0x${string}` | undefined>;

export type FullfilledMechanism = AlchemyMechanism | WalletMechanism<string, `0x${string}`>;

export type WalletState = {
	provider: EIP1193WindowWalletProvider;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`;
	chainId: string;
	invalidChainId: boolean;
	switchingChain: 'addingChain' | 'switchingChain' | false;
} & ({status: 'connected'} | {status: 'locked'; unlocking: boolean} | {status: 'disconnected'; connecting: boolean});

type WalletConnected = {
	step: 'WaitingForSignature';
	mechanism: WalletMechanism<string, `0x${string}`>;
	wallet: WalletState;
};

type SignedIn =
	| {
			step: 'SignedIn';
			mechanism: AlchemyMechanism;
			account: OriginAccount;
			wallet: undefined;
	  }
	| {
			step: 'SignedIn';
			mechanism: WalletMechanism<string, `0x${string}`>;
			account: OriginAccount;
			wallet: WalletState;
	  };

export type Connection = {
	// The connection can have an error in every state.
	// a banner or other mechanism to show error should be used.
	// error should be dismissable
	error?: {message: string; cause?: any};
	// wallets represent the web3 wallet installed on the user browser
	wallets: EIP6963ProviderDetail[];
} & ( // loading can be true initially as the system will try to auto-login and fetch installed web3 wallet // Start in Idle
	| {
			step: 'Idle';
			loading: boolean;
			wallet: undefined;
	  }
	// It can then end up in MechanismToChoose if no specific connection mechanism was chosen upon clicking "connect"
	| {
			step: 'MechanismToChoose';
			wallet: undefined;
	  }
	// if a social/email login mechanism was chosen, a popup will be launched
	// popupClosed can be true and this means the popup has been closed and the user has to cancel the process to continue further
	| {
			step: 'PopupLaunched';
			wallet: undefined;
			popupClosed: boolean;
			mechanism: AlchemyMechanism;
	  }
	// If the user has chosen to use web3-wallet there might be multi-choice for it
	| {
			step: 'WalletToChoose';
			wallet: undefined;
			mechanism: WalletMechanism<undefined, undefined>;
	  }
	// Once a user has chosen a wallet, the system will try to connect to it
	| {
			step: 'WaitingForWalletConnection';
			wallet: undefined;
			mechanism: WalletMechanism<string, undefined>;
	  }
	// Once the wallet is connected, if multiple account are connected to the site
	// the user can choose which one to connect to
	| {
			step: 'ChooseWalletAccount';
			mechanism: WalletMechanism<string, undefined>;
			wallet: WalletState;
	  }
	// Once the wallet is connected, the system will need a signature
	// this state represent the fact and require another user interaction to request the signature
	| {
			step: 'WalletConnected';
			mechanism: WalletMechanism<string, `0x${string}`>;
			wallet: WalletState;
	  }
	// This state is triggered once the signature is requested, the user will have to confirm with its wallet
	| WalletConnected
	// Finally the user is fully signed in
	// wallet?.accountChanged if set, represent the fact that the user has changed its web3-wallet accounnt.
	// wallet?.invalidChainId if set, represent the fact that the wallet is connected to a different chain.
	// wallet?.switchingChain if set, represent the fact that the user is currently switching chain.
	// a notification could be shown to the user so that he can switch the app to use that other account.
	| SignedIn
);

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

export interface EIP6963AnnounceProviderEvent extends CustomEvent {
	type: 'eip6963:announceProvider';
	detail: EIP6963ProviderDetail;
}

const storageKeyAccount = '__origin_account';
const storageKeyLastWallet = '__last_wallet';
export function createConnection(settings: {
	walletHost: string;
	autoConnect?: boolean;
	autoConnectWallet?: boolean;
	requestSignatureAutomaticallyIfPossible?: boolean;
	alwaysUseCurrentAccount?: boolean;
	node: {url: string; chainId: string; prioritizeWalletProvider?: boolean; requestsPerSecond?: number};
}) {
	const alwaysOnChainId = settings.node.chainId;
	const alwaysOnProvider = createProvider({
		endpoint: settings.node.url,
		chainId: settings.node.chainId,
		prioritizeWalletProvider: settings.node.prioritizeWalletProvider,
		requestsPerSecond: settings.node.requestsPerSecond,
	});
	let autoConnect = true;
	if (typeof settings.autoConnect !== 'undefined') {
		autoConnect = settings.autoConnect;
	}
	let autoConnectWallet = true;
	if (typeof settings.autoConnectWallet !== 'undefined') {
		autoConnectWallet = settings.autoConnectWallet;
	}
	const requestSignatureAutomaticallyIfPossible = settings.requestSignatureAutomaticallyIfPossible || false;

	let $connection: Connection = {step: 'Idle', loading: true, wallet: undefined, wallets: []};
	const _store = writable<Connection>($connection);
	function set(connection: Connection) {
		$connection = connection;
		_store.set($connection);
		return $connection;
	}
	function setError(error: {message: string; cause?: any}) {
		if ($connection) {
			set({
				...$connection,
				error,
			});
		} else {
			throw new Error(`no connection`);
		}
	}

	let _wallet: {provider: EIP1193WindowWalletProvider; chainId: string} | undefined;

	let popup: PopupPromise<OriginAccount> | undefined;

	function fetchWallets() {
		if (typeof window !== 'undefined') {
			// const defaultProvider = (window as any).ethereum;
			// console.log(defaultProvider);
			// TODO ?
			(window as any).addEventListener('eip6963:announceProvider', (event: EIP6963AnnounceProviderEvent) => {
				const {detail} = event;
				// const { info, provider } = detail;
				// const { uuid, name, icon, rdns } = info;
				// console.log('provider', provider);
				// console.log(`isDefault: ${provider === defaultProvider}`);
				// console.log('info', info);
				const existingWallets = $connection.wallets;
				existingWallets.push(detail);

				set({
					...$connection,
					wallets: existingWallets,
				});
			});
			window.dispatchEvent(new Event('eip6963:requestProvider'));
		}
	}

	function waitForWallet(name: string): Promise<EIP6963ProviderDetail> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				clearInterval(interval);
				reject('timeout');
			}, 1000);
			const interval = setInterval(() => {
				const wallet = $connection.wallets.find((v) => v.info.name == name);
				if (wallet) {
					clearTimeout(timeout);
					clearInterval(interval);
					resolve(wallet);
				}
			}, 100);
		});
	}

	if (autoConnect) {
		if (typeof window !== 'undefined') {
			// set({step: 'Idle', loading: true, wallets: $connection.wallets});
			try {
				const existingAccount = getOriginAccount();
				if (existingAccount) {
					if (existingAccount.signer) {
						const mechanismUsed = existingAccount.mechanismUsed as
							| AlchemyMechanism
							| WalletMechanism<string, `0x${string}`>;
						if (mechanismUsed.type == 'wallet') {
							const walletMechanism = mechanismUsed as WalletMechanism<string, `0x${string}`>;
							waitForWallet(walletMechanism.name)
								.then(async (walletDetails: EIP6963ProviderDetail) => {
									const walletProvider = walletDetails.provider;
									const chainIdAsHex = await withTimeout(walletProvider.request({method: 'eth_chainId'}));
									const chainId = Number(chainIdAsHex).toString();
									_wallet = {provider: walletProvider, chainId};
									alwaysOnProvider.setWalletProvider(walletProvider);
									watchForChainIdChange(_wallet.provider);
									let accounts: `0x${string}`[] = [];
									// try {
									accounts = await withTimeout(walletProvider.request({method: 'eth_accounts'}));
									accounts = accounts.map((v) => v.toLowerCase() as `0x${string}`);
									// } catch {}
									// // TODO try catch ? and use logic of onAccountChanged
									set({
										step: 'SignedIn',
										account: existingAccount,
										mechanism: walletMechanism,
										wallets: $connection.wallets,
										wallet: {
											provider: walletProvider,
											accounts,
											status: 'connected',
											accountChanged: undefined,
											chainId,
											invalidChainId: alwaysOnChainId != chainId,
											switchingChain: false,
										},
									});
									alwaysOnProvider.setWalletStatus('connected');
									// TODO use the same logic before hand
									onAccountChanged(accounts);
									watchForAccountChange(walletProvider);
								})
								.catch((err) => {
									set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
								});
						} else {
							set({
								step: 'SignedIn',
								account: existingAccount,
								mechanism: mechanismUsed,
								wallets: $connection.wallets,
								wallet: undefined,
							});
						}
					} else {
						set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
					}
				} else {
					if (autoConnectWallet) {
						const lastWallet = getLastWallet();
						if (lastWallet) {
							waitForWallet(lastWallet.name)
								.then(async (walletDetails: EIP6963ProviderDetail) => {
									const walletProvider = walletDetails.provider;
									const chainIdAsHex = await withTimeout(walletProvider.request({method: 'eth_chainId'}));
									const chainId = Number(chainIdAsHex).toString();
									_wallet = {provider: walletProvider, chainId};
									alwaysOnProvider.setWalletProvider(walletProvider);
									watchForChainIdChange(_wallet.provider);

									let accounts: `0x${string}`[] = [];
									// try {
									accounts = await withTimeout(walletProvider.request({method: 'eth_accounts'}));
									accounts = accounts.map((v) => v.toLowerCase() as `0x${string}`);
									// } catch {}
									// // TODO try catch ? and use logic of onAccountChanged
									set({
										step: 'WalletConnected',
										mechanism: lastWallet,
										wallets: $connection.wallets,
										wallet: {
											provider: walletProvider,
											accounts,
											status: 'connected',
											accountChanged: undefined,
											chainId,
											invalidChainId: alwaysOnChainId != chainId,
											switchingChain: false,
										},
									});
									alwaysOnProvider.setWalletStatus('connected');
									// TODO use the same logic before hand
									onAccountChanged(accounts);
									watchForAccountChange(walletProvider);
								})
								.catch((err) => {
									set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
								});
						} else {
							set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
						}
					} else {
						set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
					}
				}
			} catch {
				set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
			}
		}
	} else {
		set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
	}
	fetchWallets();

	function getOriginAccount(): OriginAccount | undefined {
		const fromStorage = localStorage.getItem(storageKeyAccount);
		if (fromStorage) {
			return JSON.parse(fromStorage) as OriginAccount;
		}
	}
	function saveOriginAccount(account: OriginAccount) {
		const accountSTR = JSON.stringify(account);
		sessionStorage.setItem(storageKeyAccount, accountSTR);
		localStorage.setItem(storageKeyAccount, accountSTR);
	}
	function deleteOriginAccount() {
		sessionStorage.removeItem(storageKeyAccount);
		localStorage.removeItem(storageKeyAccount);
	}

	function getLastWallet(): WalletMechanism<string, `0x${string}`> | undefined {
		const fromStorage = localStorage.getItem(storageKeyLastWallet);
		if (fromStorage) {
			return JSON.parse(fromStorage) as WalletMechanism<string, `0x${string}`>;
		}
	}
	function saveLastWallet(wallet: WalletMechanism<string, `0x${string}`>) {
		const lastWalletSTR = JSON.stringify(wallet);
		sessionStorage.setItem(storageKeyLastWallet, lastWalletSTR);
		localStorage.setItem(storageKeyLastWallet, lastWalletSTR);
	}
	function deleteLastWallet() {
		sessionStorage.removeItem(storageKeyLastWallet);
		localStorage.removeItem(storageKeyLastWallet);
	}

	let signaturePending: {reject: (error: unknown) => void; id: number} | undefined = undefined;
	let signatureCounter = 0;
	function _requestSignature(provider: EIP1193WindowWalletProvider, msg: `0x${string}`, address: `0x${string}`) {
		const id = ++signatureCounter;
		if (signaturePending) {
			const tmp = signaturePending;
			signaturePending = undefined;
			tmp.reject(new Error('signature request replaced', {cause: {code: 111111}}));
		}
		return new Promise<`0x${string}`>((resolve, reject) => {
			signaturePending = {reject, id};

			// console.log(`check for timeout...`);
			// this step ensure timeout
			// await withTimeout(
			// 	provider.request({
			// 		method: 'eth_chainId',
			// 	}),
			// );
			// await withTimeout(
			// 	provider.request({
			// 		method: 'eth_accounts',
			// 	}),
			// );
			provider
				.request({
					method: 'personal_sign',
					params: [msg, address],
				})
				.then((signature) => {
					if (signaturePending?.id === id) {
						signaturePending = undefined;
						resolve(signature);
					}
				})
				.catch((err) => {
					if (signaturePending?.id === id) {
						signaturePending = undefined;
						reject(err);
					}
				});
		});
	}

	async function requestSignature() {
		if ($connection.step !== 'WalletConnected' && $connection.step !== 'WaitingForSignature') {
			throw new Error(`invalid step: ${$connection.step}, needs to be WalletConnected`);
		}

		const provider = $connection.wallet.provider;
		const message = originKeyMessage(origin);
		const msg = hashMessage(message);

		set({
			...$connection,
			step: 'WaitingForSignature',
		});

		let signature: `0x${string}`;
		try {
			signature = await _requestSignature(provider, msg, $connection.mechanism.address);
		} catch (err) {
			console.error(err);
			if ((err as any)?.cause?.code === 111111) {
				// We ignore replaced signature request
				return;
			}
			// TODO handle rejection (code: 4001 ?)
			set({
				...$connection,
				step: 'WalletConnected',
				mechanism: {
					type: 'wallet',
					name: $connection.mechanism.name,
					address: $connection.mechanism.address,
				},
				error: {message: 'failed to sign message', cause: err},
			});
			return;
		}

		const originKey = fromSignatureToKey(signature);
		const originMnemonic = fromEntropyKeyToMnemonic(originKey);
		const originAccount = fromMnemonicToFirstAccount(originMnemonic);

		const account = {
			address: $connection.mechanism.address as `0x${string}`,
			signer: {
				origin,
				address: originAccount.address,
				publicKey: originAccount.publicKey,
				privateKey: originAccount.privateKey,
				mnemonicKey: originKey,
			},
			metadata: {},
			mechanismUsed: $connection.mechanism,
			savedPublicKeyPublicationSignature: undefined,
		};
		set({
			...$connection,
			step: 'SignedIn',
			account,
			wallet: $connection.wallet,
		});
		if (remember) {
			saveOriginAccount(account);
		}
	}

	function connectToAddress(
		address: `0x${string}`,
		options?: {requireUserConfirmationBeforeSignatureRequest: boolean},
	) {
		if ($connection.wallet) {
			connect(
				{
					type: 'wallet',
					address,
					name: $connection.mechanism.name,
				},
				{
					requireUserConfirmationBeforeSignatureRequest: options?.requireUserConfirmationBeforeSignatureRequest,
				},
			);
		} else {
			throw new Error(`need to be using a wallet`);
		}
	}

	function onChainChanged(chainIdAsHex: `0x${string}`) {
		const chainId = Number(chainIdAsHex).toString();
		if (_wallet) {
			_wallet.chainId = chainId;
		}
		if ($connection.wallet && $connection.wallet.chainId != chainId) {
			set({
				...$connection,
				wallet: {
					...$connection.wallet,
					chainId,
					invalidChainId: alwaysOnChainId != chainId,
				},
			});
		}
	}

	function onAccountChanged(accounts: `0x${string}`[]) {
		// TODO lastAccount
		// console.log('account changed', accounts);
		const accountsFormated = accounts.map((a) => a.toLowerCase()) as `0x${string}`[];

		if ($connection.wallet) {
			const locked = accountsFormated.length == 0;
			const addressSignedIn = $connection.mechanism.address;

			if (locked) {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						status: 'locked',
						unlocking: false,
					},
				});
				alwaysOnProvider.setWalletStatus('locked');
			} else {
				const disconnected = accountsFormated.find((v) => v == addressSignedIn) ? false : true;

				if (disconnected) {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							status: 'disconnected',
							connecting: false,
						},
					});
					alwaysOnProvider.setWalletStatus('disconnected');
				} else {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							status: 'connected',
						},
					});
					alwaysOnProvider.setWalletStatus('connected');
				}
			}

			if (accountsFormated.length > 0 && accountsFormated[0] != $connection.mechanism.address) {
				if ($connection.wallet && settings?.alwaysUseCurrentAccount) {
					connectToAddress(accountsFormated[0]);
				} else {
					set({
						...$connection,
						wallet: {
							...$connection.wallet,
							accountChanged: accountsFormated[0],
							accounts: accountsFormated,
						},
					});
				}
			} else {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						accountChanged: undefined,
						accounts: accountsFormated,
					},
				});
			}
		}
	}

	// TODO lastAccounts
	let lockCheckInterval: number | undefined;
	async function checkLockStatus() {
		try {
			const provider = $connection.wallet?.provider;
			if (provider) {
				let accounts = await withTimeout(provider.request({method: 'eth_accounts'}));
				if (accounts.length == 0) {
					onAccountChanged(accounts);
				}
			}
		} catch {}
	}
	function watchForAccountChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.on('accountsChanged', onAccountChanged);
		// we also poll accounts for checking lock status as Metamask does not notify it
		if (lockCheckInterval) {
			clearInterval(lockCheckInterval);
			lockCheckInterval = undefined;
		}
		lockCheckInterval = setInterval(checkLockStatus, 1000);
	}
	function stopWatchingForAccountChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.removeListener('accountsChanged', onAccountChanged);
		if (lockCheckInterval) {
			clearInterval(lockCheckInterval);
			lockCheckInterval = undefined;
		}
	}

	function watchForChainIdChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.on('chainChanged', onChainChanged);
	}
	function stopWatchingForChainIdChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.removeListener('chainChanged', onChainChanged);
	}

	type ConnectionOptions = {
		requireUserConfirmationBeforeSignatureRequest?: boolean;
		doNotStoreLocally?: boolean;
		requestSignatureRightAway?: boolean;
	};

	let remember: boolean = false;
	async function connect(mechanism?: Mechanism, options?: ConnectionOptions) {
		remember = !(options?.doNotStoreLocally || false);
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const specificAddress = mechanism.address;
				const walletName =
					mechanism.name || ($connection.wallets.length == 1 ? $connection.wallets[0].info.name : undefined);
				if (walletName) {
					const wallet = $connection.wallets.find((v) => v.info.name == walletName || v.info.uuid == walletName);
					if (wallet) {
						if (_wallet) {
							alwaysOnProvider.setWalletProvider(undefined);
							stopWatchingForAccountChange(_wallet.provider);
							stopWatchingForChainIdChange(_wallet.provider);
						}

						const mechanismToSave: WalletMechanism<string, undefined> = {
							type: 'wallet',
							name: walletName,
						};

						set({
							step: 'WaitingForWalletConnection', // TODO FetchingAccounts
							mechanism: mechanismToSave,
							wallets: $connection.wallets,
							wallet: undefined,
						});
						try {
							const provider = wallet.provider;
							const chainIdAsHex = await withTimeout(provider.request({method: 'eth_chainId'}));
							const chainId = Number(chainIdAsHex).toString();
							_wallet = {
								chainId,
								provider,
							};
							alwaysOnProvider.setWalletProvider(_wallet.provider);
							watchForChainIdChange(_wallet.provider);
							let accounts = await withTimeout(provider.request({method: 'eth_accounts'}));
							accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
							if (accounts.length === 0) {
								set({
									step: 'WaitingForWalletConnection', // TODO add another step to unlock ?
									mechanism: mechanismToSave,
									wallets: $connection.wallets,
									wallet: undefined,
								});
								accounts = await provider.request({method: 'eth_requestAccounts'});
								accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
								if (accounts.length > 0) {
									const nextStep =
										!settings?.alwaysUseCurrentAccount && !specificAddress && accounts.length > 1
											? 'ChooseWalletAccount'
											: 'WalletConnected';
									let account = accounts[0];
									if (specificAddress) {
										if (accounts.find((v) => v === specificAddress)) {
											account = specificAddress;
										} else {
											// TODO error
											throw new Error(`could not find address ${specificAddress}`);
										}
									}

									const newState: Connection =
										nextStep === 'ChooseWalletAccount'
											? {
													step: nextStep,
													mechanism: mechanismToSave,
													wallets: $connection.wallets,

													wallet: {
														provider: _wallet.provider,
														accounts,
														status: 'connected',
														accountChanged: undefined,
														chainId,
														invalidChainId: alwaysOnChainId != chainId,
														switchingChain: false,
													},
												}
											: {
													step: nextStep,
													mechanism: {
														...mechanismToSave,
														address: account,
													},
													wallets: $connection.wallets,
													wallet: {
														provider: _wallet.provider,
														accounts,
														status: 'connected',
														accountChanged: undefined,
														chainId,
														invalidChainId: alwaysOnChainId != chainId,
														switchingChain: false,
													},
												};
									if (
										newState.step === 'WalletConnected' &&
										(requestSignatureAutomaticallyIfPossible || options?.requestSignatureRightAway) &&
										!options?.requireUserConfirmationBeforeSignatureRequest
									) {
										watchForAccountChange(_wallet.provider);

										set(newState);
										alwaysOnProvider.setWalletStatus('connected');
										saveLastWallet(newState.mechanism);
										await requestSignature();
									} else {
										set(newState);
										alwaysOnProvider.setWalletStatus('connected');
										if (newState.step === 'WalletConnected') {
											saveLastWallet(newState.mechanism);
										}

										watchForAccountChange(_wallet.provider);
									}
								} else {
									set({
										step: 'MechanismToChoose',
										wallets: $connection.wallets,
										wallet: undefined,
										error: {message: 'could not get any accounts'},
									});
								}
							} else {
								let account = accounts[0];
								if (specificAddress) {
									if (accounts.find((v) => v === specificAddress)) {
										account = specificAddress;
									} else {
										// TODO error
										throw new Error(`could not find address ${specificAddress}`);
									}
								}
								const nextStep =
									!settings?.alwaysUseCurrentAccount && !specificAddress && accounts.length > 1
										? 'ChooseWalletAccount'
										: 'WalletConnected';
								const newState: Connection =
									nextStep === 'ChooseWalletAccount'
										? {
												step: nextStep,
												mechanism: mechanismToSave,
												wallets: $connection.wallets,
												wallet: {
													provider: _wallet.provider,
													accounts,
													status: 'connected',
													accountChanged: undefined,
													chainId,
													invalidChainId: alwaysOnChainId != chainId,
													switchingChain: false,
												},
											}
										: {
												step: nextStep,
												mechanism: {
													...mechanismToSave,
													address: account,
												},
												wallets: $connection.wallets,
												wallet: {
													provider: _wallet.provider,
													accounts,
													status: 'connected',
													accountChanged: undefined,
													chainId,
													invalidChainId: alwaysOnChainId != chainId,
													switchingChain: false,
												},
											};
								if (
									newState.step === 'WalletConnected' &&
									(requestSignatureAutomaticallyIfPossible || options?.requestSignatureRightAway) &&
									!options?.requireUserConfirmationBeforeSignatureRequest
								) {
									set(newState);
									alwaysOnProvider.setWalletStatus('connected');
									saveLastWallet(newState.mechanism);
									watchForAccountChange(_wallet.provider);
									await requestSignature();
								} else {
									watchForAccountChange(_wallet.provider);
									set(newState);
									alwaysOnProvider.setWalletStatus('connected');
									if (newState.step === 'WalletConnected') {
										saveLastWallet(newState.mechanism);
									}
								}
							}
						} catch (err) {
							set({
								step: 'MechanismToChoose',
								wallets: $connection.wallets,
								wallet: undefined,
								error: {message: `failed to connect to wallet`, cause: err},
							});
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						set({
							step: 'MechanismToChoose',
							wallets: $connection.wallets,
							wallet: undefined,
							error: {message: `failed to get wallet ${walletName}`},
						});
					}
				} else {
					// TODO can also be done automatically before hand
					// set({
					// 	step: 'FetchingWallets',
					// 	mechanism: { type: 'wallet', wallet: undefined }
					// });

					set({
						step: 'WalletToChoose',
						mechanism: {type: 'wallet'},
						wallet: undefined,
						wallets: $connection.wallets,
					});
				}
			} else {
				popup = connectViaPopup({
					mechanism,
					walletHost: settings.walletHost,
				});
				set({
					step: 'PopupLaunched',
					popupClosed: false,
					mechanism,
					wallets: $connection.wallets,
					wallet: undefined,
				});

				const unsubscribe = popup.subscribe(($popup) => {
					if ($connection?.step === 'PopupLaunched') {
						if ($popup.closed) {
							set({
								...$connection,
								popupClosed: true,
							});
						}
					}
				});
				try {
					const result = await popup;
					// console.log({result});
					set({
						step: 'SignedIn',
						account: result,
						mechanism,
						wallets: $connection.wallets,
						wallet: undefined,
					});
					if (remember) {
						saveOriginAccount(result);
					}
				} catch (err) {
					console.error({error: err});
					set({step: 'Idle', loading: false, wallet: undefined, wallets: $connection.wallets});
				} finally {
					unsubscribe();
				}
			}
		} else {
			set({
				step: 'MechanismToChoose',
				wallets: $connection.wallets,
				wallet: undefined,
			});
		}
	}

	function ensureConnected(
		step: 'WalletConnected',
		mechanism?: WalletMechanism<string | undefined, `0x${string}` | undefined>,
		options?: ConnectionOptions,
	): Promise<WalletConnected>;
	function ensureConnected(step: 'SignedIn', mechanism?: Mechanism, options?: ConnectionOptions): Promise<SignedIn>;
	function ensureConnected(mechanism?: Mechanism, options?: ConnectionOptions): Promise<SignedIn>;
	async function ensureConnected<Step extends 'WalletConnected' | 'SignedIn' = 'SignedIn'>(
		stepOrMechanism?: Step | Mechanism,
		mechanismOrOptions?: Mechanism | ConnectionOptions,
		options?: ConnectionOptions,
	) {
		const step = typeof stepOrMechanism === 'string' ? stepOrMechanism : 'SignedIn';
		let mechanism = typeof stepOrMechanism === 'string' ? (mechanismOrOptions as Mechanism) : stepOrMechanism;
		if (!mechanism && step === 'WalletConnected') {
			mechanism = {type: 'wallet'};
		}
		options = typeof stepOrMechanism === 'string' ? options : (mechanismOrOptions as ConnectionOptions);
		const promise = new Promise<Step extends 'WalletConnected' ? WalletConnected : SignedIn>((resolve, reject) => {
			let forceConnect = false;
			if (
				$connection.step == 'WalletConnected' &&
				($connection.wallet.status == 'locked' || $connection.wallet.status === 'disconnected')
			) {
				// console.log(`locked / disconnected : we assume it needs reconnection`);
				forceConnect = true;
				mechanism = $connection.mechanism; // we reuse existing mechanism as we just want to reconnect
			} else if ($connection.step == step) {
				resolve($connection as any);
				return;
			}
			let idlePassed = $connection.step != 'Idle';
			if (!idlePassed || forceConnect) {
				connect(mechanism, options);
			}
			const unsubscribe = _store.subscribe((connection) => {
				if (connection.step === 'Idle' && idlePassed) {
					unsubscribe();
					reject();
				}
				if (!idlePassed && connection.step !== 'Idle') {
					idlePassed = true;
				}
				if (connection.step === step) {
					unsubscribe();
					resolve(connection as any);
				}
			});
		});

		return promise;
	}

	function disconnect() {
		deleteOriginAccount();
		deleteLastWallet();
		if (_wallet) {
			alwaysOnProvider.setWalletProvider(undefined);
			stopWatchingForAccountChange(_wallet.provider);
			stopWatchingForChainIdChange(_wallet.provider);
		}
		_wallet = undefined;
		set({
			step: 'Idle',
			loading: false,
			wallet: undefined,
			wallets: $connection.wallets,
		});
	}

	function back(step: 'MechanismToChoose' | 'Idle' | 'WalletToChoose') {
		popup?.cancel();
		if (step === 'MechanismToChoose') {
			set({step, wallets: $connection.wallets, wallet: undefined});
		} else if (step === 'Idle') {
			set({step, loading: false, wallet: undefined, wallets: $connection.wallets});
		} else if (step === 'WalletToChoose') {
			set({step, wallet: undefined, wallets: $connection.wallets, mechanism: {type: 'wallet'}});
		}
	}

	const popupLauncher = createPopupLauncher<OriginAccount>();

	function connectViaPopup(settings: PopupSettings) {
		let popupURL = new URL(`${settings.walletHost}/login/`);
		let fullWindow = false;
		if (settings.mechanism.type === 'mnemonic') {
			popupURL.searchParams.append('type', 'mnemonic');
		} else if (settings.mechanism.type === 'email') {
			popupURL.searchParams.append('type', 'email');
			if (settings.mechanism.email) {
				popupURL.searchParams.append('email', encodeURIComponent(settings.mechanism.email));
			}
			if (settings.mechanism.mode) {
				popupURL.searchParams.append('emailMode', settings.mechanism.mode);
			}
		} else if (settings.mechanism.type === 'oauth') {
			popupURL.searchParams.append('type', 'oauth');

			if (settings.mechanism.provider.id === 'auth0') {
				popupURL.searchParams.append('oauth-provider', settings.mechanism.provider.id);
				popupURL.searchParams.append('oauth-connection', settings.mechanism.provider.connection);
			} else {
				popupURL.searchParams.append('oauth-provider', settings.mechanism.provider.id);
			}

			if (!settings.mechanism.usePopup) {
				popupURL.searchParams.append('oauth-redirection', 'true');
			}
		} else {
			throw new Error(`mechanism ${(settings.mechanism as any).type} not supported`);
		}

		// if (settings.extraParams) {
		// 	for (const [key, value] of Object.entries(settings.extraParams)) {
		// 		popupURL.searchParams.append(`${key}`, value);
		// 	}
		// }

		const currentURL = new URL(location.href);

		const entriesToAdd: [string, string][] = [];
		currentURL.searchParams.forEach((value, key) => {
			if (key.startsWith('renraku_')) {
				entriesToAdd.push([key.slice(`renraku_`.length), value]);
			}
		});

		if (currentURL.searchParams.has('eruda')) {
			entriesToAdd.push(['eruda', currentURL.searchParams.get('eruda') || '']);
		}
		if (currentURL.searchParams.has('debug')) {
			entriesToAdd.push(['debug', currentURL.searchParams.get('debug') || '']);
		}
		if (currentURL.searchParams.has('log')) {
			entriesToAdd.push(['log', currentURL.searchParams.get('log') || '']);
		}

		for (const entryToAdd of entriesToAdd) {
			popupURL.searchParams.append(entryToAdd[0], entryToAdd[1]);
		}
		return popupLauncher.launchPopup(popupURL.toString(), {fullWindow});
	}

	function cancel() {
		popup?.cancel();
		deleteLastWallet();
		set({step: 'Idle', wallet: undefined, loading: false, wallets: $connection.wallets});
	}

	function getSignatureForPublicKeyPublication(): Promise<`0x${string}`> {
		if ($connection.step !== 'SignedIn') {
			throw new Error('Not signed in');
		}
		const account = $connection.account;
		if ($connection.mechanism.type === 'wallet') {
			if (!_wallet) {
				throw new Error(`no provider`);
			}
			const message = originPublicKeyPublicationMessage(origin, account.signer.publicKey);
			const msg = hashMessage(message);
			return _wallet.provider.request({
				method: 'personal_sign',
				params: [msg, account.address],
			});
		}

		if (account.savedPublicKeyPublicationSignature) {
			return Promise.resolve(account.savedPublicKeyPublicationSignature);
		}

		// TODO offer a way to use iframe + popup to sign the message
		// this would require saving mnemonic or privatekey on etherplay localstorage though
		throw new Error(`no saved public key publication signature for ${account.address}`);
	}

	async function unlock() {
		const wallet = $connection.wallet;
		if (!wallet || wallet.status !== 'locked') {
			throw new Error(`invalid state`);
		}

		set({
			...$connection,
			wallet: {
				...wallet,
				unlocking: true,
			},
		});

		try {
			await wallet.provider.request({method: 'eth_requestAccounts'}).then(onAccountChanged);
		} catch {
			set({
				...$connection,
				wallet: {
					...wallet,
					unlocking: false,
				},
			});
		}
	}

	async function switchWalletChain(
		chainId: string,
		config?: {
			readonly rpcUrls?: readonly string[];
			readonly blockExplorerUrls?: readonly string[];
			readonly chainName?: string;
			readonly iconUrls?: readonly string[];
			readonly nativeCurrency?: {
				name: string;
				symbol: string;
				decimals: number;
			};
		},
	) {
		if (!$connection.wallet) {
			throw new Error(`invali state`);
		}

		const wallet = $connection.wallet;
		// if (!wallet) {
		// 	throw new Error(`no wallet`);
		// }

		try {
			// attempt to switch...
			set({
				...$connection,
				wallet: {...$connection.wallet, switchingChain: 'switchingChain'},
			});
			const result = await wallet.provider.request({
				method: 'wallet_switchEthereumChain',
				params: [
					{
						chainId: ('0x' + parseInt(chainId).toString(16)) as EIP1193ChainId,
					},
				],
			});
			if (!result) {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
					});
				}

				// logger.info(`wallet_switchEthereumChain: complete`);
				// this will be taken care with `chainChanged` (but maybe it should be done there ?)
				// handleNetwork(chainId);
			} else {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
						error: {
							message: `Failed to switch to ${config?.chainName || `chain with id = ${chainId}`}`,
							cause: result,
						},
					});
				}
				throw result;
			}
		} catch (err) {
			if ((err as any).code === 4001) {
				// logger.info(`wallet_addEthereumChain: failed but error code === 4001, we ignore as user rejected it`, err);
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
					});
				}
				return;
			}
			// if ((err as any).code === 4902) {
			else if (config && config.rpcUrls && config.rpcUrls.length > 0) {
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: 'addingChain'},
					});
				}
				// logger.info(`wallet_switchEthereumChain: could not switch, try adding the chain via "wallet_addEthereumChain"`);
				try {
					const result = await wallet.provider.request({
						method: 'wallet_addEthereumChain',
						params: [
							{
								chainId: ('0x' + parseInt(chainId).toString(16)) as EIP1193ChainId,
								rpcUrls: config.rpcUrls,
								chainName: config.chainName,
								blockExplorerUrls: config.blockExplorerUrls,
								iconUrls: config.iconUrls,
								nativeCurrency: config.nativeCurrency,
							},
						],
					});
					if (!result) {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
							});
						}
						// this will be taken care with `chainChanged` (but maybe it should be done there ?)
						// handleNetwork(chainId);
					} else {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
								error: {
									message: `Failed to add new chain: ${config?.chainName || `chain with id = ${chainId}`}`,
									cause: result,
								},
							});
						}
						// logger.info(`wallet_addEthereumChain: a non-undefinded result means an error`, result);
						throw result;
					}
				} catch (err) {
					if ((err as any).code !== 4001) {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
								error: {
									message: `Failed to add new chain: ${config?.chainName || `chain with id = ${chainId}`}`,
									cause: err,
								},
							});
						}
						// logger.info(`wallet_addEthereumChain: failed`, err);
						// TODO ?
						// set({
						// 	error: {message: `Failed to add new chain`, cause: err},
						// });
						// for now:
						throw err;
					} else {
						if ($connection.wallet) {
							set({
								...$connection,
								wallet: {...$connection.wallet, switchingChain: false},
							});
						}
						// logger.info(`wallet_addEthereumChain: failed but error code === 4001, we ignore as user rejected it`, err);
						return;
					}
				}
			} else {
				const errorMessage = `Chain "${config?.chainName || `with chainId = ${chainId}`} " is not available on your wallet`;
				if ($connection.wallet) {
					set({
						...$connection,
						wallet: {...$connection.wallet, switchingChain: false},
						error: {
							message: errorMessage,
						},
					});
				}

				throw new Error(errorMessage);
			}
		}
	}

	return {
		subscribe: _store.subscribe,
		connect,
		cancel,
		back,
		requestSignature,
		connectToAddress,
		disconnect,
		getSignatureForPublicKeyPublication,
		switchWalletChain,
		unlock,
		ensureConnected,
		provider: alwaysOnProvider,
	};
}

export type ConnectionStore = ReturnType<typeof createConnection>;
