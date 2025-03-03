import type {Action} from 'svelte/action';

export function isAllInputFilled(inputs: HTMLInputElement[]) {
	return Array.from(inputs).every((item) => item.value);
}

export function getOtpText(inputs: HTMLInputElement[]) {
	let text = '';
	inputs.forEach((input) => {
		text += input.value;
	});
	return text;
}

export function debounce<T extends (...args: any[]) => any>(func: T, delay: number): T {
	let timeoutId: number | undefined;
	return ((...args: Parameters<T>) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => {
			func(...args);
		}, delay);
	}) as T;
}

export function toggleFilledClass(field: HTMLInputElement) {
	if (field.value) {
		field.classList.add('filled');
	} else {
		field.classList.remove('filled');
	}
}

export const anyEvent: Action<HTMLElement, {event: string; callback: (event: Event) => void}> = (
	node,
	{event, callback},
) => {
	node.addEventListener(event, callback);
	return {
		destroy() {
			node.removeEventListener(event, callback);
		},
	};
};
