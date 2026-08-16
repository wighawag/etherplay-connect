/**
 * EVERY VALUE THIS HOST IS CONFIGURED WITH, IN ONE PLACE, AND THE ONE RULE ABOUT WHERE IT MAY COME
 * FROM.
 *
 * Two artefacts are built from this source and they differ in exactly one boolean:
 *
 * - the PRODUCTION host bakes every value at build time and honours no runtime document. That is
 *   the safer end of the design rather than a shortcut: nothing fetched at runtime reaches a value
 *   this host acts on. The most important value here is the allowlist, and an allowlist entry mints
 *   credentials with NO HUMAN IN THE LOOP, so making it runtime-injectable in the artefact that
 *   holds real accounts would undo that argument in one line.
 *
 *   It does make ONE request: it looks for a document only so it can shout about finding one, and
 *   throws the answer away unread. The property being protected is that no fetched value is ever
 *   applied, which is stronger than "no fetch happens" and is the one worth stating exactly.
 *   The cost is a 404 in the console of a correctly deployed production host.
 * - the DEVELOPMENT host merges a runtime document over those baked values, because it holds
 *   nothing worth protecting: it exists to be run next to somebody's app and by their e2e run, and
 *   everything in it is injectable precisely because none of it guards a real account.
 *
 * A production build that FINDS a document ignores it and says so out loud, which is the pattern
 * `ALLOW_LOOPBACK_REQUESTERS` already sets: a capability that must not travel into production
 * shouts when it finds itself there rather than quietly allowing itself.
 *
 * NOTHING ELSE IN THIS HOST READS `import.meta.env`. That is what makes "which values can be
 * injected, and into which build" a question with one answer instead of eight.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DOCUMENT
 *
 * A JSON file served at the ROOT of whatever directory this host is served from, next to
 * `index.html`, so a developer edits one file and reloads. Absent is the normal case: every value
 * below has a default that works with no document at all.
 *
 *   {
 *     "hostedAuthProvider": "openfort",
 *     "devMnemonic": "test test test test test test test test test test test junk",
 *     "openfort": {
 *       "publishableKey": "",
 *       "shieldPublishableKey": "",
 *       "encryptionSessionEndpoint": ""
 *     },
 *     "allowLoopbackRequesters": true,
 *     "originAllowlist": {"http://localhost:5173": [{"chainId": 31337, "contract": "0x..."}]},
 *     "crossOriginAllowlist": {"http://localhost:5173": ["http://localhost:5174"]},
 *     "autoSignedLifetimeSeconds": 120,
 *     "promptedLifetimeSeconds": 0
 *   }
 *
 * The field-by-field prose lives with the artefact that ships it,
 * `packages/etherplay-dev-wallet-host/README.md`, so that adding a field means editing the type
 * below and one document rather than four. What is worth repeating HERE is only what a reader of
 * this file needs: the two lifetimes are not an afterthought, because an auto-signed credential's
 * deadline is the only lever an allowlist entry has once it turns out to be wrong.
 */
import type {CrossOriginConsent, DelegationTarget} from '@etherplay/connect-core';

/**
 * Whether this build honours a runtime configuration document.
 *
 * The SAME flag that marks the build as unfit for real accounts, deliberately: there is no way to
 * get the injectable configuration without also getting the build that says it is a development
 * one. `vite build` produces the production artefact; `vite build --mode development` produces the
 * development one; `vite dev` is a development one too.
 *
 * The MODE and not `import.meta.env.DEV`, which cannot express this: vite pins `NODE_ENV` to
 * `production` for every `vite build`, so `DEV` is false even under `--mode development` and the two
 * artefacts came out byte for byte identical. Compared POSITIVELY against `development` so that any
 * other mode, named or invented later, bakes its configuration rather than accepting a document.
 */
export const DEVELOPMENT_BUILD = import.meta.env.MODE === 'development';

