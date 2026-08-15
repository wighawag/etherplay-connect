import type {AccountGenerator} from '@etherplay/wallet-connector';
import type {AuthMechanism, AuthProvider, OriginContext} from '@etherplay/connect-core';
import {createLocalProvider} from '@etherplay/connect-core';
import {createOpenfortProvider} from '@etherplay/openfort';
import {hostConfig} from './config';

/**
 * WHICH PROVIDER ANSWERS THIS SIGN-IN, DECIDED BY MECHANISM.
 *
 * Not by the `?provider=` parameter, which cannot express this. That parameter is chosen by the APP
 * at the APP's build time and appended to every popup URL for every mechanism, so an app that wants
 * email from a hosted provider AND a local mnemonic sign-in has one value to give and two answers
 * to give it. The mechanism is the thing that actually differs, and the host is the side that knows
 * which providers exist, so the host routes.
 *
 * `mnemonic` is derived in this browser: no key, no vendor SDK, no network. Everything else is
 * hosted authentication and goes to the configured hosted provider.
 *
 * The two origins and the permissions arrive as one `OriginContext` rather than as loose arguments,
 * because `windowOrigin` and `signingOrigin` are two strings of the same type meaning opposite
 * sides of the same question, and a call site that swapped them would not fail: it would decide
 * access for the wrong pair.
 */
export function createAuthProvider(
	mechanism: AuthMechanism,
	// Which HOSTED provider for email and OAuth. Never consulted for the mnemonic mechanism.
	hostedProviderType: string,
	accountGenerator: AccountGenerator,
	origins: OriginContext,
): AuthProvider {
	if (mechanism.type === 'mnemonic') {
		return createLocalProvider({...origins, accountGenerator});
	}

	if (hostedProviderType === 'openfort') {
		const config = hostConfig();
		return createOpenfortProvider({
			...origins,
			publishableKey: config.openfort.publishableKey,
			shieldPublishableKey: config.openfort.shieldPublishableKey,
			walletHost: window.location.origin,
			accountGenerator,
			encryptionSessionEndpoint: config.openfort.encryptionSessionEndpoint,
		});
	}
	// openfort only for now
	throw new Error(`auth provider of type "${hostedProviderType}" is not supported`);
}
