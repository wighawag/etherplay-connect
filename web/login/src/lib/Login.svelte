<script lang="ts">
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Loading from './Loading.svelte';
	import {debug} from './state';
	import type {AuthProvider} from '@etherplay/connect-core';
	import Mnemonic from './mechanism/Mnemonic.svelte';
	import {
		deriveOriginAccount,
		generateEcdhKeyPair,
		importPublicKeyB64,
		deriveAesKey,
		bufToB64,
		exportPublicKeyB64,
	} from '@etherplay/connect-core';
	import type {AccountGenerator} from '@etherplay/wallet-connector';

	let {
		authProvider,
		accountGenerator,
		from,
	}: {
		authProvider: AuthProvider;
		accountGenerator: AccountGenerator;
		from: {
			source?: MessageEventSource;
			windowOrigin: string;
			signingOrigin: string;
			requestID: string;
			domainRedirectPublicKey?: string;
			canCloseAutomatically: boolean;
		};
	} = $props();

	function cancelOnClose() {
		_cancel();
	}

	// Same-Origin Callback Bridge: encrypt the result and redirect to the bridge
	// page on the parent's own origin (ECDH P-256 + AES-GCM, native Web Crypto).
	async function encryptAndRedirect(payload: any, parentPubB64: string, parentOrigin: string, requestId: string) {
		const parentPub = await importPublicKeyB64(parentPubB64);
		const ephemeral = await generateEcdhKeyPair();
		const aesKey = await deriveAesKey(ephemeral.privateKey, parentPub, ['encrypt']);

		const iv = window.crypto.getRandomValues(new Uint8Array(12));
		const ct = await window.crypto.subtle.encrypt(
			{name: 'AES-GCM', iv},
			aesKey,
			new TextEncoder().encode(JSON.stringify(payload)),
		);

		const dataB64 = bufToB64(ct);
		const ivB64 = bufToB64(iv);
		const ephPubB64 = await exportPublicKeyB64(ephemeral.publicKey);

		// Testing aid: forward `forceBroadcastChannel` (if present on the popup URL)
		// to the bridge page as a query param so it can skip the opener path.
		const forceBroadcastChannel = new URL(location.href).searchParams.get('forceBroadcastChannel');
		const query = forceBroadcastChannel !== null ? `?forceBroadcastChannel=${encodeURIComponent(forceBroadcastChannel)}` : '';

		window.location.href =
			`${parentOrigin}/_etherplay_accounts.html${query}` +
			`#data=${encodeURIComponent(dataB64)}` +
			`&iv=${encodeURIComponent(ivB64)}` +
			`&pubKey=${encodeURIComponent(ephPubB64)}` +
			`&id=${encodeURIComponent(requestId)}`;
	}

	let cancelOnCloseEnabled = false;
	function enableCancelOnClose() {
		if (!cancelOnCloseEnabled) {
			window.addEventListener('beforeunload', cancelOnClose);
			cancelOnCloseEnabled = true;
		}
	}
	function disableCancelOnClose() {
		if (cancelOnCloseEnabled) {
			window.removeEventListener('beforeunload', cancelOnClose);
			cancelOnCloseEnabled = false;
		}
	}

	function onMessage(event: MessageEvent) {
		try {
			console.log('ping?', event.origin, event.source, event.data);
		} catch (err) {
			console.log(`error getting event`);
		}

		if (!from.source && event.origin === from.windowOrigin) {
			from.source = event.source || undefined;
		}
	}

	onMount(() => {
		enableCancelOnClose();
		const unsubscribeFromAuthProvider = authProvider.subscribe(async (v) => {
			if (v?.step == 'WaitingForOAuthResponse') {
				disableCancelOnClose();
			} else if (v?.step === 'SignedIn') {
				if (!v.requireOriginApproval || !v.requireOriginApproval.requestingAccess) {
					// Delivery is opportunistic: try the direct opener first; only if the
					// opener was severed AND a domain-redirect-public-key is present do we
					// fall back to the encrypted same-origin bridge.
					// Gate on `from.source` only: that is the exact reference
					// `postResultIfNotAlreadyPosted` posts through (it throws without it),
					// so "I think I can deliver" matches "I actually can deliver".
					const openerAlive = !!(from.source && !(from.source as Window).closed);

					if (openerAlive) {
						// Happy path: link survived. Use the existing postMessage delivery.
						postResultIfNotAlreadyPosted(from.canCloseAutomatically);
					} else if (from.domainRedirectPublicKey) {
						// Opener severed: fall back to the encrypted same-origin bridge.
						const result = await deriveOriginAccount(from.signingOrigin, v.account, accountGenerator);
						await encryptAndRedirect(
							result,
							from.domainRedirectPublicKey,
							from.windowOrigin,
							from.requestID,
						);
					} else {
						// No opener and no bridge configured: keep existing behavior
						// (will surface the closed-popup UX on the parent side).
						postResultIfNotAlreadyPosted(from.canCloseAutomatically);
					}
				}
			}
		});

		let closed = false;
		window.addEventListener('message', onMessage);
		const sourceTimeoutId = setTimeout(() => {
			if (!from.source) {
				//TODO
				// authProvider.setError({message: 'timeout waiting for source'});
				// TODO allow to cancel flow
			}
			if (!closed) {
				window.removeEventListener('message', onMessage);
			}
		}, 10000);

		return () => {
			clearTimeout(sourceTimeoutId);
			closed = true;
			window.removeEventListener('message', onMessage);
			disableCancelOnClose();
			unsubscribeFromAuthProvider();
		};
	});

	function acknowledgeError() {
		// TODO
		// alchemy.acknowledgeError();
	}

	async function continueAfterLogin() {
		if ($authProvider.step !== 'SignedIn') {
			throw new Error(`not signed in`);
		}

		if ($authProvider.requireOriginApproval && $authProvider.requireOriginApproval.requestingAccess) {
			throw new Error(`origin not approved`);
		}
		await postResultIfNotAlreadyPosted();
		if (debug) {
			console.log('please close manually, in debug mode, we keep it open.');
		} else {
			window.close();
		}

		// setTimeout(() => window.close(), 300);
	}

	let resultPosted = false;
	async function postResultIfNotAlreadyPosted(closeWindow = false) {
		if (!from.source) {
			throw new Error(`no source`);
		}

		// TODO option ?
		// again should not be handled in openfort specific provider
		// saveEtherplayAccount(etherplayAccount);

		if (!resultPosted) {
			try {
				if ($authProvider.step === 'SignedIn') {
					const result = await deriveOriginAccount(from.signingOrigin, $authProvider.account, accountGenerator);
					if (debug) {
						console.log('postMessage', {result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					}
					from.source.postMessage({result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					resultPosted = true;
				} else {
					throw new Error(`invalid step: ${$authProvider.step}`);
				}
			} catch (e) {
				// TODO
				console.error(e);
			}
		}
		if (closeWindow) {
			window.close();
		}
	}

	function _cancel(error?: any) {
		if (!from.source) {
			window.close();
			return;
		}
		if (error) {
			if (debug) {
				console.log('postMessage', {error, id: from.requestID}, from.windowOrigin);
			}
			from.source.postMessage({error, id: from.requestID}, {targetOrigin: from.windowOrigin});
		} else {
			if (debug) {
				console.log(
					'postMessage',
					{
						error: {message: 'canceled', type: 'cancelation'},
						id: from.requestID,
					},
					from.windowOrigin,
				);
			}
			from.source.postMessage(
				{error: {message: 'canceled', type: 'cancelation'}, id: from.requestID},
				{targetOrigin: from.windowOrigin},
			);
		}
	}
	async function cancel(error: any) {
		_cancel(error);
		window.close();
	}
</script>

<div class="root">
	<!-- TODO -->
	<!-- {#if $authProvider?.error && !$authProvider.error.delay} -->
	{#if $authProvider.error}
		<div class="banner">
			<p>{$authProvider.error.message}</p>
			<!-- {#if !$authProvider.error.timeout}
				<button onclick={() => acknowledgeError()} id="error-acknowledge">ok</button>
			{/if} -->
		</div>
	{/if}
	{#if $authProvider.step === 'Initialised' || $authProvider.step === 'Initialising' || $authProvider.step === 'Idle'}
		<Loading />
	{:else if $authProvider.step === 'MechanismToChoose'}
		<!-- TODO? -->
		<main>
			<p>Not Supported</p>
		</main>
	{:else if $authProvider.mechanism.type == 'email'}
		<Email
			{authProvider}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $authProvider.mechanism.type == 'oauth'}
		<OAuth
			{authProvider}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $authProvider.mechanism.type == 'mnemonic'}
		<Mnemonic
			{authProvider}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else}
		<main>
			<p>{$authProvider.step}</p>
		</main>
	{/if}
</div>

<style>
	main {
		padding: 16px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-height: 100vh;
		max-width: 510px;
	}

	p {
		color: #222222;
		font-size: 1.5rem;
		margin-block: 1rem;
		font-weight: 400;
	}

	.root {
		width: 100%;
		height: 100%;
		line-height: 1.5;
		font-family: system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, 'Helvetica Neue',
			sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
		display: flex;
		justify-content: center;
	}

	.banner {
		padding: 1rem;
		position: absolute;
		width: 100%;
		opacity: 0.9;
		display: flex;
		justify-content: space-between;

		background-color: #d93526;
		> p {
			color: white;
			font-size: 1rem;
		}
	}
</style>
