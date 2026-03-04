<script lang="ts">
	import CriticalError from './lib/CriticalError.svelte';
	import Login from './lib/Login.svelte';
	import {alchemy, errors} from './lib/state';
</script>

<div class="flex min-h-screen w-full justify-center bg-background">
	{#if errors.length > 0}
		<CriticalError {errors} />
	{:else if alchemy}
		<Login alchemy={alchemy.connection} from={alchemy.from} />
	{:else}
		<CriticalError errors={[{message: 'no alchemy', canClose: false}]} />
	{/if}
</div>
