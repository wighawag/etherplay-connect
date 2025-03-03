<script lang="ts">
	import { PUBLIC_ALCHEMY_RPC_URL } from '$env/static/public';
	import { createAlchemyConnection } from '$lib/index.js';

	const connection = createAlchemyConnection({
		alchemy: {
			rpcURL: PUBLIC_ALCHEMY_RPC_URL
		},
		alwaysUsePopupForOAuth: true
	});

	let email: string = $state('');
	let otp: string = $state('');
	let mnemonicIndex: number = $state(0);

	let connectionAsAny = $derived($connection as any);
</script>

{#if !$connection || $connection.step === 'Initialised'}
	<button onclick={() => connection.connect()}>connect</button>
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'google' }, usePopup: true })}
		>google</button
	>
{:else if $connection.step == 'Initialising'}
	{#if $connection.auto}
		please wait..
	{:else}
		initialising...
	{/if}
{:else if $connection.step == 'MechanismToChoose'}
	<button onclick={() => connection.connect({ type: 'email', mode: 'otp', email: undefined })}
		>email</button
	>
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'google' }, usePopup: true })}
		>google (popup)</button
	>
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'facebook' }, usePopup: true })}
		>facebook (popup)</button
	>
	<button
		onclick={() =>
			connection.connect({
				type: 'oauth',
				provider: { id: 'auth0', connection: 'twitter' },
				usePopup: true
			})}>twitter (popup)</button
	>

	<button
		onclick={() =>
			connection.connect({
				type: 'mnemonic',
				mnemonic: 'test test test test test test test test test test test junk',
				index: undefined
			})}>mnemonic</button
	>
{:else if $connection.step == 'ConfirmOAuth'}
	<p>You are going to be redirected to a popup to sign-in</p>
	<button onclick={() => connection.confirmOAuth()}>continue</button>
{:else if $connection.step == 'InitialisingMechanism'}
	please wait...
{:else if $connection.step == 'WaitingForOAuthResponse'}
	The signing process has started, follow the instructions in the popup
{:else if $connection.step == 'VerifyingOTP'}
	Veryfing OTP...
{:else if $connection.step == 'InitializingOAuthPopup'}
	please wait for popup initialization ...
{:else if $connection.step == 'GeneratingAccount'}
	Generating private key....
{:else if $connection.step == 'SignedIn'}
	you are signed-in: {$connection.account.localAccount.address}
{:else if $connection.step == 'MechanismChosen'}
	{$connection.mechanism.type}
{:else if $connection.step == 'EmailToProvide'}
	<input type="email" bind:value={email} />
	<button onclick={() => connection.provideEmail(email)}>continue</button>
{:else if $connection.step == 'MnemonicIndexToProvide'}
	<input type="number" bind:value={mnemonicIndex} />
	<button onclick={() => connection.provideMnemonicIndex(mnemonicIndex)}>continue</button>
{:else if $connection.step == 'WaitingForOTP'}
	<input type="text" bind:value={otp} />
	<button onclick={() => connection.provideOTP(otp)}>submit otp</button>
{:else}
	{JSON.stringify({ step: connectionAsAny.step, error: connectionAsAny.error }, null, 2)}
{/if}