/** Where the document is looked for, relative to the origin this host is served from. */
export const RUNTIME_CONFIG_URL = '/config.json';

export type HostConfig = {
	/**
	 * Which HOSTED provider answers email and OAuth. Never consulted for the mnemonic mechanism,
	 * which is derived in the browser by the local provider.
	 */
	hostedAuthProvider: string;
	/**
	 * The phrase the mnemonic mechanism signs in with.
	 *
	 * Defaulted to the standard test mnemonic in EVERY build, including production, and that is
	 * deliberate rather than an oversight: the accounts it derives are the ones every local chain
	 * funds, they are public knowledge, and nobody is protecting them. It means the mechanism needs
	 * no user input beyond picking an account index.
	 */
	devMnemonic: string;
	openfort: {
		publishableKey: string;
		shieldPublishableKey?: string;
		encryptionSessionEndpoint: string;
	};
	/** see ALLOW_LOOPBACK_REQUESTERS in allowlist.ts, which is where the cost of this is argued */
	allowLoopbackRequesters: boolean;
	/** requester origin to the (chainId, contract) pairs it may have signed with nobody in the loop */
	originAllowlist: Record<string, DelegationTarget[]>;
	/** origin whose account is at stake, to who may ask for it */
	crossOriginAllowlist: Record<string, CrossOriginConsent>;
	/** how long an auto-signed credential may be presented for */
	autoSignedLifetimeSeconds: number;
	/** how long a credential a human granted may be presented for; 0 means no expiry */
	promptedLifetimeSeconds: number;
};

/**
 * What this host is configured with when no document is present, which is the normal case.
 *
 * The env reads are here and nowhere else. A production build has only these.
 */
export function bakedDefaults(): HostConfig {
	return {
		hostedAuthProvider: import.meta.env.VITE_AUTH_PROVIDER || 'openfort',
		devMnemonic: import.meta.env.VITE_DEV_MNEMONIC || 'test test test test test test test test test test test junk',
		openfort: {
			publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
			shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
			encryptionSessionEndpoint: import.meta.env.VITE_OPENFORT_ENCRYPTION_SESSION_ENDPOINT || '',
		},
		// A development BUILD allows it unless told not to; any other build refuses it unless told
		// to, in which case allowlist.ts shouts. Unchanged from when this lived there.
		allowLoopbackRequesters:
			import.meta.env.VITE_ALLOW_LOOPBACK_CROSS_ORIGIN === 'true' ||
			(DEVELOPMENT_BUILD && import.meta.env.VITE_ALLOW_LOOPBACK_CROSS_ORIGIN !== 'false'),
		// Empty on purpose. An entry is a standing decision to mint credentials for a third party
		// with no human in the loop, so it is added when a specific origin and contract are known to
		// belong to each other, and not before. A placeholder would be a wrong entry.
		originAllowlist: {},
		crossOriginAllowlist: {},
		autoSignedLifetimeSeconds: 90 * 24 * 60 * 60, // ~3 months
		promptedLifetimeSeconds: 0, // no expiry
	};
}

/** The document as it arrives: every field optional, and nothing is trusted to be the right type. */
export type RuntimeConfigDocument = Partial<{
	hostedAuthProvider: unknown;
	devMnemonic: unknown;
	openfort: unknown;
	allowLoopbackRequesters: unknown;
	originAllowlist: unknown;
	crossOriginAllowlist: unknown;
	autoSignedLifetimeSeconds: unknown;
	promptedLifetimeSeconds: unknown;
}>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the document over the defaults, one field at a time.
 *
 * A field of the wrong type is REFUSED AND SAID OUT LOUD rather than applied or silently dropped: a
 * typo in a dev config that quietly leaves the old value is a debugging session about the wrong
 * thing. Only the fields present are touched, so a document may set one value and inherit the rest.
 */
