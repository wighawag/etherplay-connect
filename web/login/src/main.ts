import './app.css';
import {prepareConfiguration} from './lib/config';

// Configuration first, and the app is imported only afterwards.
//
// `state.ts` and `allowlist.ts` read what they are configured with AT IMPORT TIME, which is what
// makes those values constants rather than something every call site could re-decide. A static
// import of `App.svelte` here would run them before the runtime document had been read, so the
// import is dynamic and this is the ordering that keeps it honest.
prepareConfiguration()
	.then(async () => {
		const {mount} = await import('svelte');
		const {default: App} = await import('./App.svelte');
		mount(App, {
			target: document.getElementById('app')!,
		});
	})
	.catch((err) => {
		// A blank popup with nothing in the console is the worst thing this window can be. Whatever
		// went wrong before the app existed is said here, in the one place that can still say it.
		console.error('[etherplay] the login host failed to start', err);
		const target = document.getElementById('app');
		if (target) {
			target.textContent = `the login host failed to start: ${err?.message || err}`;
		}
	});
