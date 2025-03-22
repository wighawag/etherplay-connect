import type {AlchemyMechanism, OriginAccount} from '@etherplay/alchemy';
import {writable} from 'svelte/store';
import {createPopupLauncher, type PopupPromise} from './popup.js';
import type {EIP1193WindowWalletProvider} from 'eip-1193';
import {
	fromEntropyKeyToMnemonic,
	fromMnemonicToFirstAccount,
	fromSignatureToKey,
	originKeyMessage,
	originPublicKeyPublicationMessage,
} from '@etherplay/alchemy';
import {hashMessage} from './utils.js';

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
	  }
	// It can then end up in MechanismToChoose if no specific connection mechanism was chosen upon clicking "connect"
	| {
			step: 'MechanismToChoose';
	  }
	// if a social/email login mechanism was chose, a popup will be launched
	// popupClosed can be true and this means the popup has been closed and the user has to cancel the process to continue further
	| {
			step: 'PopupLaunched';
			popupClosed: boolean;
			mechanism: AlchemyMechanism;
	  }
	// If the user has chosen to use web3-wallet there might be multi-choice for it
	| {
			step: 'WalletToChoose';
			mechanism: WalletMechanism<undefined, undefined>;
	  }
	// Once a user has chosen a wallet, the system will try to connect to it
	| {
			step: 'WaitingForWalletConnection';
			mechanism: WalletMechanism<string, undefined>;
	  }
	// Once the wallet is connected, the system will need a signature
	// this state represent the fact and require another user interaction to request the signature
	| {
			step: 'NeedWalletSignature';
			mechanism: WalletMechanism<string, `0x${string}`>;
	  }
	// This state is triggered once the signature is requested, the user will have to confirm with its wallet
	| {
			step: 'WaitingForSignature';
			mechanism: WalletMechanism<string, `0x${string}`>;
	  }
	// Finally the user is fully signed in
	// walletAccountChanged if set, represent the fact that the user has changed its web3-wallet accounnt.
	// a notification could be shown to the user so that he can switch the app to use that other account.
	| {
			step: 'SignedIn';
			mechanism: FullfilledMechanism;
			account: OriginAccount;
			wallet?: {
				provider: EIP1193WindowWalletProvider;
				accountChanged?: `0x${string}`;
				chainId: string;
			};
	  }
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

