export async function retry<T>(
	fn: () => Promise<T>,
	options: {
		maxRetries?: number;
		delay?: number;
		onRetry?: (error: unknown, attempt: number) => void;
	} = {}
): Promise<T> {
	const { maxRetries = 2, delay = 0, onRetry } = options;

	let lastError: unknown;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			// If this was the last attempt, don't delay or notify, just fail
			if (attempt === maxRetries) {
				break;
			}

			// Optional callback for retry notification
			if (onRetry) {
				onRetry(error, attempt + 1);
			}

			// Wait before next retry if delay is specified
			if (delay > 0) {
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	throw lastError;
}
