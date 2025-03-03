<script lang="ts">
	import CriticalError from './lib/CriticalError.svelte';
	import {alchemy, errors} from './lib/state';
</script>

{#if errors.length > 0}
	<CriticalError {errors} />
{:else if alchemy}
	Login...
	<!-- <Login alchemy={alchemy.service} from={alchemy.from} /> -->
{:else}
	<CriticalError errors={[{message: 'no alchemy'}]} />
{/if}
