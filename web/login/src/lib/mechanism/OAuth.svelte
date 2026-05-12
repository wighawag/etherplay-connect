<script lang="ts">
	import type {UnifiedConnectionStore} from '../handler';

	let {
		connection,
		continueAfterLogin,
		goingToRedirect,
		cancel,
	}: {
		connection: UnifiedConnectionStore;
		continueAfterLogin?: () => void;
		goingToRedirect?: boolean;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	let popupRef: {contentWindow?: Window | null} | null = null;

	let provider = $derived(
		$connection && $connection.mechanism?.type === 'oauth'
			? ($connection.mechanism.provider || {id: 'unknown'})
			: ({id: 'unknown'} as const),
	);

	let usePopup = $derived(
		$connection && $connection.mechanism?.type === 'oauth'
			? ($connection.mechanism as any).usePopup !== false
			: true,
	);

	async function handleOAuthContinue() {
		const mechanism = $connection?.mechanism;
		if (!mechanism || mechanism.type !== 'oauth') return;

		const oauthMech = {
			type: 'oauth' as const,
			provider: mechanism.provider,
			usePopup: usePopup,
		};

		await connection.connect(oauthMech);

		if (usePopup) {
			const state = $connection;
			if (state?.step === 'ConfirmOAuth') {
				popupRef = window.open('', '_blank', 'width=600,height=600');
				if (popupRef?.contentWindow) {
					const oauthUrl = await getOAuthUrl();
					popupRef.contentWindow.location.href = oauthUrl;
				}
				pollPopupForCallback();
			}
		} else {
			const oauthUrl = await getOAuthUrl();
			window.location.href = oauthUrl;
		}
	}

	async function getOAuthUrl(): Promise<string> {
		const state = $connection;
		if (state?.step === 'ConfirmOAuth') {
			return new Promise((resolve) => {
				const checkSignedIn = () => {
					const s = $connection;
					if (s?.step === 'SignedIn') {
						resolve('');
					}
				};
				setTimeout(checkSignedIn, 100);
			});
		}
		return '';
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

{#snippet logo(
	provider: {id: string; connection?: string} | undefined,
	animated: boolean,
)}
	{#if provider?.id == 'google'}
		<picture>
			<img src="/google_logo.png" alt="Google Logo" class:animated />
		</picture>
	{:else if provider?.id == 'facebook'}
		<picture>
			<img src="/Facebook_Logo_Primary.png" alt="Facebook Logo" class:animated />
		</picture>
	{:else if provider?.id === 'twitter'}
		<picture>
			<source srcset="/x-logo-white.png" media="(prefers-color-scheme: dark)" />
			<img alt="X Logo" src="/x-logo-black.png" />
		</picture>
	{:else}
		<div>
			<p>{animated ? 'Please Wait....' : provider?.id}</p>
			<hr />
		</div>
	{/if}
{/snippet}

<main>
	{#if !$connection || $connection.step === 'Initialising' || $connection.step === 'Initialised' || $connection.step === 'InitialisingMechanism' || $connection.step === 'MechanismToChoose' || $connection.step === 'MechanismChosen' || $connection.step === 'GeneratingAccount'}
		{@render logo(provider, true)}
	{:else if $connection.step === 'ConfirmOAuth'}
		{@render logo(provider, false)}
		<div class="wrapper" style="margin-top: 5rem">
			<button onclick={handleOAuthContinue} type="submit">continue</button>
		</div>
	{:else if $connection.step === 'WaitingForOAuthResponse'}
		{@render logo(provider, true)}
	{:else if $connection.step === 'InitializingOAuthPopup'}
		{@render logo(provider, true)}
	{:else if $connection.step === 'SignedIn'}
		<div class="wrapper">
			{#if ($connection as any).requireOriginApproval}
				{#if ($connection as any).requireOriginApproval.requestingAccess}
					<p>
						{($connection as any).requireOriginApproval.windowOrigin} is requesting access to account from {($connection as any).requireOriginApproval.signingOrigin}
					</p>
					<button
						onclick={() => {
							connection.confirmOriginAccess();
							if (continueAfterLogin) {
								continueAfterLogin();
							}
						}}
						id="origin-accept"
						type="submit">Accept</button>
					<button class="deny" onclick={() => cancel()} id="origin-deny" type="submit">Deny</button>
				{:else if goingToRedirect}
					<p>Please wait...</p>
				{:else}
					<p>Could not log you in, due to redirection failure</p>
					<button onclick={() => cancel()}>Return</button>
				{/if}
			{:else if continueAfterLogin}
				<p>You are logged in!</p>
				<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
			{:else if goingToRedirect}
				<p>Please wait...</p>
			{:else}
				<p>Could not log you in, due to redirection failure</p>
				<button onclick={() => cancel()}>Return</button>
			{/if}
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
