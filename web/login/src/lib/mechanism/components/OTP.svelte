<script lang="ts">
	import {onMount} from 'svelte';
	import {anyEvent, getOtpText, isAllInputFilled, toggleFilledClass} from '../../utils';

	export function clear() {
		otpInputs.forEach((input) => {
			input.value = '';
			toggleFilledClass(input);
		});
	}

	interface Props {
		onAcknowledge: () => void;
		onCodeUpdated: (otpCode: string) => void;
		numCharacters?: number;
	}

	const {onAcknowledge, onCodeUpdated, numCharacters = 6}: Props = $props();

	let otpForm: HTMLFormElement;
	let otpInputs: HTMLInputElement[] = [];
	let allFilled: boolean = false; // used to retain the class (svelte)

	function onPaste(event: Event) {
		console.log(event);
		event.preventDefault();
		const text = (event as any).clipboardData?.getData('text');
		const numerals = text.replace(/\D/g, '');
		console.log({numerals});

		const currentIndex = Number((event.target as any).dataset.index);

		onAcknowledge();

		let startIndex = otpInputs.findIndex((input, index) => index < currentIndex && !input.value);
		startIndex = startIndex === -1 ? currentIndex : startIndex;
		otpInputs.forEach((item, index) => {
			if (index >= startIndex && numerals[index - startIndex]) {
				item.focus();
				const value = numerals[index - startIndex] || '';
				item.value = value;
				toggleFilledClass(item);
				if (isAllInputFilled(otpInputs)) {
					onCodeUpdated(getOtpText(otpInputs));
				}
			}
		});
	}

	const controlKeys = [
		'Backspace',
		'Tab',
		'Enter',
		'Shift',
		'Control',
		'Alt',
		'CapsLock',
		'Escape',
		' ', // Note: ' ' is the Spacebar
		'PageUp',
		'PageDown',
		'End',
		'Home',
		'ArrowLeft',
		'ArrowUp',
		'ArrowRight',
		'ArrowDown',
		'Delete',
		'Insert',
	];

	function onKeyDown(event: KeyboardEvent) {
		console.log('keydown');
		const input = event.target as HTMLInputElement;
		if (event.key === 'Backspace') {
			event.preventDefault();
			console.log('keydown backspace');
			input.value = '';
			// console.log(input.value);
			toggleFilledClass(input);
			if (input.previousElementSibling) {
				if ('focus' in input.previousElementSibling && input.previousElementSibling.focus) {
					(input.previousElementSibling as any).focus();
				}
			}
		} else {
			if (event.key >= '0' && event.key <= '9') {
				if (input.value && input.nextElementSibling) {
					if ('focus' in input.nextElementSibling && input.nextElementSibling.focus) {
						(input.nextElementSibling as any).focus();
					}
				}
			} else {
				// if (!controlKeys.includes(event.key)) {
				// 	console.log('keydown not a number');
				// 	event.preventDefault();
				// 	input.value = '';
				// 	toggleFilledClass(input);
				// }
			}
		}
	}

	function onChange(event: Event) {
		const val = (event.target as any).value;
		console.log({val});

		if (!val) {
			event.preventDefault();
			return;
		}

		if (val.trim().length > 1) {
			(event as any).clipboardData = {
				getData: () => val.trim(),
			};
			onPaste(event);
		}
	}

	onMount(() => {
		otpInputs = Array.from(otpForm.querySelectorAll('input'));
	});

	function onInput(event: Event) {
		const target = event.target as HTMLInputElement;
		const value = target.value;
		if (value) {
			onAcknowledge();
		}
		console.log({target, value});
		toggleFilledClass(target);
		if (target.nextElementSibling) {
			if ('focus' in target.nextElementSibling && target.nextElementSibling.focus) {
				(target.nextElementSibling as any).focus();
			}
		}

		if (isAllInputFilled(otpInputs)) {
			onCodeUpdated(getOtpText(otpInputs));
		}
	}
</script>

<form class="otp-form" use:anyEvent={{event: 'input', callback: onInput}} bind:this={otpForm}>
	{#each Array(numCharacters) as _, i}
		<input
			type="text"
			class={`otp-input${allFilled ? ' filled' : ''}`}
			data-index={i}
			onchange={onChange}
			onpaste={onPaste}
			onkeydown={onKeyDown}
			maxlength={numCharacters}
		/>
	{/each}
</form>

<style>
	.otp-form {
		width: 100%;
		display: flex;
		gap: 20px;
		align-items: center;
		justify-content: center;
	}
	.otp-form input {
		background-color: #f4f4f4;
		color: #121517;
		outline: 2px solid rgb(66, 66, 66);
		border: none;
		font-size: 32px;
		text-align: center;
		padding: 10px;
		width: 100%;
		max-width: 70px;
		height: 70px;
		border-radius: 4px;
	}
	@media (prefers-color-scheme: dark) {
		.otp-form input {
			background-color: #121517;
			color: white;
			outline: 2px solid rgb(66, 66, 66);
		}
	}
	.otp-form input:focus-visible {
		outline: 4px solid royalblue;
	}
	@media (prefers-color-scheme: dark) {
		.otp-form input:focus-visible {
			outline: 2px solid royalblue;
		}
	}
	.otp-form input.filled {
		outline: 4px solid rgb(7, 192, 99);
	}
	@media (prefers-color-scheme: dark) {
		.otp-form input.filled {
			outline: 2px solid rgb(7, 192, 99);
		}
	}
</style>
