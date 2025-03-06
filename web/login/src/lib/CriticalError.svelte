<script lang="ts">
	interface Props {
		errors: {message: string; canClose: boolean}[];
	}
	let {errors}: Props = $props();

	let canClose = $derived(errors.reduce((prev, curr) => prev && curr.canClose, true));
</script>

<main>
	<div></div>
	<div>
		{#each errors as { message }}
			<p>{message}</p>
		{/each}

		<button
			onclick={() => {
				if (canClose) {
					window.close();
				} else {
					window.history.back();
				}
			}}>Return</button
		>
	</div>
	<div></div>
</main>

<style>
	main {
		padding: 16px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-height: 100vh;
		max-width: 510px;
	}

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

	p {
		color: #222222;
		font-size: 1.5rem;
		margin-block: 1rem;
		font-weight: 400;
	}

	@media (prefers-color-scheme: dark) {
		p {
			color: #c2c7d0;
		}
	}
</style>
