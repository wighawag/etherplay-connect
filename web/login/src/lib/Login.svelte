<script lang="ts">
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Loading from './Loading.svelte';
	import {debug} from './state';
	import type {AuthProvider} from '@etherplay/connect-core';
	import Mnemonic from './mechanism/Mnemonic.svelte';

	let {
		authProvider,
		from,
	}: {
		authProvider: AuthProvider;
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
		const unsubscribeFromAuthProvider = authProvider.subscribe((v) => {
			if (v?.step == 'WaitingForOAuthResponse') {
				disableCancelOnClose();
			} else if (v?.step === 'SignedIn') {
				if (from.domainRedirectPublicKey) {
					// TODO encrypt
					window.location.href = `${from.windowOrigin}/_etherplay_accounts.html#myencryptedresult`;
				} else {
					if (!v.requireOriginApproval || (v.requireOriginApproval && !v.requireOriginApproval.requestingAccess)) {
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
		if (!resultPosted) {
			try {
				if ($authProvider.step === 'SignedIn') {
					// TODO
					const result = await authProvider.generateOriginAccount(from.signingOrigin, $authProvider.account);
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
