<script lang="ts">
	import CriticalError from './lib/CriticalError.svelte';
	import Login from './lib/Login.svelte';
	import {connectionStore, errors, fromProps} from './lib/state';
</script>

{#if errors.length > 0}
	<CriticalError {errors} />
{:else if connectionStore && fromProps}
	<Login connection={connectionStore} from={fromProps} />
{:else}
	<CriticalError errors={[{message: 'no connection', canClose: false}]} />
{/if}
