<script lang="ts">
	import { chainInfo } from '$lib';
	import { createConnection } from '@etherplay/connect';

	// Using targetStep: 'WalletConnected' - no walletHost needed for wallet-only apps!
	const connection = createConnection({
		targetStep: 'WalletConnected',
		chainInfo,
		prioritizeWalletProvider: true,
		useCurrentAccount: 'always',
		autoConnect: true
	});

	let connectionAsAny = $derived($connection as any);

	function purchase() {
		// With targetStep: 'WalletConnected', ensureConnected() returns WalletConnected type
		connection.ensureConnected().then(($connection) => {
			connection.provider.call('eth_sendTransaction')([
				{ from: $connection.account.address, to: $connection.account.address, value: '0x0' }
			]);
		});
	}
</script>

{#if $connection.step === 'Idle'}
	{#if $connection.loading}
		loading...
	{:else}
		<button onclick={() => connection.connect({ type: 'wallet' })}>connect</button>
	{/if}
{:else if connection.isTargetStepReached($connection)}
	you are signed-in: {$connection.account.address}
	<button onclick={() => connection.disconnect()}>disconnect</button>

	{@const accountChanged = $connection.wallet?.accountChanged}
	{#if accountChanged}
		<button style="margin-right: 2rem;" onclick={() => connection.connectToAddress(accountChanged)}
			>switch</button
		>
	{/if}
	{@const invalidChain = $connection.wallet?.invalidChainId}
	{#if invalidChain}
		<button
			style="margin-right: 2rem;"
			onclick={() => connection.switchWalletChain()}
			disabled={!!$connection.wallet?.switchingChain}>switch chain</button
		>
	{/if}
	{#if $connection.wallet.status == 'locked'}
		<button
			style="margin-right: 2rem;"
			disabled={$connection.wallet.unlocking}
			onclick={() => connection.unlock()}>unlock</button
		>
	{:else if $connection.wallet.status == 'disconnected'}
		<p style="color: oklch(0.637 0.237 25.331);">
			The account has been disconnected, reconnect it to continue. or disconnect
		</p>
	{/if}
{:else if $connection.step == 'WaitingForWalletConnection'}
	Wallet connection requested...
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

<button onclick={purchase}>purchase</button>
