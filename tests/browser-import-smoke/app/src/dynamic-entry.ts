// The observable shape: a dynamic import exposes BOTH outcomes, so a hang is distinguishable from a
// failure. A module that throws while evaluating rejects here; a module that blocks while evaluating
// leaves `window.__smoke` undefined forever. The test asserts it settles, not merely that it worked.
declare global {
	interface Window {
		__smoke?: {mode: string; settled: boolean; ok: boolean; exportCount?: number; error?: string};
	}
}

import('@etherplay/connect').then(
	(m) => {
		window.__smoke = {
			mode: 'dynamic',
			settled: true,
			ok: typeof m.createConnection === 'function',
			exportCount: Object.keys(m).length,
		};
	},
	(e: unknown) => {
		window.__smoke = {
			mode: 'dynamic',
			settled: true,
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		};
	},
);
