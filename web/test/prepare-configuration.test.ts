import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest';

/**
 * STEP TWO'S GATE, AS A TEST: a development build takes its allowlist and deadlines from the
 * document; a production build ignores a document that is present and says that it did.
 *
 * That gate is about `prepareConfiguration`, not about `mergeDocument`, and the difference is the
 * whole point: which build this is decides whether the merge is reached at all. The browser gate
 * covers it end to end but needs a served bundle and a browser; this covers the same decision in
 * milliseconds, so a change that quietly starts honouring a document in production fails here
 * first.
 *
 * `DEVELOPMENT_BUILD` is settled when the module is first evaluated, so each case stubs the mode
 * and then imports a fresh copy.
 */
async function loadConfig(mode: 'development' | 'production') {
	vi.stubEnv('MODE', mode);
	vi.resetModules();
	return import('../login/src/lib/config');
}

function jsonResponse(body: unknown, contentType = 'application/json') {
	return {
		ok: true,
		headers: {get: (name: string) => (name === 'content-type' ? contentType : null)},
		json: async () => body,
	} as unknown as Response;
}

function notFound() {
	return {
		ok: false,
		headers: {get: () => null},
		json: async () => {
			throw new Error('should not be read');
		},
	} as unknown as Response;
}

let logs: string[];
let warnings: string[];
let errors: string[];

beforeEach(() => {
	logs = [];
	warnings = [];
	errors = [];
	vi.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
	vi.spyOn(console, 'warn').mockImplementation((...a) => warnings.push(a.join(' ')));
	vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a.join(' ')));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('a development build', () => {
	it('takes its allowlist and its deadlines from the document', async () => {
		const {prepareConfiguration} = await loadConfig('development');
		const allowlist = {'http://localhost:5173': [{chainId: 31337, contract: '0x' + 'e7'.repeat(20)}]};
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({originAllowlist: allowlist, autoSignedLifetimeSeconds: 120})),
		);

		const config = await prepareConfiguration();
		expect(config.originAllowlist).toEqual(allowlist);
		expect(config.autoSignedLifetimeSeconds).toBe(120);
		expect(logs.join('\n')).toContain('configured by /config.json');
		expect(logs.join('\n')).toContain('originAllowlist');
	});

	it('waits for the document before answering, so nothing reads the defaults first', async () => {
		const {prepareConfiguration, hostConfig} = await loadConfig('development');
		let release: (r: Response) => void;
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
		);

		const pending = prepareConfiguration();
		// Reading configuration while the document is still in flight is the bug this ordering
		// exists to prevent, and it says so rather than handing back the defaults.
		expect(() => hostConfig()).toThrow(/before the runtime document was loaded/);
		release!(jsonResponse({autoSignedLifetimeSeconds: 7}));
		expect((await pending).autoSignedLifetimeSeconds).toBe(7);
	});

	it('says a document that is PRESENT and sets nothing is not configuration', async () => {
		// The normal state of a host nobody has configured: the bundled server answers `{}` so that
		// an absent optional file does not look like a failed request. Announcing that as
		// "configured by config.json" would be read as confirmation by the one person who most needs
		// to be told otherwise: the developer whose settings are being ignored because they typo'd a
		// field name.
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({})),
		);

		const config = await prepareConfiguration();
		expect(config).toEqual((await loadConfig('development')).bakedDefaults());
		expect(logs.join('\n')).toContain('present but sets nothing');
		expect(logs.join('\n')).not.toContain('configured by');
	});

	it('says the same when every field in the document was refused', async () => {
		// A document of nothing but typos changes nothing, and this is the line that says so.
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({autoSignedLifetimeSeconds: 'soon', unknownField: true})),
		);

		await prepareConfiguration();
		expect(logs.join('\n')).toContain('present but sets nothing');
		expect(errors.join('\n')).toContain('autoSignedLifetimeSeconds');
	});

	it('names the fields a document actually changed', async () => {
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({autoSignedLifetimeSeconds: 120, devMnemonic: 'a b c'})),
		);

		await prepareConfiguration();
		const line = logs.join('\n');
		expect(line).toContain('configured by /config.json');
		expect(line).toContain('autoSignedLifetimeSeconds');
		expect(line).toContain('devMnemonic');
		// And not the ones it left alone, which is what makes the list worth reading.
		expect(line).not.toContain('crossOriginAllowlist');
	});

	it('runs on its defaults when there is no document, and says so', async () => {
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => notFound()),
		);

		const config = await prepareConfiguration();
		expect(config.originAllowlist).toEqual({});
		expect(logs.join('\n')).toContain('no /config.json found, using built-in defaults');
		expect(errors).toEqual([]);
	});

	it('runs on its defaults with no network at all, silently', async () => {
		// A host that cannot be signed into offline is what this whole artefact is against.
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			}),
		);

		await expect(prepareConfiguration()).resolves.toBeDefined();
		expect(errors).toEqual([]);
	});

	it('refuses an HTML answer, because a server that falls back to index.html gives one', async () => {
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse({autoSignedLifetimeSeconds: 1}, 'text/html; charset=utf-8')),
		);

		const config = await prepareConfiguration();
		expect(config.autoSignedLifetimeSeconds).toBe(90 * 24 * 60 * 60);
		expect(warnings.join('\n')).toContain('rather than JSON');
	});

	it('SAYS SO when the document is there and unparseable', async () => {
		// The most likely misconfiguration of this artefact, and the one that must never be silent:
		// the developer wrote a document, it did nothing, and only the console can say why.
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				headers: {get: () => 'application/json'},
				json: async () => {
					throw new SyntaxError('Unexpected token } in JSON at position 42');
				},
			})),
		);

		const config = await prepareConfiguration();
		expect(config.autoSignedLifetimeSeconds).toBe(90 * 24 * 60 * 60);
		expect(errors.join('\n')).toContain('not valid JSON');
		expect(errors.join('\n')).toContain('built-in defaults');
	});

	it('refuses a document that is valid JSON but not an object', async () => {
		const {prepareConfiguration} = await loadConfig('development');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => jsonResponse([{autoSignedLifetimeSeconds: 1}])),
		);

		const config = await prepareConfiguration();
		expect(config.autoSignedLifetimeSeconds).toBe(90 * 24 * 60 * 60);
		expect(errors.join('\n')).toContain('not an object');
	});
});