const storageAccountKey = '__origin_account';
export function createConnection(settings: {walletHost: string; autoConnect?: boolean}) {
	let autoConnect = true;
	if (typeof settings.autoConnect !== 'undefined') {
		autoConnect = settings.autoConnect;
	}

	let $connection: Connection = {step: 'Idle', loading: true, wallets: []};
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
						if (existingAccount.mechanismUsed.type == 'wallet') {
							const walletMechanism = existingAccount.mechanismUsed as WalletMechanism<string, `0x${string}`>;
							waitForWallet(walletMechanism.name)
								.then(async (walletDetails: EIP6963ProviderDetail) => {
									const walletProvider = walletDetails.provider;
									const chainIdAsHex = await walletProvider.request({method: 'eth_chainId'});
									const chainId = Number(chainIdAsHex).toString();
									_wallet = {provider: walletProvider, chainId};
									watchForChainIdChange(_wallet.provider);
									set({
										step: 'SignedIn',
										account: existingAccount,
										mechanism: existingAccount.mechanismUsed as FullfilledMechanism,
										wallets: $connection.wallets,
										wallet: {
											provider: walletProvider,
											accountChanged: undefined,
											chainId,
										},
									});
									walletProvider.request({method: 'eth_accounts'}).then(onAccountChanged);
									watchForAccountChange(walletProvider);
								})
								.catch((err) => {
									set({step: 'Idle', loading: false, wallets: $connection.wallets});
								});
						} else {
							set({
								step: 'SignedIn',
								account: existingAccount,
								mechanism: existingAccount.mechanismUsed as FullfilledMechanism,
								wallets: $connection.wallets,
								wallet: undefined,
							});
						}
					} else {
						set({step: 'Idle', loading: false, wallets: $connection.wallets});
					}
				} else {
					set({step: 'Idle', loading: false, wallets: $connection.wallets});
				}
			} catch {
				set({step: 'Idle', loading: false, wallets: $connection.wallets});
			}
		}
	} else {
		set({step: 'Idle', loading: false, wallets: $connection.wallets});
	}
	fetchWallets();

	function getOriginAccount(): OriginAccount | undefined {
		const fromStorage = localStorage.getItem(storageAccountKey);
		if (fromStorage) {
			return JSON.parse(fromStorage) as OriginAccount;
		}
	}
	function saveOriginAccount(account: OriginAccount) {
		const accountSTR = JSON.stringify(account);
		sessionStorage.setItem(storageAccountKey, accountSTR);
		localStorage.setItem(storageAccountKey, accountSTR);
	}
	function deleteOriginAccount() {
		sessionStorage.removeItem(storageAccountKey);
		localStorage.removeItem(storageAccountKey);
	}

	async function requestSignature() {
		if ($connection.step !== 'NeedWalletSignature') {
			throw new Error(`invalid step: ${$connection.step}, needs to be NeedWalletSignature`);
		}

		if (!_wallet) {
			// TODO error ?
			throw new Error(`no wallet provided initialised`);
		}
		const provider = _wallet.provider;
		const chainId = _wallet.chainId;
		const message = originKeyMessage(origin);
		const msg = hashMessage(message);

		set({
			...$connection,
			step: 'WaitingForSignature',
		});

		let signature: `0x${string}`;
		try {
			// TODO timeout
			signature = await provider.request({
				method: 'personal_sign',
				params: [msg, $connection.mechanism.address],
			});
		} catch (err) {
			// TODO handle rejection (code: 4001 ?)
			set({
				...$connection,
				step: 'NeedWalletSignature',
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
			mechanism: {
				type: 'wallet',
				name: $connection.mechanism.name,
				address: $connection.mechanism.address,
			},
			account,
			wallet: {
				chainId,
				provider: provider,
				accountChanged: undefined, // TODO check account list
			},
		});
		if (remember) {
			saveOriginAccount(account);
		}
	}

	function connectOnCurrentWalletAccount(address: `0x${string}`) {
		if ($connection.step === 'SignedIn' && $connection.mechanism.type === 'wallet') {
			connect({
				type: 'wallet',
				address,
				name: $connection.mechanism.name,
			});
		} else {
			throw new Error(`need to be using a mechanism of type wallet and be SignedIN`);
		}
	}

	function onChainChanged(chainIdAsHex: `0x${string}`) {
		const chainId = Number(chainIdAsHex).toString();
		if (_wallet) {
			_wallet.chainId = chainId;
		}
		if ($connection.step === 'SignedIn' && $connection.wallet && $connection.wallet.chainId != chainId) {
			set({
				...$connection,
				wallet: {
					...$connection.wallet,
					chainId,
				},
			});
		}
	}

	function onAccountChanged(accounts: `0x${string}`[]) {
		const accountsFormated = accounts.map((a) => a.toLowerCase()) as `0x${string}`[];
		if ($connection.step === 'SignedIn' && $connection.mechanism.type === 'wallet') {
			// TODO if auto-connect and saved-signature ?
			// connect(
			// 	{
			// 		type: 'wallet',
			// 		address: accounts[0],
			// 		name: $connection.mechanism.name
			// 	},
			// 	{ requireUserConfirmationBeforeSIgnatureRequest: true }
			// );

			if ($connection.wallet && accountsFormated.length > 0 && accountsFormated[0] != $connection.account.address) {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						accountChanged: accountsFormated[0],
					},
				});
			} else if ($connection.wallet) {
				set({
					...$connection,
					wallet: {
						...$connection.wallet,
						accountChanged: undefined,
					},
				});
			}
		}

		// if (accounts[0] !== $connection)
	}

	function watchForAccountChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.on('accountsChanged', onAccountChanged);
	}
	function stopatchingForAccountChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.removeListener('accountsChanged', onAccountChanged);
	}

	function watchForChainIdChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.on('chainChanged', onChainChanged);
	}
	function stopatchingForChainIdChange(walletProvider: EIP1193WindowWalletProvider) {
		walletProvider.removeListener('chainChanged', onChainChanged);
	}

	let remember: boolean = false;
	async function connect(
		mechanism?: Mechanism,
		options?: {
			requireUserConfirmationBeforeSIgnatureRequest?: boolean;
			doNotStoreLocally?: boolean;
			requestSignatureRightAway?: boolean;
		},
	) {
		remember = !(options?.doNotStoreLocally || false);
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const walletName = mechanism.name;
				if (walletName) {
					const wallet = $connection.wallets.find((v) => v.info.name == walletName || v.info.uuid == walletName);
					if (wallet) {
						if (_wallet) {
							stopatchingForAccountChange(_wallet.provider);
							stopatchingForChainIdChange(_wallet.provider);
						}

						const mechanism: WalletMechanism<string, undefined> = {
							type: 'wallet',
							name: walletName,
						};

						set({
							step: 'WaitingForWalletConnection', // TODO FetchingAccounts
							mechanism,
							wallets: $connection.wallets,
						});
						const provider = wallet.provider;
						const chainIdAsHex = await provider.request({method: 'eth_chainId'});
						const chainId = Number(chainIdAsHex).toString();
						_wallet = {
							chainId,
							provider,
						};
						watchForChainIdChange(_wallet.provider);
						let accounts = await provider.request({method: 'eth_accounts'});
						accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
						if (accounts.length === 0) {
							set({
								step: 'WaitingForWalletConnection',
								mechanism,
								wallets: $connection.wallets,
							});
							accounts = await provider.request({method: 'eth_requestAccounts'});
							accounts = accounts.map((v) => v.toLowerCase()) as `0x${string}`[];
							if (accounts.length > 0) {
								if (options?.requestSignatureRightAway) {
									watchForAccountChange(_wallet.provider);
									set({
										step: 'NeedWalletSignature',
										mechanism: {
											...mechanism,
											address: accounts[0],
										},
										wallets: $connection.wallets,
									});
									await requestSignature();
								} else {
									set({
										step: 'NeedWalletSignature',
										mechanism: {
											...mechanism,
											address: accounts[0],
										},
										wallets: $connection.wallets,
									});
									watchForAccountChange(_wallet.provider);
								}
							} else {
								set({
									step: 'MechanismToChoose',
									wallets: $connection.wallets,
									error: {message: 'could not get any accounts'},
								});
							}
						} else {
							if (options?.requireUserConfirmationBeforeSIgnatureRequest) {
								set({
									step: 'NeedWalletSignature',
									mechanism: {
										...mechanism,
										address: accounts[0],
									},
									wallets: $connection.wallets,
								});
								watchForAccountChange(_wallet.provider);
							} else {
								watchForAccountChange(_wallet.provider);
								set({
									step: 'NeedWalletSignature',
									mechanism: {
										...mechanism,
										address: accounts[0],
									},
									wallets: $connection.wallets,
								});
								await requestSignature();
							}
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						set({
							step: 'MechanismToChoose',
							wallets: $connection.wallets,
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
					console.log({result});
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
					console.log({error: err});
					set({step: 'Idle', loading: false, wallets: $connection.wallets});
				} finally {
					unsubscribe();
				}
			}
		} else {
			set({
				step: 'MechanismToChoose',
				wallets: $connection.wallets,
			});
		}
	}

	function disconnect() {
		deleteOriginAccount();
		if (_wallet) {
			stopatchingForAccountChange(_wallet.provider);
			stopatchingForChainIdChange(_wallet.provider);
		}
		_wallet = undefined;
		set({
			step: 'Idle',
			loading: false,
			wallets: $connection.wallets,
		});
	}

	function back(step: 'MechanismToChoose' | 'Idle' | 'WalletToChoose') {
		popup?.cancel();
		if (step === 'MechanismToChoose') {
			set({step, wallets: $connection.wallets});
		} else if (step === 'Idle') {
			set({step, loading: false, wallets: $connection.wallets});
		} else if (step === 'WalletToChoose') {
			set({step, wallets: $connection.wallets, mechanism: {type: 'wallet'}});
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
		if (currentURL.searchParams.has('eruda')) {
			entriesToAdd.push(['eruda', currentURL.searchParams.get('eruda') || '']);
		}

		for (const entryToAdd of entriesToAdd) {
			popupURL.searchParams.append(entryToAdd[0], entryToAdd[1]);
		}
		return popupLauncher.launchPopup(popupURL.toString(), {fullWindow});
	}

	function cancel() {
		popup?.cancel();
		set({step: 'Idle', loading: false, wallets: $connection.wallets});
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

	return {
		subscribe: _store.subscribe,
		connect,
		cancel,
		back,
		requestSignature,
		connectOnCurrentWalletAccount,
		disconnect,
		getSignatureForPublicKeyPublication,
	};
}
