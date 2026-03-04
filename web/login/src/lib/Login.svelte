<script lang="ts">
	import type {AlchemyConnectionStore} from '@etherplay/alchemy';
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Mnemonic from './mechanism/Mnemonic.svelte';
	import {get} from 'svelte/store';
	import Loading from './Loading.svelte';
	import {debug} from './state';

	let {
		alchemy,
		from,
	}: {
		alchemy: AlchemyConnectionStore;
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

		alchemy.subscribe((v) => {
			if (v?.step === 'SignedIn') {
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
		if ($alchemy?.step !== 'SignedIn') {
			throw new Error(`not signed in`);
		}

		if ($alchemy.requireOriginApproval && $alchemy.requireOriginApproval.requestingAccess) {
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
				const state = get(alchemy);
				if (state?.step === 'SignedIn') {
					// TODO
					const result = await alchemy.generateOriginAccount(from.signingOrigin, state.account);
					if (debug) {
						console.log('postMessage', {result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					}
					from.source.postMessage({result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					resultPosted = true;
				} else {
					throw new Error(`invalid step: ${state?.step}`);
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

<!-- Error Banner -->
{#if $alchemy?.error}
	<div class="fixed inset-x-0 top-0 z-50 flex justify-center bg-destructive px-4 py-3">
		<div class="flex max-w-[510px] w-full items-center gap-3">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="shrink-0 text-destructive-foreground"
			>
				<circle cx="12" cy="12" r="10" />
				<line x1="12" x2="12" y1="8" y2="12" />
				<line x1="12" x2="12.01" y1="16" y2="16" />
			</svg>
			<p class="text-sm font-medium text-destructive-foreground">{$alchemy.error.message}</p>
		</div>
	</div>
{/if}

{#if !$alchemy || $alchemy.step === 'Initialised' || $alchemy.step === 'Initialising'}
	<Loading />
{:else if $alchemy.step === 'MechanismToChoose'}
	<main class="flex min-h-screen max-w-[510px] flex-col items-center justify-center p-4">
		<p class="text-lg text-muted-foreground">Not Supported</p>
	</main>
{:else if $alchemy.mechanism.type == 'email'}
	<Email
		{alchemy}
		goingToRedirect={!!from.domainRedirectPublicKey}
		continueAfterLogin={from.source ? continueAfterLogin : undefined}
		{cancel}
	/>
{:else if $alchemy.mechanism.type == 'oauth'}
	<OAuth
		{alchemy}
		goingToRedirect={!!from.domainRedirectPublicKey}
		continueAfterLogin={from.source ? continueAfterLogin : undefined}
		{cancel}
	/>
{:else if $alchemy.mechanism.type == 'mnemonic'}
	<Mnemonic
		{alchemy}
		goingToRedirect={!!from.domainRedirectPublicKey}
		continueAfterLogin={from.source ? continueAfterLogin : undefined}
		{cancel}
	/>
{:else}
	<main class="flex min-h-screen max-w-[510px] flex-col items-center justify-center p-4">
		<p class="text-lg text-muted-foreground">{$alchemy.step}</p>
	</main>
{/if}