describe('a production build', () => {
	it('IGNORES a document that is present, and says that it did', async () => {
		const {prepareConfiguration} = await loadConfig('production');
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				originAllowlist: {'http://evil.example': [{chainId: 1, contract: '0x' + '11'.repeat(20)}]},
				autoSignedLifetimeSeconds: 1,
			}),
		);
		vi.stubGlobal('fetch', fetchMock);

		const config = await prepareConfiguration();
		// Not merely "warned about": NOT APPLIED. The table is the one the build was shipped with.
		expect(config.originAllowlist).toEqual({});
		expect(config.autoSignedLifetimeSeconds).toBe(90 * 24 * 60 * 60);

		// The warning arrives on the unawaited probe, after `prepareConfiguration` has returned:
		// this build never waits for a document it will not use.
		await vi.waitFor(() => expect(warnings.join('\n')).toContain('IGNORED it: this is a production build'));
	});

	it('does not wait for that probe before configuring itself', async () => {
		const {prepareConfiguration} = await loadConfig('production');
		vi.stubGlobal(
			'fetch',
			vi.fn(() => new Promise<Response>(() => {})), // never settles
		);
		// Would hang if the probe were awaited.
		await expect(prepareConfiguration()).resolves.toBeDefined();
	});

	it('reads its configuration without complaint before anything is prepared', async () => {
		// The opposite of the development case above, and not an oversight: this build honours no
		// document, so an early read and a late one are the same answer and there is nothing to warn
		// about.
		const {hostConfig} = await loadConfig('production');
		expect(hostConfig().hostedAuthProvider).toBe('openfort');
	});
});
