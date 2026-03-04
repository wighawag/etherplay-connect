<script lang="ts">
	import * as InputOTP from '$lib/components/ui/input-otp';

	export function clear() {
		otpValue = '';
	}

	interface Props {
		onAcknowledge: () => void;
		onCodeUpdated: (otpCode: string) => void;
		numCharacters?: number;
	}

	const {onAcknowledge, onCodeUpdated, numCharacters = 6}: Props = $props();

	let otpValue = $state('');

	function handleComplete(value: string) {
		if (value.length === numCharacters) {
			onCodeUpdated(value);
		}
	}

	// Watch for value changes
	$effect(() => {
		if (otpValue) {
			onAcknowledge();
		}
		if (otpValue.length === numCharacters) {
			handleComplete(otpValue);
		}
	});
</script>

<div class="flex w-full justify-center py-4">
	<InputOTP.Root 
		maxlength={numCharacters} 
		bind:value={otpValue}
		class="justify-center"
	>
		{#snippet children({ cells })}
			<InputOTP.Group class="gap-2">
				{#each cells as cell}
					<InputOTP.Slot 
						{cell} 
						class="size-12 text-xl rounded-md border bg-background first:rounded-md first:border last:rounded-md" 
					/>
				{/each}
			</InputOTP.Group>
		{/snippet}
	</InputOTP.Root>
</div>
