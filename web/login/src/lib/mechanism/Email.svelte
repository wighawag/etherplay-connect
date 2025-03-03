<script lang="ts">
	import type {AlchemyConnectionStore} from 'etherplay-alchemy';
	import {debounce} from '../utils';
	import OTP from './components/OTP.svelte';

	let {
		alchemy,
		continueAfterLogin,
		cancel,
	}: {
		alchemy: AlchemyConnectionStore;
		continueAfterLogin: () => void;
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();

	let otp: OTP | undefined = $state(undefined);

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

	// TODO
	// async function injectBundle(ev: Event) {
	// 	ev.preventDefault();

	// 	if (bundleURL === undefined) {
	// 		// TODO error
	// 		// alchemy.setError({message: 'no url provided', timeout: 3});
	// 		return;
	// 	}

	// 	const signingState = await alchemy.injectBundle(bundleURL);
	// 	if (signingState.error) {
	// 		console.error(signingState.error);
	// 	}
	// }

	async function onEmailChosen(ev: Event) {
		ev.preventDefault();
		// TODO
		// if ($alchemy?.mechanism?.type != 'email') {
		// 	// TODO
		// 	// alchemy.setError({message: 'expected email'});
		// 	return;
		// }
		// if ($alchemy.mechanismUsed.mode == 'saved') {
		// 	alchemy.setError({message: 'cannot used saved here'});
		// 	return;
		// }
		const emailInput = document.getElementById('email');
		const email = (emailInput as any).value;

		return loginViaEmail(email);
	}

	async function loginViaEmail(email: string, mode: 'otp' = 'otp') {
		// TODO 'magicLink' |
		await alchemy.connect({
			type: 'email',
			email,
			mode,
		});
	}
</script>

<main>
	<!-- Do not add link as this would disturb the flow -->
	<div class="logo">
		<!-- <img src="/logo_wide_with_text_on_black.svg" alt="Etherplay logo" /> -->
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
			class="lucide lucide-mail"
			><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg
		>
	</div>

	<div>
		{#if !$alchemy || $alchemy.step === 'Initialising' || $alchemy.step === 'Initialised' || $alchemy.step === 'MechanismToChoose'}
			<h1>Please wait...</h1>
		{:else if $alchemy.step === 'EmailToProvide'}
			<h1>Sign in via Email</h1>
			<form>
				<input
					id="email"
					type="email"
					name="email"
					placeholder="conan@catacombs.world"
					aria-label="email"
					autocomplete="email"
					required
				/>
				<small id="email-info" style="display: none">Invalid Email</small>
				<button onclick={onEmailChosen} id="login-submit" type="submit">Login</button>
			</form>
			<!-- TODO -->
			<!-- {:else if $alchemy.step === 'WaitingForMagicLinkVerification'}
			<p>You should shortly receive an email containing a link to click.</p>
			<hr />

			<p style="font-size: 1rem">You can also paste that link here:</p>
			<fieldset>
				<input autocomplete="off" bind:value={bundleURL} type="text" />
				<button onclick={injectBundle} id="bundle-inject" type="submit">proceed</button>
			</fieldset> -->
		{:else if $alchemy.step === 'WaitingForOTP'}
			<p>You should shortly receive an email containing a code.</p>
			<p id="WaitingForOTPVerification:message"></p>
			<hr />

			<p style="font-size: 1rem">Paste it here.</p>
			<!-- TODO -->
			<!-- <OTP bind:this={otp} onAcknowledge={() => alchemy.acknowledgeError()} onCodeUpdated={submitOTP} /> -->
			<OTP bind:this={otp} onAcknowledge={() => {}} onCodeUpdated={submitOTP} />
			<!-- <button id="verify-btn">Verify OTP</button> -->
		{:else if $alchemy.step === 'VerifyingOTP'}
			<p>Verifying OTP...</p>
			<hr />
		{:else if $alchemy.step === 'GeneratingAccount'}
			<p>Email Verified, Please wait...</p>
			<hr />
		{:else if $alchemy.step === 'SignedIn'}
			<p>You are logged in!</p>
			<button onclick={continueAfterLogin} id="continue-submit" type="submit">continue</button>
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

	input {
		border: 0.0625rem solid #aaa1a0;
		background-color: #eeeeee;
		color: #222222;
		border-radius: 0.25rem;
		outline: none;
		box-shadow: none;
		font-weight: 400;
		font-size: 1rem;
		line-height: 1.5;
		width: 100%;
		height: 50px;
		margin-bottom: 1rem;
		padding: 0.75rem 1rem;
		font-family: inherit;
	}

	@media (prefers-color-scheme: dark) {
		input {
			border: 0.0625rem solid #2a3140;
			background-color: #1c212c;
			color: #e0e3e7;
		}
	}

	input::placeholder {
		color: #8891a4;
		font-family: inherit;
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
</style>
