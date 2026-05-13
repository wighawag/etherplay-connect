import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {AuthProvider} from '@etherplay/connect-core';
import {createOpenfortProvider} from '@etherplay/openfort';

export function createAuthProvider(
	accountGenerator: AccountGenerator,
	windowOrigin: string,
	signingOrigin: string,
): AuthProvider {
	// openfort only for now
	return createOpenfortProvider({
		publishableKey: import.meta.env.VITE_OPENFORT_PUBLISHABLE_KEY || '',
		shieldPublishableKey: import.meta.env.VITE_OPENFORT_SHIELD_PUBLISHABLE_KEY || undefined,
		walletHost: window.location.origin,
		accountGenerator,
		signingOrigin,
		windowOrigin,
	});
}
