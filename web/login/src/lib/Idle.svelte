<script lang="ts">
	let {
		cancel,
	}: {
		cancel: (error?: {message: string; cause?: any}) => void;
	} = $props();
</script>

<main>
	<h1>Not Supported</h1>

	<button onclick={() => cancel({message: 'Not supported'})} type="submit">Cancel</button>
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

	h1 {
		font-size: max(min(5vw, 2rem), 1.5rem);
		color: #f0f1f3;
		font-weight: 700;
		line-height: 1.125;
		margin-bottom: 1rem;
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
</style>