export function mergeDocument(defaults: HostConfig, document: RuntimeConfigDocument): HostConfig {
	const merged: HostConfig = {...defaults, openfort: {...defaults.openfort}};
	const refuse = (field: string, expected: string) =>
		console.error(`[etherplay] ignoring "${field}" in ${RUNTIME_CONFIG_URL}: expected ${expected}`);

	const string = (field: 'hostedAuthProvider' | 'devMnemonic') => {
		const value = document[field];
		if (value === undefined) return;
		if (typeof value !== 'string') return refuse(field, 'a string');
		merged[field] = value;
	};
	string('hostedAuthProvider');
	string('devMnemonic');

	if (document.openfort !== undefined) {
		if (!isPlainObject(document.openfort)) {
			refuse('openfort', 'an object');
		} else {
			for (const key of ['publishableKey', 'shieldPublishableKey', 'encryptionSessionEndpoint'] as const) {
				const value = document.openfort[key];
				if (value === undefined) continue;
				if (typeof value !== 'string') {
					refuse(`openfort.${key}`, 'a string');
					continue;
				}
				merged.openfort[key] = value;
			}
		}
	}

	if (document.allowLoopbackRequesters !== undefined) {
		if (typeof document.allowLoopbackRequesters !== 'boolean') {
			refuse('allowLoopbackRequesters', 'a boolean');
		} else {
			merged.allowLoopbackRequesters = document.allowLoopbackRequesters;
		}
	}

	// THE TWO FIELDS THAT DECIDE WHETHER A CREDENTIAL IS MINTED WITH NOBODY IN THE LOOP, and
	// therefore the two checked hardest rather than cast and hoped for. A malformed entry that gets
	// through does not fail here: it fails much later as a pair that mysteriously never matches, or
	// as an exception inside the matching, at the moment somebody is trying to sign in.
	//
	// The tables are REPLACED, not merged entry by entry. Merging would make "remove this entry"
	// impossible to express, and these are the tables where an entry nobody meant to keep is the
	// dangerous direction.
	if (document.originAllowlist !== undefined) {
		if (!isPlainObject(document.originAllowlist)) {
			refuse('originAllowlist', 'an object keyed by origin');
		} else {
			const table: Record<string, DelegationTarget[]> = {};
			let sound = true;
			for (const [origin, entries] of Object.entries(document.originAllowlist)) {
				if (!Array.isArray(entries)) {
					refuse(`originAllowlist["${origin}"]`, 'an array of {chainId, contract}');
					sound = false;
					continue;
				}
				const targets: DelegationTarget[] = [];
				for (const [index, entry] of entries.entries()) {
					const chainId = isPlainObject(entry) ? entry.chainId : undefined;
					const contract = isPlainObject(entry) ? entry.contract : undefined;
					if (typeof chainId !== 'number' || !Number.isInteger(chainId)) {
						refuse(`originAllowlist["${origin}"][${index}].chainId`, 'a whole number');
						sound = false;
						continue;
					}
					if (typeof contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
						refuse(`originAllowlist["${origin}"][${index}].contract`, 'a 0x-prefixed 20-byte address');
						sound = false;
						continue;
					}
					targets.push({chainId, contract: contract as `0x${string}`});
				}
				table[origin] = targets;
			}
			// All or nothing. A HALF-APPLIED allowlist is the worst of the three outcomes: it grants
			// something nobody wrote down, and it looks like it worked.
			if (sound) {
				merged.originAllowlist = table;
			} else {
				console.error(
					`[etherplay] originAllowlist is not applied AT ALL because part of it was refused: a table that ` +
						`granted only the entries that happened to parse would be a grant nobody wrote.`,
				);
			}
		}
	}
	if (document.crossOriginAllowlist !== undefined) {
		if (!isPlainObject(document.crossOriginAllowlist)) {
			refuse('crossOriginAllowlist', 'an object keyed by origin');
		} else {
			const table: Record<string, CrossOriginConsent> = {};
			let sound = true;
			for (const [origin, consent] of Object.entries(document.crossOriginAllowlist)) {
				if (consent === '*') {
					table[origin] = '*';
				} else if (Array.isArray(consent) && consent.every((requester) => typeof requester === 'string')) {
					table[origin] = consent as string[];
				} else {
					refuse(`crossOriginAllowlist["${origin}"]`, 'either "*" or an array of origin strings');
					sound = false;
				}
			}
			if (sound) {
				merged.crossOriginAllowlist = table;
			} else {
				console.error(
					`[etherplay] crossOriginAllowlist is not applied AT ALL because part of it was refused: a table that ` +
						`admitted only the entries that happened to parse would be a consent nobody gave.`,
				);
			}
		}
	}

	const lifetime = (field: 'autoSignedLifetimeSeconds' | 'promptedLifetimeSeconds') => {
		const value = document[field];
		if (value === undefined) return;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
			return refuse(field, 'a number of seconds, 0 or more');
		}
		merged[field] = value;
	};
	lifetime('autoSignedLifetimeSeconds');
	lifetime('promptedLifetimeSeconds');

	return merged;
}

