import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {AuthProvider, PermissionRequest} from '@etherplay/connect-core';
import {createOpenfortProvider} from '@etherplay/openfort';

export function createAuthProvider(
	authProviderType: string,
	accountGenerator: AccountGenerator,
	windowOrigin: string,
	signingOrigin: string,
	permissions: PermissionRequest[],
): AuthProvider {
	if (authProviderType === 'openfort') {
		return createOpenfortProvider({
			publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
			shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
			walletHost: window.location.origin,
			accountGenerator,
			signingOrigin,
			windowOrigin,
			permissions,
			encryptionSessionEndpoint: import.meta.env.VITE_OPENFORT_ENCRYPTION_SESSION_ENDPOINT,
		});
	}
	// openfort only for now
	throw new Error(`auth provider of type "${authProviderType}" is not supported`);
}
