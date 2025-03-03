<script lang="ts">
	import type {AlchemyConnectionStore} from 'etherplay-alchemy';

	let {
		alchemy,
		continueAfterLogin,
		cancel,
	}: {
		alchemy: AlchemyConnectionStore;
		continueAfterLogin: () => void;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	let provider = $derived(
		$alchemy && 'mechanism' in $alchemy && $alchemy.mechanism.type === 'oauth'
			? $alchemy.mechanism.provider
			: ({id: 'auth0', connection: 'unknown'} as const),
	);
</script>

{#snippet logo(
	provider: {id: 'auth0'; connection: string} | {id: 'google' | 'facebook'} | undefined,
	animated: boolean,
)}
	{#if provider?.id == 'google'}
		<img src="/google_logo.png" alt="Google Logo" class:animated />
	{:else if provider?.id == 'facebook'}
		<img src="/Facebook_Logo_Primary.png" alt="Facebook Logo" class:animated />
		<!-- {:else if typeof provider === 'object' && provider.type === 'auth0'}
		<img src="/github-mark.png" alt="Github Logo" class:animated /> -->
	{:else}
		<div>
			<p>{animated ? 'Please Wait....' : provider?.id == 'auth0' ? provider.connection : provider}</p>
			<hr />
		</div>
	{/if}
{/snippet}

<main>
	{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'MechanismToChoose'}
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'ConfirmOAuth'}
		{@render logo(provider, false)}
		<div class="wrapper" style="margin-top: 5rem">
			<button onclick={() => alchemy.connect({type: 'oauth', provider, usePopup: true})} type="submit">continue</button>
		</div>
	{:else if $alchemy.step === 'WaitingForOAuthResponse'}
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'InitializingOAuthPopup'}
		<!-- <div>
			<p>Logging in, Please wait...</p>
			<hr />
		</div> -->
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'SignedIn'}
		<div class="wrapper">
			<p>You are logged in!</p>
			<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
		</div>
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

	main > img {
		max-width: min(30%, 128px);
		max-height: min(30%, 128px);
	}

	main > img.animated {
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
