<script lang="ts">
	import type { AddressUnavailable, BasicChainInfo, Connection } from '@etherplay/connect';

	/**
	 * The states where the connection is waiting on the USER, rendered in one place.
	 *
	 * These are cross-cutting rather than per-step: a wallet can go locked, be revoked, land on
	 * another chain, or turn out to be on the wrong account at ANY step, and `ensureConnected()`
	 * stays pending while any of them is true. That is legitimate (there is no timeout, because a
	 * human is deciding) but it is only legitimate BECAUSE the app shows the reason and offers the
	 * remedy. An app that renders none of this has a promise that never settles and a user who is
	 * never told why.
	 *
	 * So this component is the demo's answer to "what must my UI have?" and it belongs above the
	 * step switch, not inside it.
	 */
	type NeedsTheUserConnection = {
		subscribe: (run: (value: Connection<any>) => void) => () => void;
		unlock: () => Promise<void>;
		connectToAddress: (address: `0x${string}`) => void;
		switchWalletChain: (chainInfo?: BasicChainInfo) => Promise<void>;
		acknowledgeAddressUnavailable: () => void;
		clearError: () => void;
	};

	// `switchWalletChain()` with no argument uses the chain the connection was created for, which is
	// the one this component wants: it has no opinion about chains, only about the user being stuck.

	let { connection }: { connection: NeedsTheUserConnection } = $props();

	let state = $derived($connection as Connection<any>);
	let wallet = $derived(state.wallet);
	let unavailable = $derived(state.addressUnavailable as AddressUnavailable | undefined);
</script>

{#if unavailable}
	<!--
		THE WALLET IS ON A DIFFERENT ACCOUNT THAN THE ONE THAT WAS ASKED FOR.

		Not an error, and deliberately not styled as one: the wallet works, the connection is still
		usable, and the only person who can fix it is the user, in their wallet. So this reads as an
		instruction with a way out.

		Two things end it, and both must be reachable:
		- the user switches account in their wallet, and the pending `ensureConnected()` proceeds by
		  itself (nothing to click here);
		- the user gives up, which is `acknowledgeAddressUnavailable()` and settles that promise as a
		  cancellation rather than as a failure.
	-->
	<aside class="attention">
		<p>{unavailable.message}</p>
		<p class="detail">
			needed: <code>{unavailable.requested}</code>
			{#if unavailable.selected}
				· wallet is on: <code>{unavailable.selected}</code>
			{/if}
		</p>
		{#if unavailable.available.length > 1}
			<!--
				DETAIL, NOT A PICKER, and shown only when the wallet exposed more than one account. A
				wallet that shows the dapp one account at a time (Rabby, for instance) reports exactly the
				account it is on, so this list would be a list of one, and the absence of the requested
				address from it does NOT mean the user does not have it. The remedy for those wallets is
				the sentence above: switch in the wallet.

				Rendered as text rather than as buttons, deliberately. `connectToAddress(other)` would
				connect to a different account, which ABANDONS the request that produced this state: the
				pending `ensureConnected` settles as a cancellation. A button labelled "use 0x…" that
				silently cancels what the user was doing is worse than no button.
			-->
			<p class="detail">
				this wallet is currently exposing: {unavailable.available.join(', ')}
			</p>
		{/if}
		<button onclick={() => connection.acknowledgeAddressUnavailable()}>cancel</button>
	</aside>
{/if}

{#if wallet?.status === 'locked'}
	<!--
		A LOCKED WALLET KEEPS ITS STEP AND ITS ACCOUNT, so nothing else on the state says it cannot
		sign: `account.address` still names the account that was agreed on. `wallet.status` is the
		field that knows, which is why this is rendered off it and not off the step, and why
		`connection.canActAs(address)` reads it too.

		`unlock()` is the narrow remedy: it prompts the wallet and keeps the step, the account, the
		mechanism and the wallet. `connect()` here would open the picker and throw all four away.
	-->
	<aside class="attention">
		<p>Your wallet is locked, so it cannot sign right now.</p>
		<!-- `.catch`: the user refusing the wallet's password prompt is an answer, not an app error. -->
		<button disabled={wallet.unlocking} onclick={() => connection.unlock().catch(() => {})}>
			{wallet.unlocking ? 'unlocking...' : 'unlock'}
		</button>
	</aside>
{:else if wallet?.status === 'disconnected' && wallet.accountChanged && !unavailable}
	<!--
		The user moved to an account this connection is not on. `connectToAddress` reuses this wallet.

		`&& !unavailable` is load-bearing, and it is the same trap as the account list above: while a
		request for a SPECIFIC account is resting, this block would be on screen alongside it, and
		connecting to whichever account the wallet happens to be on ABANDONS that request — the pending
		`ensureConnected` settles as a cancellation. When a specific account is in play, the instruction
		above is the only offer that makes sense.
	-->
	<aside class="attention">
		<p>
			Your wallet moved to <code>{wallet.accountChanged}</code>, which this app is not connected as.
		</p>
		<button onclick={() => connection.connectToAddress(wallet.accountChanged!)}
			>use that account</button
		>
	</aside>
{/if}

{#if wallet?.invalidChainId}
	<aside class="attention">
		<p>Your wallet is on chain {wallet.chainId}, which this app does not use.</p>
		<button
			disabled={!!wallet.switchingChain}
			onclick={() => connection.switchWalletChain().catch(() => {})}
		>
			{wallet.switchingChain === 'addingChain'
				? 'adding network...'
				: wallet.switchingChain
					? 'switching...'
					: 'switch chain'}
		</button>
	</aside>
{/if}

{#if state.error}
	<!--
		The last row of the README's "what your UI has to render" table. An error is DISMISSABLE, which
		is why it gets a button rather than only a sentence: a stale failure banner beside a connection
		that has since recovered is its own small bug.
	-->
	<aside class="attention">
		<p>{state.error.message}</p>
		<button onclick={() => connection.clearError()}>dismiss</button>
	</aside>
{/if}

{#if state.pendingRequests.length > 0}
	<!--
		What the user's wallet is holding RIGHT NOW, whatever this connection is doing. It survives a
		state with no wallet at all, which is the whole point: a request the user must answer and the
		app cannot see is a request nothing can explain or recover from.
	-->
	<aside class="attention">
		<p>
			Your wallet is asking you to approve {state.pendingRequests.length} request(s):
			{state.pendingRequests.map((request) => request.kind).join(', ')}.
		</p>
	</aside>
{/if}

<style>
	.attention {
		border: 1px solid currentColor;
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem;
		margin: 0.5rem 0;
	}
	.detail {
		font-size: 0.85em;
		opacity: 0.8;
	}
	code {
		word-break: break-all;
	}
</style>