let applied: HostConfig | undefined;

/**
 * What this host is configured with. Every consumer reads it from here.
 *
 * `prepareConfiguration()` settles it before the app is mounted, and the ordering is held together
 * by ONE dynamic import in `main.ts`. That is thin, so an early read is treated as the mistake it
 * is rather than papered over:
 *
 * - in a DEVELOPMENT build it throws. There is no legitimate early read there, and the alternative
 *   is a host that quietly runs on empty allowlists and a three-month deadline while its document
 *   sits unread, which is the exact silent misconfiguration this file exists to abolish. A future
 *   entry point that statically imports `state.ts` should fail loudly on the first run, not
 *   mislead somebody months later.
 * - in any other build it is the baked defaults, because that is not merely a fallback, it is the
 *   only answer that build can ever give: it honours no document, so early and late agree.
 */
export function hostConfig(): HostConfig {
	if (!applied) {
		if (DEVELOPMENT_BUILD) {
			throw new Error(
				'[etherplay] configuration was read before the runtime document was loaded. `prepareConfiguration()` ' +
					'must be awaited before ANY module that reads configuration is imported (see main.ts, where the app ' +
					'is imported dynamically for exactly this reason). Reading it now would silently use the baked ' +
					'defaults and ignore config.json.',
			);
		}
		applied = bakedDefaults();
	}
	return applied;
}

export async function fetchDocument(): Promise<RuntimeConfigDocument | undefined> {
	let response: Response;
	try {
		response = await fetch(RUNTIME_CONFIG_URL, {cache: 'no-store'});
	} catch (err) {
		// No server, no network, blocked request. Silent on purpose and NOT the same case as the one
		// below: a host that cannot be signed into without a network is what this whole artefact is
		// against, and nobody who is offline needs to be told twice.
		return undefined;
	}

	if (!response.ok) {
		// The ordinary case: no document. Not an error, and not worth a line of its own.
		return undefined;
	}

	// A static server that answers every path with `index.html` would hand back HTML here, and
	// "your config silently did nothing" is exactly the afternoon this file exists to avoid.
	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('json')) {
		console.warn(
			`[etherplay] ${RUNTIME_CONFIG_URL} answered with "${contentType}" rather than JSON, so it is not a ` +
				`configuration document and is ignored. A server that falls back to index.html for missing files does this.`,
		);
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = await response.json();
	} catch (err) {
		// THE DOCUMENT IS THERE AND BROKEN, which is this artefact's most likely misconfiguration and
		// the one case that must never be silent. Swallowing it here would contradict the rule the
		// rest of this file is built on: a typo that quietly leaves the old value is a debugging
		// session about the wrong thing.
		console.error(
			`[etherplay] ${RUNTIME_CONFIG_URL} exists but is not valid JSON, so ALL of it is ignored and this host is ` +
				`running on its built-in defaults: ${(err as Error)?.message}`,
		);
		return undefined;
	}

	if (!isPlainObject(parsed)) {
		console.error(
			`[etherplay] ${RUNTIME_CONFIG_URL} is valid JSON but not an object, so it is ignored and this host is ` +
				`running on its built-in defaults.`,
		);
		return undefined;
	}
	return parsed as RuntimeConfigDocument;
}

