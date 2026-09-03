<script lang="ts">
	import { chainInfo } from '$lib';
	import NeedsTheUser from '$lib/NeedsTheUser.svelte';
	import { createConnection, canActAs, ConnectionFailure } from '@etherplay/connect';

	// Using targetStep: 'WalletConnected' - no walletHost needed for wallet-only apps!
	const connection = createConnection({
		targetStep: 'WalletConnected',
		chainInfo,
		prioritizeWalletProvider: true,
		useCurrentAccount: 'always',
		autoConnect: true
	});

	let connectionAsAny = $derived($connection as any);

	// Who signed the last purchase, and with which wallet. A real app records this per transaction,
	// because REPLACING or CANCELLING one reuses its original nonce: it has to be signed by the same
	// key, and no other account will do.
	let lastPurchase: { address: `0x${string}`; wallet?: string } | undefined = $state(undefined);
	let replaceStatus: string | undefined = $state(undefined);

	function purchase() {
		// With targetStep: 'WalletConnected', ensureConnected() returns WalletConnected type
		connection.ensureConnected().then(($connection) => {
			lastPurchase = { address: $connection.account.address, wallet: $connection.mechanism.name };
			connection.provider.call('eth_sendTransaction')([
				{ from: $connection.account.address, to: $connection.account.address, value: '0x0' }
			]);
		});
	}

	// The reason `ensureConnected` takes an address at all.
	//
	// Called UNCONDITIONALLY, with no "are we already there" check in front of it: `account.address`
	// is the address the connection AGREED on, not the one that can sign now, so a hand-rolled check
	// passes for a locked wallet and lets the send go out to a prompt nobody was shown. Asking every
	// time costs nothing, because it resolves immediately when the connection is already usable.
	async function replaceLastPurchase() {
		if (!lastPurchase) return;
		replaceStatus = 'making sure that account can sign...';
		try {
			const connected = await connection.ensureConnected(
				'WalletConnected',
				lastPurchase.wallet
					? { type: 'wallet', name: lastPurchase.wallet, address: lastPurchase.address }
					: { type: 'wallet', address: lastPurchase.address },
				{ doNotStoreLocally: true }
			);
			replaceStatus = `replacing, signed by ${connected.account.address}`;
			connection.provider.call('eth_sendTransaction')([
				{ from: connected.account.address, to: connected.account.address, value: '0x0' }
			]);
		} catch (err) {
			// A refusal maps to a cancellation, including the user acknowledging "your wallet is on a
			// different account": nobody should see a red error for a decision they made.
			const cancelled = err instanceof ConnectionFailure && err.message === 'Connection cancelled';
			replaceStatus = cancelled ? 'not replaced' : `could not replace: ${(err as Error).message}`;
		}
	}
</script>

<NeedsTheUser {connection} />

{#if $connection.step === 'Idle'}
	{#if $connection.loading}
		loading...
	{:else}
		<button onclick={() => connection.connect({ type: 'wallet' })}>connect</button>
	{/if}
{:else if connection.isTargetStepReached($connection)}
	you are signed-in: {$connection.account.address}
	<button onclick={() => connection.disconnect()}>disconnect</button>

	<!-- locked / revoked / wrong chain are rendered ONCE by `NeedsTheUser` above, since they can
	     happen at any step rather than only at this one. -->
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

{#if lastPurchase}
	<hr />
	<p>
		last purchase signed by <code>{lastPurchase.address}</code>
		{#if lastPurchase.wallet}
			via {lastPurchase.wallet}{/if}
	</p>
	<!--
		`canActAs` is the supported way to RENDER readiness without starting a flow: it is false for a
		locked wallet, a revoked one, and a wallet that has moved to another account. The button stays
		enabled either way, on purpose — `ensureConnected` is what fixes those, and this is only a hint.

		The STANDALONE form is the one to use in markup: it takes `$connection`, so it re-evaluates when
		the wallet locks. `connection.canActAs(address)` reads the same state but through a method call,
		which a reactive block has no reason to re-run — use that one in event handlers.
	-->
	<button onclick={replaceLastPurchase}>
		replace it {canActAs($connection, lastPurchase.address) ? '' : '(needs your wallet)'}
	</button>
	{#if replaceStatus}<p>{replaceStatus}</p>{/if}
{/if}
