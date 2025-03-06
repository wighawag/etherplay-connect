<script lang="ts">
	import type {AlchemyConnectionStore} from '@etherplay/alchemy';

	let {
		alchemy,
		continueAfterLogin,
		goingToRedirect,
		cancel,
	}: {
		alchemy: AlchemyConnectionStore;
		continueAfterLogin?: () => void;
		goingToRedirect?: boolean;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	async function pickAccount(index: number) {
		await alchemy.provideMnemonicIndex(index);
	}
</script>

<main>
	<!-- Do not add link as this would disturb the flow -->
	<div class="logo">
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="128"
			height="128"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="lucide lucide-venetian-mask"
			><path d="M18 11c-1.5 0-2.5.5-3 2" /><path
				d="M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z"
			/><path d="M6 11c1.5 0 2.5.5 3 2" /></svg
		>
	</div>

	<div>
		{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'InitialisingMechanism' || $alchemy.step === 'MechanismToChoose' || $alchemy.step === 'MechanismChosen'}
			<h1>Please wait...</h1>
		{:else if $alchemy.step === 'MnemonicIndexToProvide'}
			<h1>Pick an Account</h1>
			<div class="container">
				{#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as i}
					<button onclick={() => pickAccount(i)} id={`account-${i}`}>{i}</button>
				{/each}
			</div>
		{:else if $alchemy.step === 'GeneratingAccount'}
			<p>Please wait...</p>
			<hr />
		{:else if $alchemy.step === 'SignedIn'}
			{#if continueAfterLogin}
				<p>You are logged in!</p>
				<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
			{:else if goingToRedirect}
				<!-- TODO timeout-->
				<p>Please wait...</p>
			{:else}
				<p>Could not log you in, due to redirection failure</p>
			{/if}
		{/if}
	</div>

	<div></div>
</main>

<style>
	main {
		padding: 16px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-height: 100vh;
		max-width: 510px;
	}

	hr {
		border: 4px solid #eeeeee;
	}

	@media (prefers-color-scheme: dark) {
		hr {
			border: 4px solid #202632;
		}
	}

	h1 {
		font-size: max(min(5vw, 2rem), 1.5rem);
		color: #222222;
		font-weight: 700;
		line-height: 1.125;
		margin-bottom: 1rem;
	}

	@media (prefers-color-scheme: dark) {
		h1 {
			color: #f0f1f3;
		}
	}

	button {
		padding: 0.75rem 1rem;
		border: 0.0625rem solid #524ed2;
		border-radius: 0.25rem;
		outline: none;
		background-color: #524ed2;
		box-shadow: 0 0 0 rgba(0, 0, 0, 0);
		color: #fff;
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

	p {
		color: #222222;
		font-size: 1.5rem;
		margin-block: 1rem;
		font-weight: 400;
	}

	@media (prefers-color-scheme: dark) {
		p {
			color: #c2c7d0;
		}
	}

	.logo {
		width: 100%;
		max-width: 100%;
		display: flex;
		justify-content: center;
		gap: 0.5rem;
		padding: 0.3rem;
		align-items: center;
		font-size: max(min(10vw, 3rem), 1rem);
		font-family: Audiowide;
		text-decoration: none;
		color: #222222;
	}

	@media (prefers-color-scheme: dark) {
		.logo {
			color: #ffffff;
		}
	}

	.container {
		display: grid;
		grid-template-columns: 1fr 1fr 1fr;
		grid-template-rows: 1fr 1fr 1fr;
		gap: 3px 3px;
		grid-template-areas:
			'. . .'
			'. . .'
			'. . .';
	}
</style>