/**
 * Settle the configuration, then say what this host is, in one line somebody can read.
 *
 * A DEVELOPMENT build waits for the document, because everything after this reads the result. A
 * PRODUCTION build does not wait, and does not use what comes back: it looks only so that it can
 * shout if somebody deployed a document next to it, and nothing it contains ever reaches a value
 * this host acts on. If that ever stops being true, the argument in allowlist.ts about there being
 * no runtime fetch to poison stops being true with it.
 */
export async function prepareConfiguration(): Promise<HostConfig> {
	if (DEVELOPMENT_BUILD) {
		const defaults = bakedDefaults();
		const document = await fetchDocument();
		applied = document ? mergeDocument(defaults, document) : defaults;
		announce(describeDocument(document, defaults, applied));
	} else {
		applied = bakedDefaults();
		announce('configured at build time');
		fetchDocument().then((document) => {
			if (document) {
				console.warn(
					`[etherplay] found a runtime configuration document at ${RUNTIME_CONFIG_URL} and IGNORED it: this is a ` +
						`production build, which bakes its configuration at build time so that there is no runtime document ` +
						`to poison. Rebuild with \`--mode development\` if you meant to configure this host at runtime.`,
				);
			}
		});
	}
	return applied;
}

/**
 * Which top-level values this host ended up with that are not the ones it was built with.
 *
 * Compared by value rather than tracked during the merge, so it cannot drift from what was actually
 * applied: it reports the difference that EXISTS, not the difference the merge believes it made.
 */
function changedFields(defaults: HostConfig, merged: HostConfig): string[] {
	return (Object.keys(defaults) as (keyof HostConfig)[]).filter(
		(key) => JSON.stringify(defaults[key]) !== JSON.stringify(merged[key]),
	);
}

/**
 * WHAT THE DOCUMENT DID, which is not the same question as whether there was one.
 *
 * Three outcomes, and the middle one is why this exists. A document that is present and changes
 * nothing is the normal state of a host nobody has configured (the bundled server answers `{}` so
 * that an absent optional file does not look like a failed request), and announcing that as
 * "configured by config.json" would be a claim nobody could check and everybody would misread: the
 * developer whose settings are being ignored because of a typo'd field name would read it as
 * confirmation that they were applied.
 *
 * Naming the fields that DID change costs one line and answers the only question anybody asks of
 * this message next.
 */
function describeDocument(
	document: RuntimeConfigDocument | undefined,
	defaults: HostConfig,
	merged: HostConfig,
): string {
	if (!document) {
		return `no ${RUNTIME_CONFIG_URL} found, using built-in defaults`;
	}
	const changed = changedFields(defaults, merged);
	if (changed.length === 0) {
		return `${RUNTIME_CONFIG_URL} is present but sets nothing, so this host is on its built-in defaults`;
	}
	return `configured by ${RUNTIME_CONFIG_URL}: ${changed.join(', ')}`;
}

/**
 * The startup line.
 *
 * Which origin this is being served from and which provider it will use for hosted mechanisms are
 * the two facts a developer needs to match against their app's `walletHost` and their own
 * expectations, and looking either of them up costs more than printing them.
 */
function announce(document: string) {
	const config = hostConfig();
	const build = DEVELOPMENT_BUILD ? 'DEVELOPMENT build (not for real accounts)' : 'production build';
	console.log(
		`[etherplay] login host serving ${window.location.origin} - ${build}, ${document}.\n` +
			`[etherplay] email and oauth go to the hosted provider "${config.hostedAuthProvider}"; ` +
			`mnemonic is derived locally and needs no key and no network.`,
	);
}
