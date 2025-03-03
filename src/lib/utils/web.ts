export function onDocumentLoaded(callback: () => void): boolean {
	if (typeof document !== 'undefined') {
		if (
			(document as any).readyState === 'ready' ||
			document.readyState === 'interactive' ||
			document.readyState === 'complete'
		) {
			callback();
		} else {
			document.addEventListener(
				'load',
				function () {
					callback();
				},
				{
					once: true
				}
			);
		}
		return true;
	}
	return false;
}
