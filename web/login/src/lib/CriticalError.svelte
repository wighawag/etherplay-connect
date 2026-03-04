<script lang="ts">
	import {Button} from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';

	interface Props {
		errors: {message: string; canClose: boolean}[];
	}
	let {errors}: Props = $props();

	let canClose = $derived(errors.reduce((prev, curr) => prev && curr.canClose, true));
</script>

<main class="flex min-h-screen max-w-[510px] w-full flex-col items-center justify-center p-4">
	<Card.Root class="w-full max-w-sm border-0 shadow-md">
		<Card.Header>
			<Card.Title class="text-xl text-destructive">Error</Card.Title>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#each errors as { message }}
				<p class="text-base text-muted-foreground">{message}</p>
			{/each}

			<Button
				onclick={() => {
					if (canClose) {
						window.close();
					} else {
						window.history.back();
					}
				}}
				size="lg"
				class="w-full"
			>
				Return
			</Button>
		</Card.Content>
	</Card.Root>
</main>
