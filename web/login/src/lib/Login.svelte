<script lang="ts">
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Loading from './Loading.svelte';
	import {debug} from './state';
	import type {ConnectionStore} from './handler';

	let {
		connection,
		from,
	}: {
		connection: ConnectionStore;
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

		let closed = false;
		window.addEventListener('message', onMessage);
		const sourceTimeoutId = setTimeout(() => {
			if (!from.source) {
			}
			if (!closed) {
				window.removeEventListener('message', onMessage);
			}
		}, 10000);

		connection?.subscribe((v) => {
			if (v?.step === 'SignedIn') {
				if (from.domainRedirectPublicKey) {
				} else {
					if (!v.requireOriginApproval || (v.requireOriginApproval && !v.requireOriginApproval.requestingAccess)) {
						postResultIfNotAlreadyPosted(from.canCloseAutomatically);
					}
				}
			}
		});

		return () => {
			clearTimeout(sourceTimeoutId);
			closed = true;
			window.removeEventListener('message', onMessage);
			disableCancelOnClose();
		};
	});

	async function continueAfterLogin() {
		if ($connection?.step !== 'SignedIn') {
			throw new Error(`not signed in`);
		}

		if ($connection.requireOriginApproval && $connection.requireOriginApproval.requestingAccess) {
			throw new Error(`origin not approved`);
		}
		await postResultIfNotAlreadyPosted();
		if (debug) {
			console.log('please close manually, in debug mode, we keep it open.');
		} else {
			window.close();
		}
	}

	let resultPosted = false;
	async function postResultIfNotAlreadyPosted(closeWindow = false) {
		if (!from.source) {
			throw new Error(`no source`);
		}
		if (!resultPosted) {
			try {
				if ($connection?.step === 'SignedIn' && $connection.result) {
					const result = await connection.generateOriginAccount(from.signingOrigin, $connection.result);
					if (debug) {
						console.log('postMessage', {result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					}
					from.source.postMessage({result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					resultPosted = true;
				} else {
					throw new Error(`invalid step: ${$connection?.step}`);
				}
			} catch (e) {
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
	{#if $connection?.step === 'Error'}
		<div class="banner">
			<p>{$connection.message}</p>
		</div>
	{/if}
	{#if !$connection || ($connection.step !== 'EmailToProvide' && $connection.step !== 'WaitingForOTP' && $connection.step !== 'VerifyingOTP' && $connection.step !== 'ConfirmOAuth' && $connection.step !== 'WaitingForOAuthResponse' && $connection.step !== 'GeneratingAccount' && $connection.step !== 'SignedIn')}
		<Loading />
	{:else if $connection.step === 'WaitingForOTP' || $connection.step === 'VerifyingOTP'}
		<Email
			connection={connection!}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $connection.step === 'ConfirmOAuth' || $connection.step === 'WaitingForOAuthResponse'}
		<OAuth
			connection={connection!}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $connection.step === 'SignedIn'}
		{#if $connection.result}
			{#if false}
				<!-- requireOriginApproval is not in AuthState, handled by mechanism components -->
				<p>Waiting for origin approval...</p>
			{:else if from.source}
				<p>You are logged in!</p>
				<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
			{:else}
				<p>Could not log you in, due to redirection failure</p>
				<button onclick={() => cancel('redirection failure')}>Return</button>
			{/if}
		{/if}
	{:else}
		<main>
			<p>{$connection.step}</p>
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
