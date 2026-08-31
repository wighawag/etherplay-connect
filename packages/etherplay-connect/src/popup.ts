import {writable, type Readable} from 'sveltore';
import {createStorePromise} from './utils.js';
import {importPublicKeyB64, deriveAesKey, b64ToBuf} from '@etherplay/connect-core';

export type Error = {
	message: string;
	type?: string;
	cause?: any;
};

export type Popup = {
	launched: boolean;
	closed: boolean;
	resolved: boolean;
	error?: Error;
};

export type PopupPromise<T> = ReturnType<typeof createStorePromise<T, Popup, Readable<Popup> & {cancel: () => void}>>;

export function createPopupLauncher<T>() {
	let id = 1;
	let currentPopup:
		| {
				popup: Window;
				onMessage: (messageEvent: MessageEvent) => void;
				rejectRecovery: (error: Error) => void;
		  }
		| {popup: undefined} = {popup: undefined};

	function launchPopup(
		url: string,
		options?: {fullWindow?: boolean; decryptKeyPair?: CryptoKeyPair},
	): Promise<T> & Readable<Popup> & {cancel: () => void} {
		const urlObject = new URL(url);
		const expectedOrigin = `${urlObject.protocol}//${urlObject.host}`;
		const pathname = urlObject.pathname;

		let $popup: Popup = {
			closed: false,
			launched: false,
			resolved: false,
		};
		const _store = writable<Popup>($popup);
		function set(state: Popup) {
			$popup = state;
			_store.set(state);
		}

		if (currentPopup.popup) {
			console.log(`stop listening to message from old popup`);
			window.removeEventListener('message', currentPopup.onMessage);
			const tmpRejectRecovery = currentPopup.rejectRecovery;
			let couldCloseExistingPopup = false;
			try {
				currentPopup.popup.close();
				couldCloseExistingPopup = true;
			} catch (err) {
				console.error(err);
			}
			currentPopup = {popup: undefined};
			if (couldCloseExistingPopup) {
				tmpRejectRecovery({message: 'popup closed so new one can take over'});
			} else {
				tmpRejectRecovery({message: 'popup replaced'});
			}
		}

		let _resolveRecovery: (state: T) => void;
		let _rejectRecovery: (error: Error) => void;

		// Same-Origin Callback Bridge: the encrypted result may arrive on a
		// BroadcastChannel (from the bridge page running on our own origin).
		let channel: BroadcastChannel | undefined;
		let handled = false; // de-dupe: the same result may arrive on both transports

		function closeChannel() {
			try {
				channel?.close();
			} catch (e) {}
			channel = undefined;
		}

		function resolveRecovery(state: T) {
			currentPopup = {popup: undefined};
			console.log(`stop listening to message as we resolved it`);
			window.removeEventListener('message', onMessage);
			closeChannel();

			if (_resolveRecovery) {
				set({
					closed: true,
					launched: true,
					resolved: true,
				});
				_resolveRecovery(state);
			}
		}

		function rejectRecovery(error: Error) {
			currentPopup = {popup: undefined};
			console.log(`stop listening to message as we rejected it`, error);
			window.removeEventListener('message', onMessage);
			closeChannel();
			if (_rejectRecovery) {
				set({
					closed: true,
					launched: true,
					resolved: true,
					error: {
						message: 'errored',
						cause: error,
					},
				});
				_rejectRecovery(error);
			}
		}

		// Handles the encrypted `domain-redirect-result` package coming from the
		// bridge page (`_etherplay_accounts.html`). It can arrive via the window
		// `message` listener (window.opener.postMessage) OR via BroadcastChannel.
		async function handleEncryptedResult(
			d: any,
			transport: 'window message' | 'BroadcastChannel',
			source?: MessageEventSource | null,
		) {
			if (!d || d.type !== 'domain-redirect-result') return;
			// loose compare: `id` is a number here but arrives as a string
			if (id != d.id) return;
			if (handled) {
				console.log(`[domain-redirect] duplicate result via ${transport} ignored (already handled)`);
				return;
			}
			if (!options?.decryptKeyPair) return;
			handled = true;
			console.log(`[domain-redirect] result delivered via ${transport}`);
			try {
				const popupPub = await importPublicKeyB64(d.ephemeralPublicKey);
				const aesKey = await deriveAesKey(options.decryptKeyPair.privateKey, popupPub, ['decrypt']);
				const plain = await window.crypto.subtle.decrypt(
					{name: 'AES-GCM', iv: b64ToBuf(d.iv)},
					aesKey,
					b64ToBuf(d.encryptedResult),
				);
				const result = JSON.parse(new TextDecoder().decode(plain));
				// ACK so the bridge page can close itself cleanly (sent on both transports)
				try {
					channel?.postMessage({type: 'ack', id: d.id});
				} catch (e) {}
				try {
					(source as any)?.postMessage({type: 'ack', id: d.id}, window.origin);
				} catch (e) {}
				resolveRecovery(result);
			} catch (err) {
				rejectRecovery({message: 'domain-redirect decryption failed', cause: err});
			}
		}

		const onMessage = (messageEvent: MessageEvent) => {
			const data = messageEvent.data;
			if (data && data.type === 'domain-redirect-result') {
				// The bridge page posts from the parent's OWN origin, so accept both
				// the expected popup origin AND our own origin. The encrypted payload
				// + id match are the real authentication.
				if (messageEvent.origin === expectedOrigin || messageEvent.origin === window.origin) {
					handleEncryptedResult(data, 'window message', messageEvent.source);
				}
				return;
			}
			if (messageEvent.origin === expectedOrigin) {
				console.log(messageEvent);
				if (id == data.id) {
					if (data.error) {
						console.error(`ERROR`, data.error);
						rejectRecovery(data.error);
					} else {
						resolveRecovery(data.result);
					}
				} else {
					console.log(`different id : eventId = ${data.id}, expected id = ${id}`);
				}
			}
		};

		// function continuouslyPingPopup(popup: Window) {
		// 	const intervalId = setInterval(() => {
		// 		// // console.log(`checking if popup is closed...`);
		// 		if (currentPopup.popup !== popup) {
		// 			console.log(`ping: new popup, we ignore closing state`);
		// 			clearInterval(intervalId);
		// 			return;
		// 		}
		// 		try {
		// 			if ('closed' in popup && popup.closed) {
		// 				console.log(`ping: popup is closed`);
		// 				clearInterval(intervalId);
		// 			}
		// 			console.log(`ping: ${expectedOrigin}`);
		// 			popup.postMessage({ id, type: 'ping' }, expectedOrigin);
		// 		} catch (err) {}
		// 	}, 300);
		// }

		function watchForPopupClosed(popup: Window) {
			const intervalId = setInterval(() => {
				// console.log(`checking if popup is closed...`);
				if (currentPopup.popup !== popup) {
					console.log(`new popup, we ignore closing state`);
					clearInterval(intervalId);
					return;
				}
				try {
					if ('closed' in popup && popup.closed) {
						console.log(`popup is closed`);
						clearInterval(intervalId);

						setTimeout(() => {
							// we delay the rejection in case it conflict with an onMessage event
							if (currentPopup.popup === popup) {
								set({
									closed: true,
									launched: $popup.launched,
									resolved: $popup.resolved,
									error: $popup.error,
								});
							}
						}, 100);
					}
				} catch (err) {}
			}, 200);
		}

		// The window this launch opened, so `cancel` closes ITS popup rather than whichever is
		// current: a second launch replaces `currentPopup` while an older promise may still be held.
		let launchedWindow: Window | undefined;

		const store = {
			subscribe: _store.subscribe,
			/**
			 * Close the popup and SETTLE the promise.
			 *
			 * This used to be an empty `TODO`, which meant `connection.cancel()` returned the store to
			 * `Idle` and left the promise `connect()` was awaiting pending for good: an app doing
			 * `await connection.connect({type: 'email'})` and then offering a cancel button waited
			 * forever, holding the popup window open behind it.
			 *
			 * Rejects with `type: 'cancelation'`, which is what `connect` already reads to tell a
			 * cancellation (nothing to report) from a refusal (a reason the app must surface).
			 */
			cancel() {
				try {
					launchedWindow?.close();
				} catch (err) {
					console.error(err);
				}
				rejectRecovery({message: 'popup cancelled', type: 'cancelation'});
			},
		};

		const storePromise = createStorePromise<T, Popup, Readable<Popup> & {cancel: () => void}>(
			store,
			(resolve, reject) => {
				_resolveRecovery = resolve;
				_rejectRecovery = reject;
				id++;
				urlObject.searchParams.append('origin', window.origin);
				urlObject.searchParams.append('id', id.toString());
				const popupParameters = options?.fullWindow
					? ''
					: 'popup=1,scrollbars=0,menubar=0,location=0,resizable=0,status=0,titlebar=0,toolbar=0,width=500,height=700';

				console.log({popupParameters});
				const popup = window.open(urlObject.toString(), `${pathname}:${window.origin}`, popupParameters);
				if (!popup) {
					throw new Error(`could not open the login popup`);
				}
				launchedWindow = popup;
				currentPopup = {popup, onMessage, rejectRecovery: _rejectRecovery};
				console.log(`listening to message... ${id}`);
				window.addEventListener('message', currentPopup.onMessage);

				// Same-Origin Callback Bridge: listen on BroadcastChannel for the
				// encrypted result when the opener relationship was severed.
				if (options?.decryptKeyPair && typeof BroadcastChannel !== 'undefined') {
					channel = new BroadcastChannel('etherplay-connect');
					channel.onmessage = (event) => handleEncryptedResult(event.data, 'BroadcastChannel');
				}

				watchForPopupClosed(popup);
				// continuouslyPingPopup(popup);
			},
		);

		return storePromise;
	}

	return {launchPopup};
}
