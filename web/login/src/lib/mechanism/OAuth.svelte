<script lang="ts">
	import type {AuthProvider} from '@etherplay/connect-core';

	let {
		authProvider,
		continueAfterLogin,
		goingToRedirect,
		cancel,
	}: {
		authProvider: AuthProvider;
		continueAfterLogin?: () => void;
		goingToRedirect?: boolean;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	let popupRef: {contentWindow?: Window | null} | null = null;

	let provider = $derived(
		$authProvider && $authProvider.step === 'ConfirmOAuth' ? ($authProvider as any).provider || 'unknown' : 'unknown',
	);

	let usePopup = $derived(
		'mechanism' in $authProvider && $authProvider.mechanism?.type === 'oauth'
			? ($authProvider as any).mechanism?.usePopup !== false
			: true,
	);

	async function handleOAuthContinue() {
		const state = $authProvider;
		if (state?.step === 'ConfirmOAuth') {
			popupRef = window.open('', '_blank', 'width=600,height=600');
			if (popupRef?.contentWindow) {
				pollPopupForCallback();
			}
		}
	}

	function pollPopupForCallback() {
		if (!popupRef?.contentWindow) return;

		const checkCallback = () => {
			try {
				const popupUrl = popupRef?.contentWindow?.location.href;
				if (popupUrl && popupUrl.includes('/login/?type=oauth-redirect')) {
					connection.confirmOAuth();
					popupRef = null;
					return;
				}
			} catch {}
			setTimeout(checkCallback, 500);
		};
		setTimeout(checkCallback, 500);
	}
</script>

{#snippet logo(provider: string, animated: boolean)}
	{#if provider == 'google'}
		<picture>
			<img src="/google_logo.png" alt="Google Logo" class:animated />
		</picture>
	{:else if provider == 'facebook'}
		<picture>
			<img src="/Facebook_Logo_Primary.png" alt="Facebook Logo" class:animated />
		</picture>
	{:else if provider === 'twitter'}
		<picture>
			<source srcset="/x-logo-white.png" media="(prefers-color-scheme: dark)" />
			<img alt="X Logo" src="/x-logo-black.png" />
		</picture>
	{:else}
		<div>
			<p>{animated ? 'Please Wait....' : provider}</p>
			<hr />
		</div>
	{/if}
{/snippet}

<main>
	{#if !$authProvider || $authProvider.step === 'Idle'}
		{@render logo(provider, true)}
	{:else if $authProvider.step === 'ConfirmOAuth'}
		{@render logo(provider, false)}
		<div class="wrapper" style="margin-top: 5rem">
			<button onclick={handleOAuthContinue} type="submit">continue</button>
		</div>
	{:else if $authProvider.step === 'WaitingForOAuthResponse'}
		{@render logo(provider, true)}
	{:else if $authProvider.step === 'SignedIn'}
		<div class="wrapper">
			{#if $authProvider.result}
				{#if continueAfterLogin}
					<p>You are logged in!</p>
					<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
				{:else if goingToRedirect}
					<p>Please wait...</p>
				{:else}
					<p>Could not log you in, due to redirection failure</p>
					<button onclick={() => cancel()}>Return</button>
				{/if}
			{/if}
		</div>
	{:else if $authProvider.error}
		<p>Error: {$authProvider.error.message}</p>
		<button onclick={() => cancel()}>Return</button>
	{/if}
</main>

<style>
	main {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
	}

	main picture {
		max-width: min(30%, 128px);
		max-height: min(30%, 128px);
	}
	main img {
		width: 100%;
		height: 100%;
	}

	main img.animated {
		animation: pulse ease-in 1400ms infinite alternate;
	}

	.wrapper {
		display: flex;
		gap: 1rem;
		flex-direction: column;
		justify-content: center;
		align-items: center;
	}

	button {
		padding: 0.75rem 1rem;
		border: 0.0625rem solid black;
		border-radius: 0.25rem;
		outline: none;
		background-color: black;
		box-shadow: 0 0 0 rgba(0, 0, 0, 0);
		color: white;
		font-weight: 400;
		font-size: 1rem;
		line-height: 1.5;
		text-align: center;
		text-decoration: none;
		cursor: pointer;
		user-select: none;
		width: 100%;
		height: 50px;
		margin-bottom: 1rem;
	}

	.deny {
		border: 0.0625rem solid #c74a24;
		background-color: #c74a24;
		color: #fff;
	}

	@media (prefers-color-scheme: dark) {
		button {
			background-color: white;
			color: black;
		}
	}

	@keyframes pulse {
		50% {
			transform: scale(0.9);
		}
	}
</style>
