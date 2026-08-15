/// <reference types="svelte" />
/// <reference types="vite/client" />

// The BAKED half of this host's configuration. Every one of these is read in exactly one place,
// `lib/config.ts`, which is also where the runtime document a development build accepts is merged
// over them. Nothing else in this host reads `import.meta.env`.
interface ImportMetaEnv {
	/** which HOSTED provider answers email and OAuth; never consulted for the mnemonic mechanism */
	VITE_AUTH_PROVIDER: string;
	VITE_DEV_MNEMONIC: string;
	VITE_OPENFORT_PUBLISHABLE_KEY: string;
	VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY: string;
	VITE_OPENFORT_ENCRYPTION_SESSION_ENDPOINT: string;
	VITE_ALLOW_LOOPBACK_CROSS_ORIGIN: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
