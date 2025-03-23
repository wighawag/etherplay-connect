<script lang="ts">
	import { chainInfo, connection } from '$lib';

	let connectionAsAny = $derived($connection as any);
</script>

{#if $connection.step === 'Idle'}
	{#if $connection.loading}
		loading...
	{:else}
		<button onclick={() => connection.connect({ type: 'wallet' })}>connect</button>
	{/if}
{:else if $connection.step == 'WalletConnected' || ($connection.step == 'SignedIn' && $connection.wallet)}
	you are signed-in: {$connection.mechanism.address}
	<button onclick={() => connection.disconnect()}>disconnect</button>

	{@const accountChanged = $connection.wallet?.accountChanged}
	{#if accountChanged}
		<button
			style="margin-right: 2rem;"
			onclick={() => connection.connectOnCurrentWalletAccount(accountChanged)}>switch</button
		>
	{/if}
	{@const invalidChain = $connection.wallet?.invalidChainId}
	{#if invalidChain}
		<button
			style="margin-right: 2rem;"
			onclick={() => connection.switchWalletChain(connection.provider.chainId, chainInfo)}
			disabled={!!$connection.wallet?.switchingChain}>switch chain</button
		>
	{/if}
	{#if $connection.wallet.locked}
		<button style="margin-right: 2rem;" onclick={() => connection.unlock()}>unlock</button>
	{/if}
{:else if $connection.step == 'WaitingForWalletConnection'}
	Wallet connection requested...
{:else if $connection.step == 'WalletToChoose'}
	{#if $connection.wallets.length == 0}
		No wallet found. Download <a
			href="https://metamask.io/download/"
			target="_blank"
			rel="noopener noreferrer">MetaMask</a
		>
		<br />
		<button onclick={() => connection.back('Idle')}>back</button>
	{:else}
		{#each $connection.wallets as wallet}
			<button onclick={() => connection.connect({ type: 'wallet', name: wallet.info.name })}
				>{wallet.info.name}</button
			>
		{/each}
		<button onclick={() => connection.back('Idle')}>back</button>
	{/if}
{:else if $connection.step == 'SignedIn'}{:else}
	{JSON.stringify({ step: connectionAsAny.step, error: connectionAsAny.error }, null, 2)}
{/if}
