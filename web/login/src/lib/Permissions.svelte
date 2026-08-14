<script lang="ts">
	import type {ApprovalUI} from './approval';

	/**
	 * What the site asked for, and what has been answered so far.
	 *
	 * ONE component used by all three mechanisms, rather than the same block written three times.
	 * This is the screen a user makes a security decision on, and three copies of it is three
	 * chances for one to say something the others do not.
	 */
	let {
		approval,
		cancel,
	}: {
		approval: ApprovalUI;
		cancel: (error?: any) => void;
	} = $props();

	function shortAddress(address: string): string {
		return `${address.slice(0, 6)}...${address.slice(-4)}`;
	}

	// Named where it is known, and shown as a raw id where it is not. Inventing a friendly name for
	// an unknown chain would be worse than the number: it would be a claim nobody checked.
	const CHAIN_NAMES: Record<number, string> = {
		1: 'Ethereum',
		10: 'Optimism',
		100: 'Gnosis',
		137: 'Polygon',
		8453: 'Base',
		42161: 'Arbitrum One',
		11155111: 'Sepolia',
		31337: 'a local development chain',
	};

	function chainName(chainId: number): string {
		return CHAIN_NAMES[chainId] || `chain ${chainId}`;
	}
</script>

{#if approval.request}
	{#if approval.blocking.length > 0}
		<!--
			A required permission was refused, so sign-in cannot complete. Said plainly, and
			attributed to the SITE rather than to this wallet, because it is the site that made
			it a condition of entry.
		-->
		<p>{approval.request.windowOrigin} will not let you in without permissions you declined.</p>
		<ul class="permissions">
			{#each approval.blocking as outcome}
				<li>
					{#if outcome.request.type === 'delegation'}
						acting for you at {shortAddress(outcome.request.contract)} on {chainName(outcome.request.chainId)}
					{:else}
						something this wallet does not understand
					{/if}
				</li>
			{/each}
		</ul>
		<button onclick={() => cancel()} id="permissions-return" type="submit">Return</button>
	{:else if approval.access?.kind === 'blocked'}
		<!--
			NOT A PROMPT. This site asked for an account belonging to another one, and that origin has
			not said it accepts such requests, so there is nothing here for a user to weigh: a screen
			asking them to compare two domain names is not a decision they can make well, and it is
			the one this host can make for them. The app was already told, in a form it can act on.
		-->
		<p>{approval.request.windowOrigin} cannot use your {approval.request.signingOrigin} account.</p>
		<p class="detail">
			Only {approval.request.signingOrigin} can sign you in to that account. A site may act for you elsewhere only
			by registering its own delegate, which you approve at the contract and can withdraw at any time.
		</p>
		<button onclick={() => cancel()} id="origin-blocked-return" type="submit">Return</button>
	{:else if approval.access?.kind === 'ask' && !approval.accessGranted}
		{@const secondStep = approval.confirmationsGiven > 0}
		{#if !secondStep}
			<p>
				{approval.request.windowOrigin} is requesting access to account from {approval.request.signingOrigin}
			</p>
			{#if approval.access.basis === 'named'}
				<p class="detail small">
					{approval.request.signingOrigin} lists this site as one it accepts requests from.
				</p>
			{/if}
			<button onclick={approval.grantAccess} id="origin-accept" type="submit">Accept</button>
			<button class="deny" onclick={() => cancel()} id="origin-deny" type="submit">Deny</button>
		{:else}
			<!--
				THE SECOND STEP, asked only where nobody vouched for this site. It says what the first
				screen cannot: that the reason this is allowed to be asked at all is a blanket setting,
				not a relationship, so whether THIS site should have the account is a question only the
				person reading it can answer.
			-->
			<p>Are you sure?</p>
			{#if approval.access.basis === 'wildcard'}
				<p class="detail">
					{approval.request.signingOrigin} accepts requests from ANY site, so nobody has vouched for {approval
						.request.windowOrigin} in particular.
				</p>
			{:else}
				<p class="detail">
					{approval.request.windowOrigin} is a page running on your own machine, admitted by a development
					setting of this wallet rather than by {approval.request.signingOrigin}.
				</p>
			{/if}
			<p class="detail small">
				It will be able to act as you at {approval.request.signingOrigin}. Continue only if you know what this
				site is.
			</p>
			<!--
				CANCEL FIRST, and that is the point of the second screen rather than a detail of it. The
				Accept of the previous screen sits at the top, so a confirm in the same place is one
				double-click away from being no confirmation at all: what stops that must be the layout,
				not the user's reflexes. The proceed control also stops being the primary one here.
			-->
			<button onclick={() => cancel()} id="origin-deny-confirm" type="submit">Cancel</button>
			<button class="deny" onclick={approval.grantAccess} id="origin-accept-confirm" type="submit">
				Give it my {approval.request.signingOrigin} account
			</button>
		{/if}
	{:else if approval.pending.length > 0}
		{@const request = approval.pending[0]}
		<!--
			One at a time, and deliberately: a list of checkboxes with a single Accept is a list
			nobody reads. Each grant is its own decision because each grant is separately
			refusable, and refusing one does not refuse the others.
		-->
		<p>{approval.request.windowOrigin} is asking for:</p>

		{#if request.type === 'delegation'}
			<p class="detail">
				Permission to act in your name onchain, at one contract: {shortAddress(request.contract)} on {chainName(
					request.chainId,
				)}.
			</p>
			<p class="detail small">
				It cannot act for you anywhere else, and you can withdraw this at that contract at any time.
			</p>
		{:else}
			<!--
				Never dropped, always shown. An app and a host that disagree about what was granted
				is the failure this case exists to prevent, so it is visible and it is refused.
			-->
			<p class="detail">
				Something this wallet does not understand: <code>{request.requestedType}</code>.
			</p>
			<p class="detail small">
				This site may be newer than this wallet. Allowing it is not possible, since there is nothing here that
				knows what it means.
			</p>
		{/if}

		{#if request.required}
			<p class="detail small">{approval.request.windowOrigin} will not let you in without this.</p>
		{/if}

		{#if request.type === 'delegation'}
			<button onclick={() => approval.grant(request)} id="permission-allow" type="submit">Allow</button>
		{/if}
		<button class="deny" onclick={() => approval.deny(request)} id="permission-deny" type="submit">
			{request.type === 'delegation' ? 'Not this one' : 'Continue without it'}
		</button>
	{/if}
{/if}

<style>
	/*
	 * Copied from the mechanism components rather than inherited, because Svelte scopes styles to
	 * the component that declares them: these buttons live here now, so their appearance has to as
	 * well, or the security decision gets unstyled controls.
	 */
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

	.deny {
		border: 0.0625rem solid #c74a24;
		background-color: #c74a24;
		color: #fff;
	}

	p {
		color: #222222;
		font-size: 1.5rem;
		margin-block: 1rem;
		font-weight: 400;
	}

	.detail {
		font-size: 1.1rem;
	}

	.small {
		font-size: 0.9rem;
		color: #555555;
	}

	.permissions {
		font-size: 1rem;
		color: #555555;
	}

	code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.95em;
	}
</style>
