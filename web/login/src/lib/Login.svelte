<script lang="ts">
	import type {AlchemyConnectionStore} from 'etherplay-alchemy';
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Mnemonic from './mechanism/Mnemonic.svelte';
	import Idle from './Idle.svelte';
	import {get} from 'svelte/store';
	import Loading from './Loading.svelte';

	let {
		alchemy,
		from,
	}: {alchemy: AlchemyConnectionStore; from: {source?: MessageEventSource; origin: string; requestID: string}} =
		$props();

	// TODO
	let debug = false;

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

		if (!from.source && event.origin === from.origin) {
			from.source = event.source || undefined;
		}
	}

	onMount(() => {
		enableCancelOnClose();
		const unsubscribeFromAlchemyService = alchemy.subscribe((v) => {
			if (v?.step == 'WaitingForOAuthResponse') {
				disableCancelOnClose();
			}
		});

		let closed = false;
		window.addEventListener('message', onMessage);
		const sourceTimeoutId = setTimeout(() => {
			if (!from.source) {
				//TODO
				// alchemy.setError({message: 'timeout waiting for source'});
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
			unsubscribeFromAlchemyService();
		};
	});

	function acknowledgeError() {
		// TODO
		// alchemy.acknowledgeError();
	}

	async function continueAfterLogin() {
		postResultIfNotAlreadyPosted();
		if (debug) {
			console.log('please close manually, in debug mode, we keep it open.');
		} else {
			window.close();
		}

		// setTimeout(() => window.close(), 300);
	}

	let resultPosted = false;
	function postResultIfNotAlreadyPosted() {
		if (!from.source) {
			throw new Error(`no source`);
		}
		if (!resultPosted) {
			try {
				const state = get(alchemy);
				if (state?.step === 'SignedIn') {
					// TODO
					const result = alchemy.generateOriginAccount(origin, state.account);
					// if (debug) {
					// 	console.log('postMessage', {result, id: requestID}, orig);
					// }
					from.source.postMessage({result, id: from.requestID}, {targetOrigin: from.origin});
					resultPosted = true;
				} else {
					throw new Error(`invalid step: ${state?.step}`);
				}
			} catch (e) {
				// TODO
				console.error(e);
			}
		}
	}

	function _cancel(error?: any) {
		if (!from.source) {
			throw new Error(`no source`);
		}
		if (error) {
			if (debug) {
				console.log('postMessage', {error, id: from.requestID}, from.origin);
			}
			from.source.postMessage({error, id: from.requestID}, {targetOrigin: from.origin});
		} else {
			if (debug) {
				console.log(
					'postMessage',
					{
						error: {message: 'canceled', type: 'cancelation'},
						id: from.requestID,
					},
					from.origin,
				);
			}
			from.source.postMessage(
				{error: {message: 'canceled', type: 'cancelation'}, id: from.requestID},
				{targetOrigin: from.origin},
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
	<!-- {#if $alchemy?.error && !$alchemy.error.delay} -->
	{#if $alchemy?.error}
		<div class="banner">
			<p>{$alchemy.error.message}</p>
			<!-- {#if !$alchemy.error.timeout}
				<button onclick={() => acknowledgeError()} id="error-acknowledge">ok</button>
			{/if} -->
		</div>
	{/if}
	{#if !$alchemy || $alchemy.step === 'Initialised' || $alchemy.step === 'Initialising'}
		<Loading />
	{:else if $alchemy.step === 'MechanismToChoose'}
		<!-- TODO? -->
		<main>
			<p>Not Supported</p>
		</main>
	{:else if $alchemy.mechanism.type == 'email'}
		<Email {alchemy} {continueAfterLogin} {cancel} />
	{:else if $alchemy.mechanism.type == 'oauth'}
		<OAuth {alchemy} {continueAfterLogin} {cancel} />
	{:else if $alchemy.mechanism.type == 'mnemonic'}
		<Mnemonic {alchemy} {continueAfterLogin} {cancel} />
	{:else}
		<main>
			<p>{$alchemy.step}</p>
		</main>
	{/if}
	<!-- TODO more ?-->
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

		background-color: #d93526; /* #d93526; */
		> p {
			color: white;
			font-size: 1rem;
		}
	}
</style>
