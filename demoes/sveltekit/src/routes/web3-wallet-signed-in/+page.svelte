<script lang="ts">
	import { chainInfo } from '$lib';
	import NeedsTheUser from '$lib/NeedsTheUser.svelte';
	import { createConnection } from '@etherplay/connect';

	// Using targetStep: 'SignedIn' with walletOnly: true - no walletHost needed for wallet-only auth!
	const connection = createConnection({
		targetStep: 'SignedIn',
		walletOnly: true,
		chainInfo,
		prioritizeWalletProvider: true,
		useCurrentAccount: 'always',
		autoConnect: true,
		requestSignatureAutomaticallyIfPossible: true
	});

	let connectionAsAny = $derived($connection as any);

	function purchase() {
		// With targetStep: 'SignedIn', ensureConnected() returns SignedIn type
		connection.ensureConnected().then(($connection) => {
			connection.provider.call('eth_sendTransaction')([
				{ from: $connection.account.address, to: $connection.account.address, value: '0x0' }
			]);
		});
	}
</script>

<!--
	The states that need the user, above the step switch because they are not about the step. This
	page is SIGNED IN, and a signed-in app still has to render them: the session account keeps working
	if the wallet locks, but anything sent FROM THE WALLET account cannot be signed until the user
	unlocks, and `wallet.status` is the only field that says so.
-->
<NeedsTheUser {connection} />

{#if $connection.step === 'Idle'}
	{#if $connection.loading}
		loading...
	{:else}
		<button onclick={() => connection.connect({ type: 'wallet' })}>connect</button>
	{/if}
{:else if connection.isTargetStepReached($connection)}
	you are signed-in: {$connection.account.address} / {$connection.account.signer.address} | {$connection
		.wallet?.chainId}
	<button onclick={() => connection.disconnect()}>disconnect</button>
{:else if $connection.step == 'WalletConnected'}
	Wallet connected
	<button onclick={() => connection.requestSignature()}>sign-in private account</button>
	<button
		onclick={() =>
			connection.walletOnly ? connection.back('Idle') : connection.back('MechanismToChoose')}
		>back</button
	>
	<button onclick={() => connection.disconnect()}>disconnect</button>
{:else if $connection.step == 'PopupLaunched'}
	{#if $connection.popupClosed}
		Popup seems to be closed.
		<button onclick={() => connection.cancel()}>cancel</button>
	{:else}
		Popup launched...
		<button onclick={() => connection.cancel()}>cancel</button>
	{/if}
{:else if $connection.step == 'WaitingForWalletConnection'}
	Wallet connection requested...
{:else if $connection.step == 'WaitingForSignature'}
	Waiting for signature...
	<!-- Waiting for signature Did the wallet not ask ? -->
	<!-- <button onclick={() => connection.requestSignature()}>sign</button> -->
	<!-- <button onclick={() => connection.back('WalletToChoose')}>back</button> -->
{:else if $connection.step == 'ChooseWalletAccount'}
	{#each $connection.wallet.accounts as account}
		<button onclick={() => connection.connectToAddress(account)}>{account}</button>
	{/each}
	<button onclick={() => connection.back('WalletToChoose')}>back</button>
{:else if $connection.step == 'WalletToChoose'}
	{#if $connection.wallets.length == 0}
		No wallet found. Download <a
			href="https://metamask.io/download/"
			target="_blank"
			rel="noopener noreferrer">MetaMask</a
		>
		<br />
		<button
			onclick={() =>
				connection.walletOnly ? connection.back('Idle') : connection.back('MechanismToChoose')}
			>back</button
		>
	{:else}
		{#each $connection.wallets as wallet}
			<button onclick={() => connection.connect({ type: 'wallet', name: wallet.info.name })}
				>{wallet.info.name}</button
			>
		{/each}
		<button
			onclick={() =>
				connection.walletOnly ? connection.back('Idle') : connection.back('MechanismToChoose')}
			>back</button
		>
	{/if}
{:else}
	{JSON.stringify({ step: connectionAsAny.step, error: connectionAsAny.error }, null, 2)}
{/if}

<button onclick={purchase}>purchase</button>
