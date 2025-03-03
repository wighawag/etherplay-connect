import type { AlchemyMechanism, OriginAccount } from 'etherplay-alchemy';
import { writable } from 'svelte/store';
import { createPopupLauncher, type PopupPromise } from './popup.js';

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

export type Connection = { error?: { message: string; cause?: any } } & (
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

export function createConnection(settings: { walletHost: string }) {
	let $connection: Connection | undefined;
	const _store = writable<Connection | undefined>($connection);
	function set(connection: Connection | undefined) {
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

	async function connect(mechanism?: Mechanism) {
		if (mechanism) {
			if (mechanism.type === 'wallet') {
				const wallet = mechanism.wallet;
				if (wallet) {
					set({
						step: 'WaitingForWalletConnection',
						mechanism: { type: 'wallet', wallet }
					});
					// TODO connect via web3-conneciton or implement it here
				} else {
					// TODO can also be done automatically before hand
					// set({
					// 	step: 'FetchingWallets',
					// 	mechanism: { type: 'wallet', wallet: undefined }
					// });

					set({
						step: 'WalletToChoose',
						mechanism: { type: 'wallet', wallet: undefined }
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
					mechanism
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
						mechanism
					});
				} catch (err) {
					console.log({ error: err });
					set(undefined);
				} finally {
					unsubscribe();
				}
			}
		} else {
			set({
				step: 'MechanismToChoose'
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
		set(undefined);
	}

	return {
		subscribe: _store.subscribe,
		connect,
		cancel
	};
}
