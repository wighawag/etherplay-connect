<script lang="ts">
	import { PUBLIC_ALCHEMY_RPC_URL } from '$env/static/public';
	import { createConnection } from '$lib/index.js';

	const connection = createConnection({
		alchemy: {
			rpcURL: PUBLIC_ALCHEMY_RPC_URL
		}
	});

	let email: string = $state('');
	let otp: string = $state('');
	let mnemonicIndex: number = $state(0);
</script>

{#if !$connection}
	<button onclick={() => connection.connect()}>connect</button>
{:else if $connection.step == 'MechanismToChoose'}
	<button onclick={() => connection.connect({ type: 'email', mode: 'otp', email: undefined })}
		>email</button
	>
	<button onclick={() => connection.connect({ type: 'oauth', provider: { id: 'google' } })}
		>google</button
	>
	<button onclick={() => connection.connect({ type: 'oauth', provider: { id: 'facebook' } })}
		>facebook</button
	>
	<button
		onclick={() =>
			connection.connect({
				type: 'mnemonic',
				mnemonic: 'test test test test test test test test test test test junk',
				index: undefined
			})}>mnemonic</button
	>
{:else if $connection.step == 'MechanismChosen'}
	{$connection.mechanism.type}
{:else if $connection.step == 'EmailToProvide'}
	<input type="email" bind:value={email} />
	<button onclick={() => connection.provideEmail(email)}>continue</button>
{:else if $connection.step == 'MnemonicIndexToProvide'}
	<input type="number" bind:value={mnemonicIndex} />
	<button onclick={() => connection.provideMnemonicIndex(mnemonicIndex)}>continue</button>
{:else if $connection.step == 'WaitingForOTPVerification'}
	<input type="text" bind:value={otp} />
	<button onclick={() => connection.provideOTP(otp)}>submit otp</button>
{:else}
	{JSON.stringify($connection, null, 2)}
{/if}
