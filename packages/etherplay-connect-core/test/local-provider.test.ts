import {describe, expect, it} from 'vitest';
import {bytesToHex} from '@noble/hashes/utils';
import {secp256k1} from '@noble/curves/secp256k1';
import type {AccountGenerator, PrivateKeyAccount} from '@etherplay/wallet-connector';
import {createLocalProvider, fromMnemonicToHDKey, fromPublicKey} from '../src/index.js';
import type {AuthState} from '../src/types.js';

/**
 * WHAT THIS PINS: that moving the mnemonic branch out of @etherplay/openfort changed nothing about
 * the account it produces.
 *
 * The addresses below are the standard hardhat test accounts, which is what the host signs in with
 * by default. If the derivation ever moves off that path, an adopter's e2e stops matching the
 * accounts their local chain funded, and this is the test that says so before they find out.
 */
const accountGenerator: AccountGenerator = {
	type: 'ethereum',
	fromMnemonicToAccount(mnemonic: string, index: number): PrivateKeyAccount {
		const hdkey = fromMnemonicToHDKey(mnemonic, index);
		if (!hdkey.privateKey) {
			throw new Error('invalid key');
		}
		return {
			// checksummed, like viem returns it, so the lowercasing is proved to be ours
			address: fromPublicKey(secp256k1.getPublicKey(hdkey.privateKey, false)) as `0x${string}`,
			privateKey: `0x${bytesToHex(hdkey.privateKey)}`,
			publicKey: `0x${bytesToHex(secp256k1.getPublicKey(hdkey.privateKey, false))}`,
		};
	},
	async signTextMessage(): Promise<`0x${string}`> {
		throw new Error('not needed here');
	},
};

const MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT_0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const ACCOUNT_1 = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const ORIGIN = 'https://app.example.com';

function aProvider(overrides?: {windowOrigin?: string; signingOrigin?: string; permissions?: any[]}) {
	const states: AuthState[] = [];
	const provider = createLocalProvider({
		accountGenerator,
		windowOrigin: overrides?.windowOrigin ?? ORIGIN,
		signingOrigin: overrides?.signingOrigin ?? ORIGIN,
		permissions: overrides?.permissions,
	});
	provider.subscribe((state) => states.push(state));
	return {provider, states, last: () => states[states.length - 1]};
}

describe('the local provider', () => {
	it('needs no init settings, no key and no network', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		expect(last().step).toBe('Initialised');
	});

	it('asks for an index before deriving anything', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: undefined});
		expect(last().step).toBe('MnemonicIndexToProvide');
	});

	it('derives the hardhat account for the index it is given', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: undefined});
		await provider.provideMnemonicIndex(0);

		const state = last();
		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}
		expect(state.account.localAccount.address).toBe(ACCOUNT_0);
		expect(state.account.localAccount.index).toBe(0);
		expect(state.account.accountType).toBe('ethereum');
		// the fabricated user: there is no account at any service behind this one
		expect(state.account.signer.user).toEqual({
			address: ACCOUNT_0,
			orgId: 'mnemonic',
			userId: '0@mnemonic.id',
			email: '0@mnemonic.id',
		});
	});

	it('derives a different account for a different index', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: 1});
		const state = last();
		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}
		expect(state.account.localAccount.address).toBe(ACCOUNT_1);
	});

	it('carries the entropy of the phrase as the account key, as the hosted providers do', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: 0});
		const state = last();
		if (state.step !== 'SignedIn') {
			throw new Error(`expected SignedIn, got ${state.step}`);
		}
		// the entropy of the standard test mnemonic
		expect(state.account.localAccount.key).toBe('0xdf9bf37e6fcdf9bf37e6fcdf9bf37e3c');
	});

	// THE GATE THAT MUST NOT DIFFER BY PROVIDER. It was written per provider once, and the three
	// paths disagreed about it.
	it('requires nothing when the window is signing for itself and asked for nothing', async () => {
		const {provider, last} = aProvider();
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: 0});
		const state = last();
		if (state.step !== 'SignedIn') throw new Error('not signed in');
		expect(state.requireOriginApproval).toBe(false);
	});

	it('requires approval when the origins differ', async () => {
		const {provider, last} = aProvider({signingOrigin: 'https://other.example.com'});
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: 0});
		const state = last();
		if (state.step !== 'SignedIn') throw new Error('not signed in');
		expect(state.requireOriginApproval).toEqual({
			windowOrigin: ORIGIN,
			signingOrigin: 'https://other.example.com',
			permissions: [],
		});
	});

	it('requires approval when something was asked for, same origin or not', async () => {
		const permissions = [{type: 'delegation', required: true, chainId: 31337, contract: '0x0000'}];
		const {provider, last} = aProvider({permissions});
		await provider.init();
		await provider.connect({type: 'mnemonic', mnemonic: MNEMONIC, index: 0});
		const state = last();
		if (state.step !== 'SignedIn') throw new Error('not signed in');
		expect(state.requireOriginApproval).toEqual({
			windowOrigin: ORIGIN,
			signingOrigin: ORIGIN,
			permissions,
		});
	});

	// The interface is not narrowed (see "Parked" in the plan), so these exist and must say WHY they
	// cannot answer rather than failing as a missing method or a silent no-op.
	describe('the hosted half of the interface it does not implement', () => {
		it('refuses email, OTP and OAuth by name', async () => {
			const {provider} = aProvider();
			await provider.init();
			await expect(provider.provideEmail('someone@example.com')).rejects.toThrow(/hosted authentication/);
			await expect(provider.provideOTP('123456')).rejects.toThrow(/hosted authentication/);
			await expect(
				provider.confirmOAuth({type: 'oauth', provider: {id: 'google'}, usePopup: true}, new URLSearchParams(), {
					windowOrigin: ORIGIN,
					signingOrigin: ORIGIN,
					id: '1',
				}),
			).rejects.toThrow(/hosted authentication/);
		});

		it('refuses to connect a hosted mechanism', async () => {
			const {provider} = aProvider();
			await provider.init();
			await expect(provider.connect({type: 'email', email: 'someone@example.com', mode: 'otp'})).rejects.toThrow(
				/hosted authentication/,
			);
		});
	});
});
