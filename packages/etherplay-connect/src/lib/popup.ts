import { writable, type Readable } from 'svelte/store';
import { createStorePromise } from './utils.js';

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

export type PopupPromise<T> = ReturnType<
	typeof createStorePromise<T, Popup, Readable<Popup> & { cancel: () => void }>
>;

export function createPopupLauncher<T>() {
	let id = 1;
	let currentPopup:
		| {
				popup: Window;
				onMessage: (messageEvent: MessageEvent) => void;
				rejectRecovery: (error: Error) => void;
		  }
		| { popup: undefined } = { popup: undefined };

	function launchPopup(
		url: string,
		options?: { fullWindow?: boolean }
	): Promise<T> & Readable<Popup> & { cancel: () => void } {
		const urlObject = new URL(url);
		const expectedOrigin = `${urlObject.protocol}//${urlObject.host}`;
		const pathname = urlObject.pathname;

		let $popup: Popup = {
			closed: false,
			launched: false,
			resolved: false
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
			currentPopup = { popup: undefined };
			if (couldCloseExistingPopup) {
				tmpRejectRecovery({ message: 'popup closed so new one can take over' });
			} else {
				tmpRejectRecovery({ message: 'popup replaced' });
			}
		}

		let _resolveRecovery: (state: T) => void;
		let _rejectRecovery: (error: Error) => void;

		function resolveRecovery(state: T) {
			currentPopup = { popup: undefined };
			console.log(`stop listening to message as we resolved it`);
			window.removeEventListener('message', onMessage);

			if (_resolveRecovery) {
				set({
					closed: true,
					launched: true,
					resolved: true
				});
				_resolveRecovery(state);
			}
		}

		function rejectRecovery(error: Error) {
			currentPopup = { popup: undefined };
			console.log(`stop listening to message as we rejected it`, error);
			window.removeEventListener('message', onMessage);
			if (_rejectRecovery) {
				set({
					closed: true,
					launched: true,
					resolved: true,
					error: {
						message: 'errored',
						cause: error
					}
				});
				_rejectRecovery(error);
			}
		}

		const onMessage = (messageEvent: MessageEvent) => {
			if (messageEvent.origin === expectedOrigin) {
				console.log(messageEvent);
				const data = messageEvent.data;
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
									error: $popup.error
								});
							}
						}, 100);
					}
				} catch (err) {}
			}, 200);
		}

		const store = {
			subscribe: _store.subscribe,
			cancel() {
				// TODO
			}
		};

		const storePromise = createStorePromise<T, Popup, Readable<Popup> & { cancel: () => void }>(
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

				console.log({ popupParameters });
				const popup = window.open(
					urlObject.toString(),
					`${pathname}:${window.origin}`,
					popupParameters
				);
				if (!popup) {
					throw new Error(`could not open the login popup`);
				}
				currentPopup = { popup, onMessage, rejectRecovery: _rejectRecovery };
				console.log(`listening to message... ${id}`);
				window.addEventListener('message', currentPopup.onMessage);
				watchForPopupClosed(popup);
				// continuouslyPingPopup(popup);
			}
		);

		return storePromise;
	}

	return { launchPopup };
}
