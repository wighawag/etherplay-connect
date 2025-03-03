<main>
	<div class="wrapper">
		<span class="spinner rotate"></span>
	</div>
	<!-- Initializing... -->
</main>

<style>
	main {
		width: 100%;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: center;
		align-items: center;
	}

	main .wrapper {
		max-width: min(30%, 128px);
		max-height: min(30%, 128px);
	}

	.rotate {
		animation: spinner 1.5s linear infinite;
	}
	@keyframes spinner {
		to {
			transform: rotate(360deg);
		}
	}

	/* SPINNER JUST FOR DEMO */
	.spinner {
		display: inline-block;
		width: 50px;
		height: 50px;
		border-radius: 50%;
		box-shadow: inset -2px 0 0 2px #0bf;
	}
</style>
