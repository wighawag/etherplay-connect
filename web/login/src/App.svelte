<script lang="ts">
	import CriticalError from './lib/CriticalError.svelte';
	import Login from './lib/Login.svelte';
	import {authProvider, errors, fromProps} from './lib/state';
</script>

{#if errors.length > 0}
	<CriticalError {errors} />
{:else if authProvider && fromProps}
	<Login {authProvider} from={fromProps} />
{:else}
	<CriticalError errors={[{message: 'no connection', canClose: false}]} />
{/if}
