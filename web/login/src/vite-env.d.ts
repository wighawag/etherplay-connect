/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
	VITE_ALCHEMY_RPC_URL: string;
	VITE_ALCHEMY_API_KEY_NOT_RECOMMENDED: string;
	// Add other environment variables you're using
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
