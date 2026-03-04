<script lang="ts">
	import type {AlchemyConnectionStore} from '@etherplay/alchemy';
	import {debounce} from '../utils';
	import OTP from './components/OTP.svelte';
	import {Button} from '$lib/components/ui/button';
	import {Input} from '$lib/components/ui/input';
	import * as Card from '$lib/components/ui/card';
	import {Label} from '$lib/components/ui/label';

	let {
		alchemy,
		continueAfterLogin,
		goingToRedirect,
		cancel,
	}: {
		alchemy: AlchemyConnectionStore;
		goingToRedirect?: boolean;
		continueAfterLogin?: () => void;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	let otp: OTP | undefined = $state(undefined);
	let emailValue = $state('');

	let bundleURL: string | undefined = $state(undefined);

	async function _submitOTP(text: string) {
		console.log({otpCode: text});

		// TODO test
		try {
			await alchemy.provideOTP(text);
		} catch (error) {
			otp?.clear();
			return;
		}
	}
	export const submitOTP = debounce(_submitOTP, 500);

	async function onEmailChosen(ev: Event) {
		ev.preventDefault();
		const email = emailValue;
		if (!email) return;
		return loginViaEmail(email);
	}

	async function loginViaEmail(email: string, mode: 'otp' = 'otp') {
		await alchemy.connect({
			type: 'email',
			email,
			mode,
		});
	}
</script>

<main class="flex min-h-screen w-full max-w-[510px] flex-col items-center justify-between p-6">
	<!-- Mail Icon -->
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
			<rect width="20" height="16" x="2" y="4" rx="2" />
			<path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
		</svg>
	</div>

	<div class="flex flex-1 flex-col items-center justify-center w-full py-4">
		{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'InitialisingMechanism' || $alchemy.step === 'MechanismToChoose' || $alchemy.step === 'MechanismChosen'}
			<p class="text-lg text-muted-foreground">Please wait...</p>
		{:else if $alchemy.step === 'EmailToProvide'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Sign in via Email</Card.Title>
				</Card.Header>
				<Card.Content>
					<form onsubmit={onEmailChosen} class="space-y-4">
						<div class="space-y-2">
							<Label for="email">Email Address</Label>
							<Input
								id="email"
								type="email"
								name="email"
								placeholder="conan@catacombs.world"
								aria-label="email"
								autocomplete="email"
								required
								bind:value={emailValue}
								class="h-12 text-base"
							/>
						</div>
						<Button type="submit" size="lg" class="w-full">Login</Button>
					</form>
				</Card.Content>
			</Card.Root>
		{:else if $alchemy.step === 'WaitingForOTP'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Check your email</Card.Title>
					<Card.Description>
						Enter the 6-digit code we sent to <span class="font-medium text-foreground">{emailValue}</span>
					</Card.Description>
				</Card.Header>
				<Card.Content>
					<OTP bind:this={otp} onAcknowledge={() => {}} onCodeUpdated={submitOTP} />
				</Card.Content>
			</Card.Root>
		{:else if $alchemy.step === 'VerifyingOTP'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Verifying code...</Card.Title>
				</Card.Header>
				<Card.Content class="flex justify-center py-4">
					<div class="size-10 animate-spin rounded-full border-4 border-muted border-t-primary"></div>
				</Card.Content>
			</Card.Root>
		{:else if $alchemy.step === 'GeneratingAccount'}
			<Card.Root class="w-full max-w-sm border-0 shadow-md">
				<Card.Header class="text-center">
					<Card.Title class="text-xl">Email Verified</Card.Title>
					<Card.Description>Setting up your account...</Card.Description>
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
