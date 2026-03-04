<script lang="ts">
	import type {AlchemyConnectionStore} from '@etherplay/alchemy';
	import {Button} from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

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
	<div class="flex items-center justify-center">
		{#if provider?.id == 'google'}
			<img src="/google_logo.png" alt="Google Logo" class="max-w-36 max-h-36" class:animate-pulse={animated} />
		{:else if provider?.id == 'facebook'}
			<img src="/Facebook_Logo_Primary.png" alt="Facebook Logo" class="max-w-36 max-h-36" class:animate-pulse={animated} />
		{:else if provider?.id === 'auth0' && provider.connection === 'twitter'}
			<picture>
				<source srcset="/x-logo-white.png" media="(prefers-color-scheme: dark)" />
				<img alt="X Logo" src="/x-logo-white.png" class="max-w-36 max-h-36" class:animate-pulse={animated} />
			</picture>
		{:else}
			<p class="text-lg text-muted-foreground">
				{animated ? 'Please Wait...' : provider?.id == 'auth0' ? provider.connection : provider}
			</p>
		{/if}
	</div>
{/snippet}

<main class="flex min-h-screen w-full flex-col items-center justify-center p-6">
	{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'InitialisingMechanism' || $alchemy.step === 'MechanismToChoose' || $alchemy.step === 'MechanismChosen' || $alchemy.step === 'GeneratingAccount'}
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'ConfirmOAuth'}
		{@render logo(provider, false)}
		<Card.Root class="mt-8 w-full max-w-sm border-0 shadow-md">
			<Card.Content class="pt-6">
				<Button
					onclick={() => alchemy.connect({type: 'oauth', provider, usePopup: true})}
					size="lg"
					class="w-full"
				>
					Continue
				</Button>
			</Card.Content>
		</Card.Root>
	{:else if $alchemy.step === 'WaitingForOAuthResponse'}
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'InitializingOAuthPopup'}
		{@render logo(provider, true)}
	{:else if $alchemy.step === 'SignedIn'}
		{@render logo(provider, false)}
		<Card.Root class="mt-8 w-full max-w-sm border-0 shadow-md">
			{#if $alchemy.requireOriginApproval}
				{#if $alchemy.requireOriginApproval.requestingAccess}
					<Card.Header class="text-center">
						<Card.Title class="text-xl">Access Request</Card.Title>
						<Card.Description>
							<span class="text-primary">{$alchemy.requireOriginApproval.windowOrigin}</span> is requesting access to your account
						</Card.Description>
					</Card.Header>
					<Card.Content class="space-y-3">
						<Button
							onclick={() => {
								alchemy.confirmOriginAccess();
								if (continueAfterLogin) {
									continueAfterLogin();
								}
							}}
							id="origin-accept"
							size="lg"
							class="w-full"
						>
							Accept
						</Button>
						<Button
							onclick={() => cancel()}
							id="origin-deny"
							variant="destructive"
							size="lg"
							class="w-full"
						>
							Deny
						</Button>
					</Card.Content>
				{:else if goingToRedirect}
					<Card.Header class="text-center">
						<Card.Title class="text-xl">Please wait...</Card.Title>
					</Card.Header>
					<Card.Content class="flex justify-center py-4">
						<div class="size-10 animate-spin rounded-full border-4 border-muted border-t-primary"></div>
					</Card.Content>
				{:else}
					<Card.Header class="text-center">
						<Card.Title class="text-xl text-destructive">Redirection Failed</Card.Title>
					</Card.Header>
					<Card.Content>
						<Button onclick={() => cancel()} size="lg" class="w-full">Return</Button>
					</Card.Content>
				{/if}
			{:else if continueAfterLogin}
				<Card.Header class="text-center">
					<Card.Title class="text-xl">You're logged in!</Card.Title>
				</Card.Header>
				<Card.Content>
					<Button onclick={continueAfterLogin} id="continue-submit" size="lg" class="w-full">Continue</Button>
				</Card.Content>
			{:else if goingToRedirect}
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Please wait...</Card.Title>
				</Card.Header>
				<Card.Content class="flex justify-center py-4">
					<div class="size-10 animate-spin rounded-full border-4 border-muted border-t-primary"></div>
				</Card.Content>
			{:else}
				<Card.Header class="text-center">
					<Card.Title class="text-xl text-destructive">Redirection Failed</Card.Title>
				</Card.Header>
				<Card.Content>
					<Button onclick={() => cancel()} size="lg" class="w-full">Return</Button>
				</Card.Content>
			{/if}
		</Card.Root>
	{/if}
</main>
