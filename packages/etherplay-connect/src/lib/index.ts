import type { AlchemyMechanism, OriginAccount } from 'etherplay-alchemy';
import { writable } from 'svelte/store';
import { createPopupLauncher, type PopupPromise } from './popup.js';
import type { EIP1193WindowWalletProvider } from 'eip-1193';

export type PopupSettings = {
	walletHost: string;
	mechanism: AlchemyMechanism;
	// extraParams?: Record<string, string>;
};

export type WalletMechanism<
	WalletName extends string | undefined,
	HasProvider extends boolean | undefined,
	Address extends `0x${string}` | undefined
> = {
	type: 'wallet';
} & (WalletName extends undefined ? { name?: undefined } : { name: WalletName }) &
	(HasProvider extends undefined
		? { provider?: undefined }
		: { provider: EIP1193WindowWalletProvider }) &
	(Address extends undefined ? { address?: undefined } : { address: Address });

export type Mechanism =
	| AlchemyMechanism
	| WalletMechanism<string | undefined, boolean | undefined, `0x${string}` | undefined>;

export type FullfilledMechanism = AlchemyMechanism | WalletMechanism<string, true, `0x${string}`>;

export type Connection = {
	error?: { message: string; cause?: any };
	wallets: EIP6963ProviderDetail[];
} & (
	| {
			step: 'Idle';
	  }
	| {
			step: 'MechanismToChoose';
	  }
	| {
			step: 'PopupLaunched';
			popupClosed: boolean;
			mechanism: AlchemyMechanism;
	  }
	| {
			step: 'WalletToChoose';
			mechanism: WalletMechanism<undefined, undefined, undefined>;
	  }
	| {
			step: 'WaitingForWalletConnection';
			mechanism: WalletMechanism<string, true, undefined>;
	  }
	| {
			step: 'NeedWalletSignature';
			mechanism: WalletMechanism<string, true, `0x${string}`>;
	  }
	| {
			step: 'WaitingForSignature';
			mechanism: WalletMechanism<string, true, `0x${string}`>;
	  }
	| {
			step: 'SignedIn';
			mechanism: FullfilledMechanism;
			account: OriginAccount;
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

export function createConnection(settings: { walletHost: string }) {
	let $connection: Connection = { step: 'Idle', wallets: [] };
	const _store = writable<Connection>($connection);
	function set(connection: Connection) {
		$connection = connection;
		_store.set($connection);
		return $connection;
	}
	function setError(error: { message: string; cause?: any }) {
		if ($connection) {
			set({
				...$connection,
				error
			});
		} else {
			throw new Error(`no connection`);
		}
	}

	let popup: PopupPromise<OriginAccount> | undefined;

	function fetchWallets() {
		if (typeof window !== 'undefined') {
			// const defaultProvider = (window as any).ethereum;
			// console.log(defaultProvider);
			// TODO ?
			(window as any).addEventListener(
				'eip6963:announceProvider',
				(event: EIP6963AnnounceProviderEvent) => {
					const { detail } = event;
					// const { info, provider } = detail;
					// const { uuid, name, icon, rdns } = info;
					// console.log('provider', provider);
					// console.log(`isDefault: ${provider === defaultProvider}`);
					// console.log('info', info);
					const existingWallets = $connection.wallets;
					existingWallets.push(detail);

					set({
						...$connection,
						wallets: existingWallets
					});
				}
			);
			window.dispatchEvent(new Event('eip6963:requestProvider'));
		}
	}

	fetchWallets();

	async function requestSignature() {
		if ($connection.step !== 'NeedWalletSignature') {
			throw new Error(`invalid step: ${$connection.step}, needs to be NeedWalletSignature`);
		}

		const provider = $connection.mechanism.provider;
		const msg = `0x${Buffer.from('hello', 'utf8').toString('hex')}` as `0x${string}`;

		set({
			...$connection,
			step: 'WaitingForSignature'
		});
		const signature = await provider.request({
			method: 'personal_sign',
			params: [msg, $connection.mechanism.address]
		});
		console.log({ signature });

		set({
			...$connection,
			step: 'SignedIn',
			mechanism: {
				type: 'wallet',
				name: $connection.mechanism.name,
				provider: $connection.mechanism.provider,
				address: $connection.mechanism.address
				// signature: signature as `0x${string}`
			},
			account: {
				localAccount: {
					address: $connection.mechanism.address
					// signature: signature as `0x${string}`
				},
				originAccount: {
					address: $connection.mechanism.address
					// signature: signature as `0x${string}`
				},
				mechanismUsed: $connection.mechanism,
				user: {}
			}
		});
	}

	async function connect(mechanism?: Mechanism) {
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const walletName = mechanism.name;
				if (walletName) {
					const wallet = $connection.wallets.find(
						(v) => v.info.name == walletName || v.info.uuid == walletName
					);
					if (wallet) {
						const mechanism: WalletMechanism<string, true, undefined> = {
							type: 'wallet',
							name: walletName,
							provider: wallet.provider
						};

						set({
							step: 'WaitingForWalletConnection', // TODO FetchingAccounts
							mechanism,
							wallets: $connection.wallets
						});
						const provider = wallet.provider;
						let accounts = await provider.request({ method: 'eth_accounts' });
						if (accounts.length === 0) {
							set({
								step: 'WaitingForWalletConnection',
								mechanism,
								wallets: $connection.wallets
							});
							accounts = await provider.request({ method: 'eth_requestAccounts' });

							set({
								step: 'NeedWalletSignature',
								mechanism: {
									...mechanism,
									address: accounts[0]
								},
								wallets: $connection.wallets
							});
						} else {
							set({
								step: 'NeedWalletSignature',
								mechanism: {
									...mechanism,
									address: accounts[0]
								},
								wallets: $connection.wallets
							});
							await requestSignature();
						}
					} else {
						console.error(`failed to get wallet ${walletName}`, $connection.wallets);
						set({
							step: 'MechanismToChoose',
							wallets: $connection.wallets,
							error: { message: `failed to get wallet ${walletName}` }
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
						mechanism: { type: 'wallet' },
						wallets: $connection.wallets
					});
				}
			} else {
				popup = connectViaPopup({
					mechanism,
					walletHost: settings.walletHost
				});
				set({
					step: 'PopupLaunched',
					popupClosed: false,
					mechanism,
					wallets: $connection.wallets
				});

				const unsubscribe = popup.subscribe(($popup) => {
					if ($connection?.step === 'PopupLaunched') {
						if ($popup.closed) {
							set({
								...$connection,
								popupClosed: true
							});
						}
					}
				});
				try {
					const result = await popup;
					console.log({ result });
					set({
						step: 'SignedIn',
						account: result,
						mechanism,
						wallets: $connection.wallets
					});
				} catch (err) {
					console.log({ error: err });
					set({ step: 'Idle', wallets: $connection.wallets });
				} finally {
					unsubscribe();
				}
			}
		} else {
			set({
				step: 'MechanismToChoose',
				wallets: $connection.wallets
			});
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
		for (const entry of currentURL.searchParams.entries()) {
			if (entry[0].startsWith('renraku_')) {
				entriesToAdd.push([entry[0].slice(`renraku_`.length), entry[1]]);
			}
		}

		if (currentURL.searchParams.has('_d_eruda')) {
			entriesToAdd.push(['_d_eruda', currentURL.searchParams.get('_d_eruda') || '']);
		}

		for (const entryToAdd of entriesToAdd) {
			popupURL.searchParams.append(entryToAdd[0], entryToAdd[1]);
		}
		return popupLauncher.launchPopup(popupURL.toString(), { fullWindow });
	}

	function cancel() {
		popup?.cancel();
		set({ step: 'Idle', wallets: $connection.wallets });
	}

	return {
		subscribe: _store.subscribe,
		connect,
		cancel,
		requestSignature
	};
}
