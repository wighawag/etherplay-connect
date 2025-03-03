<script lang="ts">
	import { PUBLIC_WALLET_HOST } from '$env/static/public';
	import { createConnection } from '$lib/index.js';

	const connection = createConnection({
		walletHost: PUBLIC_WALLET_HOST
	});

	let connectionAsAny = $derived($connection as any);
</script>

{#if !$connection}
	<button onclick={() => connection.connect()}>connect</button>
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'google' }, usePopup: true })}
		>google</button
	>
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
			connection.connect({ type: 'oauth', provider: { id: 'google' }, usePopup: false })}
		>google (redirect)</button
	>
	<button
		onclick={() =>
			connection.connect({ type: 'oauth', provider: { id: 'facebook' }, usePopup: false })}
		>facebook (redirect)</button
	>
	<button
		onclick={() =>
			connection.connect({
				type: 'oauth',
				provider: { id: 'auth0', connection: 'twitter' },
				usePopup: false
			})}>twitter (redirect)</button
	>
	<button
		onclick={() =>
			connection.connect({
				type: 'mnemonic',
				mnemonic: 'test test test test test test test test test test test junk',
				index: undefined
			})}>mnemonic</button
	>
{:else if $connection.step == 'NeedWalletSignature'}
	Signature requested...
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
{:else if $connection.step == 'WalletToChoose'}
	Wallet to choose...
{:else if $connection.step == 'SignedIn'}
	you are signed-in: {$connection.account.localAccount.address} / {$connection.account.originAccount
		.address}
{:else}
	{JSON.stringify({ step: connectionAsAny.step, error: connectionAsAny.error }, null, 2)}
{/if}
