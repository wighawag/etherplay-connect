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

	async function pickAccount(index: number) {
		await alchemy.provideMnemonicIndex(index);
	}
</script>

<main class="flex min-h-screen w-full max-w-[510px] flex-col items-center justify-between p-6">
	<!-- Mask Icon -->
	<div class="flex w-full justify-center py-8">
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="80"
			height="80"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linecap="round"
			stroke-linejoin="round"
			class="text-muted-foreground"
		>
			<path d="M18 11c-1.5 0-2.5.5-3 2" />
			<path d="M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z" />
			<path d="M6 11c1.5 0 2.5.5 3 2" />
		</svg>
	</div>

	<div class="flex flex-1 flex-col items-center justify-center w-full py-4">
		{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'InitialisingMechanism' || $alchemy.step === 'MechanismToChoose' || $alchemy.step === 'MechanismChosen'}
			<p class="text-lg text-muted-foreground">Please wait...</p>
		{:else if $alchemy.step === 'MnemonicIndexToProvide'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Pick an Account</Card.Title>
					<Card.Description>Select which account to use</Card.Description>
				</Card.Header>
				<Card.Content>
					<div class="grid grid-cols-3 gap-3">
						{#each [0, 1, 2, 3, 4, 5, 6, 7, 8] as i}
							<Button
								onclick={() => pickAccount(i)}
								id={`account-${i}`}
								variant="outline"
								class="h-16 text-xl"
							>
								{i}
							</Button>
						{/each}
					</div>
				</Card.Content>
			</Card.Root>
		{:else if $alchemy.step === 'GeneratingAccount'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Generating Account...</Card.Title>
				</Card.Header>
				<Card.Content class="flex justify-center py-4">
					<div class="size-10 animate-spin rounded-full border-4 border-muted border-t-primary"></div>
				</Card.Content>
			</Card.Root>
		{:else if $alchemy.step === 'SignedIn'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
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
	</div>

	<div class="h-8"></div>
</main>
