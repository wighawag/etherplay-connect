<script lang="ts">
	import { chainInfo, connection } from '$lib';

	let connectionAsAny = $derived($connection as any);

	let email: string = $state('');
</script>

{#if $connection.step === 'Idle'}
	{#if $connection.loading}
		loading...
	{:else}
		<button onclick={() => connection.connect()}>connect</button>
	{/if}
{:else if $connection.step == 'MechanismToChoose'}
	<input bind:value={email} />
	<button onclick={() => connection.connect({ type: 'email', mode: 'otp', email })}>email</button>
	<hr />

	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'google' }, usePopup: false })}
		>google (redirect)</button
	>
	<hr />
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'facebook' }, usePopup: false })}
		>facebook (redirect)</button
	>
	<hr />
	<button
		onclick={() =>
			connection.connect({
				type: 'oauth',
				provider: { id: 'auth0', connection: 'twitter' },
				usePopup: false
			})}>twitter (redirect)</button
	>
	<hr />

	<button
		onclick={() =>
			connection.connect({
				type: 'wallet'
			})}>web3 wallet</button
	>
	<hr />
	<button onclick={() => connection.cancel()}>back</button>
	<hr />
{:else if $connection.step == 'WalletConnected'}
	Wallet connected
	<button onclick={() => connection.requestSignature()}>sign-in private account</button>
	<button onclick={() => connection.back('MechanismToChoose')}>back</button>
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
		<button onclick={() => connection.back('MechanismToChoose')}>back</button>
	{:else}
		{#each $connection.wallets as wallet}
			<button onclick={() => connection.connect({ type: 'wallet', name: wallet.info.name })}
				>{wallet.info.name}</button
			>
		{/each}
		<button onclick={() => connection.back('MechanismToChoose')}>back</button>
	{/if}
{:else if $connection.step == 'SignedIn'}
	you are signed-in: {$connection.account.address} / {$connection.account.signer.address}
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
			onclick={() => connection.switchWalletChain(connection.chainInfo)}
			disabled={!!$connection.wallet?.switchingChain}>switch chain</button
		>
	{/if}
{:else}
	{JSON.stringify({ step: connectionAsAny.step, error: connectionAsAny.error }, null, 2)}
{/if}
