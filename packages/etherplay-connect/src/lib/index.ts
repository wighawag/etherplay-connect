import type { AlchemyMechanism, OriginAccount } from 'etherplay-alchemy';
import { writable } from 'svelte/store';
import { createPopupLauncher, type PopupPromise } from './popup.js';
import type { EIP1193WindowWalletProvider } from 'eip-1193';

export type PopupSettings = {
	walletHost: string;
	mechanism: AlchemyMechanism;
	// extraParams?: Record<string, string>;
};

export type WalletMechanism<T extends string | undefined> = {
	type: 'wallet';
	wallet: T;
};
export type Mechanism = AlchemyMechanism | WalletMechanism<string | undefined>;

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
			mechanism: WalletMechanism<undefined>;
	  }
	| {
			step: 'WaitingForWalletConnection';
			mechanism: WalletMechanism<string>;
	  }
	| {
			step: 'NeedWalletSignature';
			mechanism: WalletMechanism<string>;
	  }
	| {
			step: 'SignedIn';
			mechanism: Mechanism;
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

	function requestSignature() {}

	async function connect(mechanism?: Mechanism) {
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const walletName = mechanism.wallet;
				if (walletName) {
					const mechanism: WalletMechanism<string> = { type: 'wallet', wallet: walletName };

					const wallet = $connection.wallets.find(
						(v) => v.info.name == walletName || v.info.uuid == walletName
					);
					if (wallet) {
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
						}

						set({
							step: 'NeedWalletSignature',
							mechanism,
							wallets: $connection.wallets
						});
					} else {
						console.log(`failed to get wallet ${walletName}`, $connection.wallets);
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
						mechanism: { type: 'wallet', wallet: undefined },
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
