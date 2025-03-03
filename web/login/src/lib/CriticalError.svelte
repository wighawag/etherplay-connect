<script lang="ts">
	interface Props {
		errors: {message: string}[];
	}
	let {errors}: Props = $props();
</script>

{#each errors as { message }}
	<p>{message}</p>
{/each}
