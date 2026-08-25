// The load-blocking shape: the entry module cannot start until @etherplay/connect has been fetched,
// instantiated AND evaluated. If evaluation ever blocks (top-level await on something that never
// arrives, a module-scope handshake, an eager popup/iframe bridge), nothing below runs, the document
// never reaches readyState 'complete', and no error is reported anywhere. That silence is the whole
// reason this test exists.
import * as connect from '@etherplay/connect';

declare global {
	interface Window {
		__smoke?: {mode: string; settled: boolean; ok: boolean; exportCount?: number; error?: string};
	}
}

window.__smoke = {
	mode: 'static',
	settled: true,
	ok: typeof connect.createConnection === 'function',
	exportCount: Object.keys(connect).length,
};
