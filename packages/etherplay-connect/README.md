# @etherplay/connect

Main connection library for Etherplay Accounts - provides seamless wallet and social authentication with session account management. This package combines Web3 wallet support with social login capabilities to create a unified authentication experience.

## Installation

```bash
npm install @etherplay/connect
# or
pnpm add @etherplay/connect
# or
yarn add @etherplay/connect
```

## Features

- **Web3 Wallet Support**: Connect via MetaMask, Coinbase Wallet, and other EIP-6963 compliant wallets
- **Social Login**: Authenticate via email OTP, Google, Facebook, or Auth0 through a popup flow
- **Mnemonic Login**: Direct authentication using BIP-39 mnemonic phrases
- **Session Accounts**: Generate origin-specific session accounts for enhanced security
- **Backend-Free Mode**: Sign in and derive a session signer with an injected wallet alone, no host and no server (see [Supported connection shapes](#supported-connection-shapes))
- **Auto-Connect**: Automatically reconnect returning users
- **Chain Management**: Built-in chain switching and validation
- **Svelte Integration**: Reactive state management via Svelte stores
- **Type-Safe**: Full TypeScript support with comprehensive type definitions

## Quick Start

### Basic Wallet Connection

```typescript
import {createConnection} from '@etherplay/connect';

// Create a connection targeting wallet connection only
const connection = createConnection({
	targetStep: 'WalletConnected',
	chainInfo: {
		id: 1,
		name: 'Ethereum',
		rpcUrls: {default: {http: ['https://eth.llamarpc.com']}},
		nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
	},
});

// Subscribe to connection state changes
connection.subscribe((state) => {
	if (state.step === 'WalletConnected') {
		console.log('Connected:', state.account.address);
	}
});

// Initiate wallet connection
await connection.connect({type: 'wallet'});
```

### Full SignedIn Flow with Social Login

```typescript
import {createConnection} from '@etherplay/connect';

const connection = createConnection({
	walletHost: 'https://wallet.etherplay.io', // Required for popup-based auth
	chainInfo: {
		id: 1,
		name: 'Ethereum',
		rpcUrls: {default: {http: ['https://eth.llamarpc.com']}},
		nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
	},
	autoConnect: true, // Auto-reconnect returning users
});

// Connect via email
await connection.connect({type: 'email', mode: 'otp', email: 'user@example.com'});

// Or via OAuth
await connection.connect({type: 'oauth', provider: {id: 'google'}, usePopup: true});
```

### Using ensureConnected

The `ensureConnected` method provides a promise-based API that resolves when the target connection state is reached:

```typescript
// Wait for wallet connection
const state = await connection.ensureConnected('WalletConnected');
console.log('Wallet connected:', state.account.address);

// Wait for full sign-in
const signedInState = await connection.ensureConnected('SignedIn');
console.log('Session account:', signedInState.account.signer.address);
```

#### What the target is

`ensureConnected` promises a **target**, not a step comparison, and does whatever reaching it takes. The target is reached when the connection is:

- **at or beyond `step`.** The steps are ordered (`SignedIn` implies `WalletConnected` implies `WalletChosen`), so a signed-in connection satisfies `ensureConnected('WalletConnected')` and resolves as itself.
- **on the wallet you named**, if you named one.
- **able to act as the address you named**, if you named one: connected, not locked, and actually holding that account. A connection already at the requested step but on a _different_ account initiates an attempt rather than resolving with somebody else.
- **on the right chain** — but only for a `WalletConnected` target, and unless you pass `{skipChainCheck: true}`. A `SignedIn` target does not check the chain (a session signer is chain-independent), so `skipChainCheck` does nothing there; read `wallet.invalidChainId` and offer `switchWalletChain()` if your signed-in app also sends through the wallet.

Anything you did not name is not part of the target, so a bare `ensureConnected()` behaves exactly as before.

An address or a wallet name **you** pass is a requirement. An address the library **replays** from the connection's own state (its locked-wallet reconnect does this) stays a preference and degrades to an ordinary connect, because nobody asked for it.

#### It always answers

There is no timeout, deliberately: a human is in the loop, so any timer is either long enough to be useless or short enough to cut a user off mid-decision, and it would report "timed out" about a wallet dialog that is open and healthy. The rule is narrower instead: **waiting is only legitimate while something is actually in progress.** It stays pending only while one of these is true, and every one of them is published on the connection so your app can render it and the user can answer it:

| Still pending because                                          | What the state says                                      | What ends it                                     |
| -------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| an attempt is running                                          | `step` is `WaitingForWalletConnection` / `PopupLaunched` | the wallet or the host answers                   |
| the wallet is holding a signature prompt                       | `step: 'WaitingForSignature'`                            | the user answers it                              |
| the user is choosing                                           | `step` is `MechanismToChoose` / `WalletToChoose`         | they pick, or `cancel()`                         |
| the user is picking an account                                 | `step: 'ChooseWalletAccount'`                            | `connectToAddress(...)`, or `cancel()`           |
| the wallet is on another account                               | `connection.addressUnavailable` (see below)              | they switch in the wallet, or acknowledge it     |
| the wallet is on another chain (`WalletConnected` target only) | `wallet.invalidChainId`                                  | `switchWalletChain()`, or they switch themselves |
| the signature has not been asked for                           | `step: 'WalletConnected'` with a `SignedIn` target       | `requestSignature()`, or see the note below      |

If the target is not satisfied, nothing is in progress and nothing can be initiated, that is an answer and it is delivered immediately rather than awaited. "In progress" includes an attempt this call has started that has not come back yet, even before that attempt has published anything. Every resting entry state is enumerated against this, crossed with every target and every kind of mechanism, in `test/ensure-connected-settles.test.ts`.

The last row is the one worth knowing about: with the default `requestSignatureAutomaticallyIfPossible: false`, a `SignedIn` target rests at `WalletConnected` waiting for **your** "sign in" button, because prompting over the top of it would ask for a signature you deliberately deferred. Pass `{requestSignatureRightAway: true}` (or set the store option) and `ensureConnected` asks for it itself.

#### How it initiates

- It initiates from `Idle`, from `WalletChosen` (the wallet is chosen; upgrading it is what you asked for), and from any resting state that does not satisfy the target, including one holding the wrong account.
- It initiates from a picker step (`MechanismToChoose`, `WalletToChoose`) that still carries the `error` of a previous failed attempt, so retrying after a rejected wallet prompt prompts again.
- It does not initiate from a picker step without an `error`: that means the user is making a choice right now and connecting would hijack it. It waits for the user to pick (or cancel) and settles then. Pass `{forceConnect: true}` to connect anyway.
- It rejects with a `ConnectionFailure` when the attempt fails. `cause` and the convenience `code` carry the underlying wallet error, so a user rejection is `code === 4001`.
- It rejects with `ConnectionFailure('Connection cancelled')` when the user backs out, including by acknowledging an `addressUnavailable`.

```typescript
import {ConnectionFailure} from '@etherplay/connect';

try {
	const state = await connection.ensureConnected('WalletConnected');
} catch (err) {
	if (err instanceof ConnectionFailure && err.code === 4001) {
		// the user rejected the wallet prompt, they can just try again
	}
}
```

### Asking for a specific account

Some sends only mean anything for one account. Replacing or cancelling a stuck transaction reuses its **original nonce**, so it has to be signed by the same key, and a signature from any other account is not a lesser answer, it is a wrong one. Name the account, and the wallet if you recorded it:

```typescript
await connection.ensureConnected(
	'WalletConnected',
	{type: 'wallet', name: 'Rabby', address: payerOfTheStuckTransaction},
	{doNotStoreLocally: true},
);
```

Call it **unconditionally**. Do not put an "are we already there" check in front of it: `connection.account.address` is the address the connection _agreed on_, not the one that can sign right now, and it is deliberately left untouched when the wallet locks, is revoked, or the user switches account behind the connection's back (`wallet.status` and `wallet.accountChanged` record those). A hand-written check on it passes for a locked wallet, skips the call that would have prompted the unlock, and the send then comes back `{code: 4001}` from the always-on provider, which is easy to report as "rejected by user" about a prompt nobody was shown.

To **render** readiness without initiating anything, ask `canActAs`:

```typescript
import {canActAs} from '@etherplay/connect';

// in an event handler, against the store's current state
const ready = connection.canActAs(address);
// in markup or a reactive block, against a state you already hold: it takes `$connection`, so it
// re-evaluates when the wallet locks. The method form would not, since a method call gives a
// reactive block nothing to depend on.
const readyToo = canActAs($connection, address);
```

It is false for a locked wallet, for a revoked one, and for a connection on another account, and it starts no flow. It reads `wallet.status` and the accounts the wallet is offering, so it is right about a wallet that has never been asked for accounts (a `WalletChosen` connection) as well as one that has been. Chain is not part of the answer: signing as an address is chain-independent, and `wallet.invalidChainId` is the separate question.

#### When the wallet is not on that account: `connection.addressUnavailable`

If the wallet cannot offer the address you named, the connection does **not** throw and does **not** tear the wallet down. It connects to what the wallet _does_ offer and comes to rest with a structured reason:

```typescript
type AddressUnavailable = {
	requested: `0x${string}`; // the address you asked for
	walletName?: string; // the wallet it went to
	selected?: `0x${string}`; // the account that wallet is on instead; absent if it offers none
	available: `0x${string}`[]; // the accounts it is exposing; empty if it has since locked
	message: string; // a sentence you can render as an instruction
};
```

The last three describe the wallet **as it is now**, not as it was when the attempt ran: they are re-derived whenever the wallet announces a change, because "switch to the account we need" is not advice anyone can follow if it names an account they have already left. If the wallet ends up offering `requested`, the state clears itself, since it has stopped being true.

It sits beside `error` rather than in it, because nothing failed: the wallet works, it is on another account, and only the user can move it. Render it as an instruction, not as a red banner:

```svelte
{#if $connection.addressUnavailable}
	<p>{$connection.addressUnavailable.message}</p>
	<button onclick={() => connection.acknowledgeAddressUnavailable()}>Cancel</button>
{/if}
```

Two ways out, and you have to offer both:

- **The user switches account in their wallet.** The original request then proceeds on its own and the promise resolves: somebody who has just done what was asked should not have to press anything in your app.
- **The user acknowledges it.** `acknowledgeAddressUnavailable()` clears the state and settles the pending `ensureConnected` as `ConnectionFailure('Connection cancelled')`, the same shape as any other "the user chose not to", so existing refusal handling covers it and nobody sees an error for a decision. The connection stays connected on the account the wallet is offering.

Only an address **you** named produces this. A replayed one degrades to an ordinary connect as it always did.

**One request at a time.** A connection has one wallet, one account and one such state, so two `ensureConnected` calls naming _different_ accounts cannot both stand: the newer supersedes, and the older is answered with a `ConnectionFailure` naming where the connection came to rest. It is **not** answered with `Connection cancelled`, because the user decided nothing — that message is reserved for `acknowledgeAddressUnavailable()`, and a dismissal answers only the request for the address it was showing. If you need two accounts ready at once, use two connections with different `storagePrefix`es (see "Running more than one connection in a page").

##### Wallets that only expose one account

`available` is **what the wallet is exposing right now, not what the user owns**, and the difference is not an edge case: MetaMask answers `eth_accounts` with every account the user has permitted, while Rabby (among others) answers with the one account it is currently on. So for a large share of users `available` has a single entry, the requested address is not in it, and the user is holding that address all along.

Two consequences for your UI:

- **Do not render `available` as an exhaustive account picker**, and do not read "the requested address is absent" as "the user does not have it". Show it as detail, and only when it has more than one entry. If you do offer its entries as a choice, say what choosing one MEANS: connecting to a different account abandons the request that produced this state, so the pending `ensureConnected` settles as a cancellation.
- **The instruction is the remedy.** `message` asks the user to switch to that account in their wallet, which is the only thing that works when the wallet exposes one at a time. Nothing in the app can pick an account the wallet is not offering.

That path is fully automatic on the library side: every wallet emits `accountsChanged` when the user switches, so the pending `ensureConnected` picks it up and proceeds to satisfy the original request. There is no "retry" button to wire, and pressing one would be redundant — at most one attempt is made per announcement the wallet makes, and an attempt never starts another off its own result.

There is deliberately no call that asks the wallet to open its own account picker (EIP-2255 `wallet_requestPermissions`). It would be a better remedy where it works, and it is a candidate for a later release, but it needs a new optional capability on the wallet-provider interface and support that varies per wallet; a button that silently does nothing on the wallets that lack it is worse than the sentence that works everywhere.

### What your UI has to render

`ensureConnected` has no timeout, on purpose, so a state where it waits is a state your app must **show**. These are cross-cutting: they are about the wallet, not about the step, so render them above your step switch rather than inside one branch. The demo does this in one component (`demoes/sveltekit/src/lib/NeedsTheUser.svelte`), which is the shortest description of the whole list:

| Read                                                 | Show                              | Remedy to offer                                        |
| ---------------------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| `wallet.status === 'locked'`                         | "your wallet is locked"           | `unlock()` (not `connect()`, which drops the wallet)   |
| `wallet.status === 'disconnected'`, `accountChanged` | "your wallet moved to 0x…"        | `connectToAddress(wallet.accountChanged)`              |
| `wallet.invalidChainId`                              | "your wallet is on another chain" | `switchWalletChain()`, showing `wallet.switchingChain` |
| `connection.addressUnavailable`                      | its `message`, as an instruction  | the user switches in the wallet, or acknowledge it     |
| `connection.pendingRequests`                         | what the wallet is asking for     | the user answers it in the wallet                      |
| `connection.error`                                   | the failure                       | `clearError()` and retry                               |

**A locked wallet is the one most likely to be missed**, and it became more visible with the target semantics: `step` stays `WalletConnected`, `account.address` still names the account that was agreed on, and only `wallet.status` (and `canActAs`) knows it cannot sign. A signed-in app is not exempt: its session account keeps working, but anything sent from the **wallet** account cannot be signed until the user unlocks.

## Supported connection shapes

There are three supported shapes. Pick one deliberately: they differ in what the user ends up with, and in what infrastructure you have to run.

| Shape                                                                     | `targetStep`        | `walletOnly`  | `walletHost` | Owner can be         | Session signer |
| ------------------------------------------------------------------------- | ------------------- | ------------- | ------------ | -------------------- | -------------- |
| [Hosted sign-in](#1-hosted-sign-in)                                       | `'SignedIn'`        | `false`       | **required** | wallet, email, OAuth | yes            |
| [Wallet-only sign-in, no backend](#2-wallet-only-sign-in-with-no-backend) | `'SignedIn'`        | `true`        | not used     | built-in wallet only | yes            |
| [Wallet connection only](#3-wallet-connection-only)                       | `'WalletConnected'` | always `true` | not used     | built-in wallet only | **no**         |

### 1. Hosted sign-in

The user may own their account through a built-in wallet **or** through a hosted email / OAuth / mnemonic mechanism, and a session signer is derived either way. The hosted mechanisms run in a popup served by `walletHost`, so this shape requires that host to be deployed and reachable.

```typescript
const connection = createConnection({
	targetStep: 'SignedIn',
	walletHost: 'https://wallet.etherplay.io', // required: popups are reachable
	chainInfo,
});
```

### 2. Wallet-only sign-in with no backend

Sign the user in and derive the session signer, but offer **only** built-in (injected / EIP-6963) wallets as the owner. No hosted mechanisms, no popup, and **no backend of any kind**.

```typescript
const connection = createConnection({
	targetStep: 'SignedIn',
	walletOnly: true,
	chainInfo,
	// note: no walletHost
});

const state = await connection.ensureConnected();
state.account.address; // the wallet account that owns the identity
state.account.signer.address; // the derived session account
state.account.signer.privateKey; // usable locally, right now
```

`walletHost` is **optional** here, and that is a deliberate part of the API rather than a side effect of how the overloads are written: on the `walletOnly: true` SignedIn overloads it is declared `walletHost?: string`, while on the `walletOnly?: false` SignedIn overloads it stays `walletHost: string`. A host is required exactly when a popup can be reached, and under `walletOnly` none can: `connect()` defaults the mechanism to `{type: 'wallet'}`, so the mechanism picker is never shown and the popup path is never entered. Passing a `walletHost` anyway is allowed and simply unused by this connection.

Everything about the session account is computed in the page:

1. The wallet signs `originKeyMessage(origin)`.
2. That signature is hashed into an entropy key (`fromSignatureToKey`).
3. The entropy key becomes a BIP-39 mnemonic, and the mnemonic derives the session account.

No request leaves the page, and the identity is reproducible: the same wallet signing the same origin always regenerates the same session account, which is what lets a returning user recover their signer with no server to ask. The origin signed over is `signingOrigin || origin`, so with no `signingOrigin` set it is the page's own origin.

This shape is covered end-to-end by `test/wallet-only-no-host.test.ts`, and the type surface described above is pinned by `test/types/wallet-only-no-host.types.ts`.

### 3. Wallet connection only

Connect a built-in wallet and stop there. No signature is requested and **no session signer exists**.

```typescript
const connection = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
});
```

This shape is wallet-only by definition, so `connection.walletOnly` is `true` whether or not you passed `walletOnly`, and the returned store is typed to say so.

### 4. Wallet choice for reads without connect (`WalletChosen`)

Pick an EIP-6963 wallet and use its provider for **reads**, without ever calling `eth_requestAccounts`. No connect popup, no account reveal, no signing. The motivating consumer is a blockchain indexer or read-only dashboard: it wants the user's own wallet as its node (a genuinely decentralised read path) but has no need for accounts, so requiring a connect prompt is friction that buys nothing.

```typescript
const connection = createConnection({
	targetStep: 'WalletChosen',
	chainInfo,
	prioritizeWalletProvider: true, // route reads through the wallet
	autoConnect: true, // restore the choice on reload, still without requesting accounts
});

// Let the user pick a wallet (auto-selects when only one is installed):
await connection.selectWallet();

// Reads (eth_chainId, eth_blockNumber, eth_getLogs, ...) now go through the wallet:
const blockNumber = await connection.provider.request({method: 'eth_blockNumber'});

// Signing and account-revealing methods are refused while the wallet is merely chosen:
await connection.provider.request({method: 'personal_sign', ...}); // rejected, code 4001

// Later, if the user wants to sign, the SAME wallet upgrades to WalletConnected:
await connection.connect({type: 'wallet'});
```

The resting step is `WalletChosen`: `wallet.provider` is set, `wallet.accounts` is empty and `wallet.status` is `'disconnected'`. `isTargetStepReached` / `ensureConnected()` treat `WalletConnected` and `SignedIn`-via-wallet as satisfying the lower target, so a WalletChosen-target store keeps working if the user upgrades.

**Handling the wallet picker.** With several wallets installed, `selectWallet()` (or `ensureConnected()`) lands on `WalletToChoose`. Nothing about that step distinguishes "pick to choose" from "pick to connect", and the wallet-picker handler in most apps is `connection.connect({type: 'wallet', name})` — which **upgrades**: it pops `eth_requestAccounts`, the exact friction this shape exists to avoid. On a WalletChosen-target store, wire the picker to call `connection.selectWallet(name)` instead. `connect()` stays available as the deliberate upgrade path; a `WalletConnected` outcome still satisfies the target.

**Failure semantics.** If an upgrade from `WalletChosen` fails (rejected accounts prompt, an empty accounts answer, a wallet that stops answering mid-way), the choice is **not** thrown away: the flow restores `WalletChosen` with reads still routed through the chosen wallet — even when the failed attempt targeted a different one — and sets the error on that state. The choice also survives a `back()`, which drops the live wallet from the state but keeps the persisted choice: a reload restores it through auto-connect. To drop the choice entirely, use `disconnect()` — or `cancel()`, which abandons the flow like `back()` but clears the persisted choice too.

This shape is wallet-only by definition, like shape 3, and the store is typed to say so.

### Do not use `walletHost` to detect whether the app has a session signer

A common downstream mistake is deciding "can this app have a local signer?" by testing whether a `PUBLIC_WALLET_HOST`-style environment variable is set. **That test is wrong**, because shapes 2 and 3 both run with no host and only one of them has a signer.

```typescript
// WRONG: reports no signer for a perfectly valid wallet-only SignedIn app
const hasSigner = !!PUBLIC_WALLET_HOST;

// RIGHT: the target step is what decides
const hasSigner = connection.targetStep === 'SignedIn';
```

`walletHost` answers a different question: "are hosted email/OAuth mechanisms available?" `targetStep` answers "does a signed-in state carry `account.signer`?" Use `connection.targetStep === 'SignedIn'`, or narrow the state with `connection.isTargetStepReached(state)`, which is typed to give you `account.signer` only when a signer really exists.

## Configuration

### createConnection Options

| Option                                    | Type                                                | Required    | Description                                                                                                                                                                                                                       |
| ----------------------------------------- | --------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chainInfo`                               | `ChainInfo`                                         | Yes         | Chain configuration including id, name, rpcUrls                                                                                                                                                                                   |
| `targetStep`                              | `'WalletChosen' \| 'WalletConnected' \| 'SignedIn'` | No          | Target connection step (default: `'SignedIn'`). `'WalletChosen'` picks the wallet for reads only — no accounts requested, signing refused; see [shape 4](#4-wallet-choice-for-reads-without-connect-walletchosen)                 |
| `walletOnly`                              | `boolean`                                           | No          | Offer only built-in (EIP-6963) wallets, no hosted mechanisms                                                                                                                                                                      |
| `walletHost`                              | `string`                                            | Conditional | URL for popup-based auth. Required for `targetStep: 'SignedIn'` **unless** `walletOnly: true`; never used by `targetStep: 'WalletConnected'` or `'WalletChosen'`. See [Supported connection shapes](#supported-connection-shapes) |
| `signingOrigin`                           | `string`                                            | No          | Sign for ANOTHER origin's account (defaults to the current origin). Refused unless that origin consents; see [Signing for another origin](#signing-for-another-origin)                                                            |
| `autoConnect`                             | `boolean`                                           | No          | Auto-reconnect returning users (default: `true`)                                                                                                                                                                                  |
| `walletConnector`                         | `WalletConnector`                                   | No          | Custom wallet connector (defaults to Ethereum)                                                                                                                                                                                    |
| `requestSignatureAutomaticallyIfPossible` | `boolean`                                           | No          | Auto-request signature after wallet connection                                                                                                                                                                                    |
| `useCurrentAccount`                       | `'always' \| 'whenSingle'`                          | No          | Always use current wallet account                                                                                                                                                                                                 |
| `prioritizeWalletProvider`                | `boolean`                                           | No          | Prioritize wallet for RPC calls                                                                                                                                                                                                   |
| `requestsPerSecond`                       | `number`                                            | No          | Rate limit for RPC requests                                                                                                                                                                                                       |
| `storagePrefix`                           | `string`                                            | No          | Namespace this connection's persisted state (default: `''`)                                                                                                                                                                       |

## Signing for another origin

`signingOrigin` asks for the account of an origin that is not this page: a page at `https://tournament.example` passing `signingOrigin: 'https://game.example'` is asking for the signer `game.example` derives, which is the whole of that account's authority there.

**Cross-origin requests are blocked by default.** The wallet host honours one only when the signing origin has recorded that it accepts requests from that origin, and even then the user is still asked (twice, where the consent was a blanket one rather than a naming of this specific site). With no consent recorded there is no prompt, because a screen asking someone to compare two domain names is not a decision they can make well.

A blocked request comes back as an error rather than as a cancellation, so an app can tell it from the user closing the popup:

```typescript
try {
	await connection.ensureConnected();
} catch (err) {
	// err is a ConnectionFailure; the wallet host's reason is on `cause`
	if ((err as ConnectionFailure).cause?.type === 'cross-origin-blocked') {
		// {type, message, windowOrigin, signingOrigin}
	}
}
```

Almost every occurrence of this error is a `signingOrigin` that should not have been set. Unset, the page signs for itself.

**The supported way to act for another app's user is your own delegate.** Sign in normally, so you hold your own origin signer, and have the user register that signer at the contract with `registerDelegate`. It costs a transaction, and in exchange the authority is yours: bounded to that contract, revocable on its own, and independent of anything the other app holds. Delegation contracts authorize many delegates, so nothing has to be displaced to make room for you.

One limit worth stating plainly. This is a rule about what **the wallet host** hands over, and it covers hosted (email, OAuth) accounts. In the wallet-only shape the page asks the user's own wallet to sign `originKeyMessage(signingOrigin)` with no host in the loop, and nothing here is consulted: the message text in the wallet's own dialog is the only gate there.

## Running more than one connection in a page

A page may run several connections at once, and that is a supported configuration. The common case is a **player** connection (hosted sign-in, `targetStep: 'SignedIn'`) plus a separate **payment** connection (`targetStep: 'WalletConnected'`, `autoConnect: false`), so whoever pays need not be the account the player signed in as.

The one thing you must do is give each connection its own `storagePrefix`.

```typescript
import {createConnection} from '@etherplay/connect';

const chainInfo = {
	id: 1,
	name: 'Ethereum',
	rpcUrls: {default: {http: ['https://eth.llamarpc.com']}},
	nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
};

// Who the player IS. Auto-reconnects on the next page load.
export const player = createConnection({
	walletHost: 'https://wallet.etherplay.io',
	chainInfo,
	storagePrefix: 'player:',
});

// Who PAYS. A different account is fine, and expected.
export const payment = createConnection({
	targetStep: 'WalletConnected',
	chainInfo,
	autoConnect: false,
	storagePrefix: 'payment:',
});

// At checkout:
const payer = await payment.ensureConnected({doNotStoreLocally: true});

// Later, to replace or cancel a stuck payment: it reuses the original nonce, so it must be signed
// by the SAME key. Name the account (and the wallet, if you recorded which one paid).
await payment.ensureConnected(
	'WalletConnected',
	{type: 'wallet', name: walletThatPaid, address: payerOfTheStuckTransaction},
	{doNotStoreLocally: true},
);
```

A payment rail whose wallet is re-picked per payment is the case that most needs the named account, and the one where the user is most likely to be on a different one by the time it matters. See "Asking for a specific account" above, including `connection.addressUnavailable`, which is what the flow rests on when the wallet is not on the account the replacement needs.

### What `storagePrefix` does

Each connection persists two entries, in both `localStorage` and `sessionStorage`:

| Key                                | Written by                           | Read by                     |
| ---------------------------------- | ------------------------------------ | --------------------------- |
| `${storagePrefix}__origin_account` | sign-in (unless `doNotStoreLocally`) | auto-connect (`SignedIn`)   |
| `${storagePrefix}__last_wallet`    | every successful wallet connection   | auto-connect (both targets) |

`storagePrefix` defaults to `''`, so a single-connection app keeps exactly the keys `__origin_account` and `__last_wallet` it has today. Nothing migrates, and adding a prefix to an existing connection starts it from a clean slate.

With distinct prefixes, two connections never read or write each other's entries, for sign-in, for the remembered last wallet, for `disconnect()` and for `cancel()`. Without them they share one identity slot and one last-wallet slot and silently overwrite each other: connecting the payment wallet would make the player connection auto-reconnect as the payer on the next page load, and `payment.disconnect()` would wipe the player's stored identity.

### `doNotStoreLocally` does not cover the last wallet

`doNotStoreLocally` suppresses saving the **origin account** only. The last wallet is always remembered, deliberately: it is a useful hint on the next purchase, and namespaced it can no longer collide with the player's. If you do not want a payment wallet remembered at all, call `payment.disconnect()` when you are done, which clears the payment namespace and nothing else.

### Wallet discovery is safe with any number of connections

You do not need to share a `walletConnector` between connections. EIP-6963 discovery is page-wide, so connections created close together see each other's provider requests, but announcements are deduplicated (by `info.uuid`, falling back to `info.rdns`). One installed wallet is listed once per connection, and a single-wallet page still connects directly instead of stopping at a `WalletToChoose` picker.

> Known limitation, unchanged: the Ethereum connector listens for EIP-6963 announcements for 100 ms after construction. A wallet that announces later than that is not listed.

## Connection States

The connection follows a state machine with these primary steps:

| Step                         | Description                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `Idle`                       | Initial state, not connected                                                                        |
| `MechanismToChoose`          | Waiting for auth mechanism selection                                                                |
| `WalletToChoose`             | Multiple wallets available, waiting for selection                                                   |
| `WaitingForWalletConnection` | Connecting to selected wallet                                                                       |
| `ChooseWalletAccount`        | Multiple accounts available, waiting for selection                                                  |
| `WalletChosen`               | Wallet picked for reads only: no accounts requested, signing refused (`targetStep: 'WalletChosen'`) |
| `WalletConnected`            | Wallet connected (target for `WalletConnected` mode)                                                |
| `WaitingForSignature`        | Waiting for user to sign message                                                                    |
| `PopupLaunched`              | Popup opened for social login                                                                       |
| `SignedIn`                   | Fully authenticated with session account                                                            |

### Where a failed attempt comes to rest

`Idle`, `MechanismToChoose` and `WalletToChoose` are the resting steps: the flow is attempting nothing and waits for a user decision. When an attempt fails, the flow rests on the step that offers the user a real next decision, and never on a step your app has no reason to render:

| Mode                                  | Resting step after a failure                             |
| ------------------------------------- | -------------------------------------------------------- |
| Multi-mechanism                       | `MechanismToChoose`, the user can pick another mechanism |
| Wallet-only, several wallets detected | `WalletToChoose`, the user can pick another wallet       |
| Wallet-only, a single (or no) wallet  | `Idle`, there is no choice left to offer                 |

The `error` is kept in every case, so the UI can explain the failure next to the picker (or on the connect button when back at `Idle`). Wallet-only mode never shows a mechanism picker (`connect` defaults the mechanism to `{type: 'wallet'}`), which is why a failure there never rests on `MechanismToChoose`.

The exception is a failed UPGRADE from `WalletChosen`: a wallet that was chosen for reads stays chosen. The flow restores `WalletChosen` — with reads still routed through the wallet — and sets the error on that state, on the principle that a refused accounts prompt must not silently deselect the user's read path.

And the mirror rule: every resting state above has `wallet: undefined`, and reaching one (via failure, `cancel()`, or `back()`) tears the live wallet down — the provider stops routing requests, and signing requests, through it. It used to be possible for an `Idle` state to keep signing through a wallet it no longer showed.

Auto-connect failures rest on `Idle`: the user asked for nothing, so there is no decision to offer them.

### Wallet State Properties

When connected via wallet, additional state is available:

```typescript
interface WalletState {
	provider: WalletProvider;
	accounts: `0x${string}`[];
	accountChanged?: `0x${string}`; // Set if user switched accounts
	chainId: string;
	invalidChainId: boolean; // True if on wrong chain
	switchingChain: 'addingChain' | 'switchingChain' | false;
	status: 'connected' | 'locked' | 'disconnected';
	/** @deprecated read `connection.pendingRequests` instead; see below */
	pendingRequests: PendingRequest[];
}
```

### What the user's wallet is holding: `connection.pendingRequests`

Every request this library sends to the user's wallet is announced on `connection.pendingRequests` for the whole time the wallet is holding it, so your app can explain the popup it raised, offer to cancel, and warn before an unload. A wallet popup carries no provenance of its own: it does not say which app asked or what for, which is exactly the shape a phishing prompt takes.

```typescript
connection.subscribe(($connection) => {
	for (const request of $connection.pendingRequests) {
		// request.kind: 'transaction' | 'signature'
		// request.purpose: 'delegation' | 'public-key-publication' | undefined (absent = your own request)
		// request.account: who is expected to answer it
	}
});
```

**It sits beside `wallet`, not inside it, and that is the point.** The list describes what the always-on wrapper is holding, and the wrapper outlives any particular wallet state. A request is outstanding until the user answers it, and in the meantime the connection is free to rebuild its wallet state, or to have no wallet state at all:

- a send against a **locked** wallet raises the connection flow while the wallet is still holding the transaction that raised it;
- a reconnect that then **fails** comes to rest on a step with `wallet: undefined`, and stays there for as long as the user leaves it.

The prompt is on the user's screen throughout. Reading the list off `wallet` meant losing it in exactly those moments, which is the bug this replaces: see `docs/adr/0001-wallet-requests-are-announced-through-the-wrapper.md`.

`wallet.pendingRequests` is still populated, is always the same list, and is **deprecated**. Move to `connection.pendingRequests`; the wallet-level copy will go in a later major version.

One request is deliberately NOT announced here: the sign-in signature, which has its own `step: 'WaitingForSignature'`. Consumers open a "please sign" dialog from that step and a separate modal from this list, so announcing it in both would stack two. The ADR records that exception and why it is the only one.

## Authentication Mechanisms

Wallet authentication needs no `walletHost`. The three popup mechanisms below do, and under `walletOnly: true` they are unavailable: the types do not offer them, and forcing one through anyway throws `walletHost is required for popup-based authentication (email, oauth, mnemonic)` rather than attempting a popup.

### Wallet Authentication

```typescript
// Auto-select wallet if only one available
await connection.connect({type: 'wallet'});

// Connect to specific wallet by name
await connection.connect({type: 'wallet', name: 'MetaMask'});

// Connect to specific address
await connection.connect({
	type: 'wallet',
	name: 'MetaMask',
	address: '0x1234...',
});
```

### Email OTP (requires walletHost)

```typescript
await connection.connect({
	type: 'email',
	mode: 'otp',
	email: 'user@example.com',
});
```

### OAuth (requires walletHost)

```typescript
// Google
await connection.connect({
	type: 'oauth',
	provider: {id: 'google'},
	usePopup: true,
});

// Facebook
await connection.connect({
	type: 'oauth',
	provider: {id: 'facebook'},
	usePopup: true,
});

// Auth0
await connection.connect({
	type: 'oauth',
	provider: {id: 'auth0', connection: 'your-connection'},
	usePopup: true,
});
```

### Mnemonic (requires walletHost)

```typescript
await connection.connect({
	type: 'mnemonic',
	mnemonic: 'your twelve word phrase here...',
	index: 0,
});
```

The host derives this one itself, in the popup, from the phrase: no account at any service, no key
and no network. It still needs a `walletHost` because that popup is where the derivation happens,
but the host does not need to be configured with a provider's credentials to answer it.

### `VITE_AUTH_PROVIDER`, and what it does not decide

This library appends `?provider=` to every popup URL, read from the app's own `VITE_AUTH_PROVIDER`
(default `openfort`). It means **which hosted provider the host should use for email and OAuth**,
and nothing else.

It cannot mean anything else: it is chosen once, at the app's build time, and sent for every
mechanism, so an app that wants both hosted email and a local mnemonic sign-in has one value to say
two things with. The host therefore routes by MECHANISM, and never consults this value for
`mnemonic`. Deliberately not made per-mechanism here: which mechanisms a host answers itself is host
implementation knowledge, and putting it in this library would oblige every third-party client to
reproduce it and then drift from it.

## API Reference

### ConnectionStore Methods

| Method                                         | Description                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `subscribe(callback)`                          | Subscribe to state changes                                                                              |
| `connect(mechanism?, options?)`                | Initiate connection from the user's choice; bare, with no wallet named, opens the picker                |
| `cancel()`                                     | Cancel ongoing connection and drop the wallet                                                           |
| `back(step)`                                   | Navigate back to previous step (drops the wallet)                                                       |
| `disconnect()`                                 | Disconnect and clear stored data                                                                        |
| `selectWallet(name?, options?)`                | Pick a wallet for reads without connect (`WalletChosen`); `options.doNotStoreLocally` skips persistence |
| `requestSignature()`                           | Request signature for session account                                                                   |
| `connectToAddress(address, options?)`          | Connect to specific wallet address                                                                      |
| `switchWalletChain(chainInfo?)`                | Switch wallet to different chain                                                                        |
| `unlock()`                                     | Prompt a locked wallet, keeping step, account and wallet (see "What to call on a locked wallet")        |
| `ensureConnected(step?, mechanism?, options?)` | Promise-based connection to a TARGET: step, wallet, account, chain. Reconnects a locked wallet          |
| `canActAs(address)`                            | Can this connection sign as that address right now? Reads state, initiates nothing                      |
| `acknowledgeAddressUnavailable()`              | Dismiss `connection.addressUnavailable`; settles a waiting `ensureConnected` as cancelled               |
| `isTargetStepReached(connection)`              | Check if target step is reached                                                                         |
| `getSignatureForPublicKeyPublication()`        | Get signature for public key                                                                            |
| `getDelegation(target)`                        | Get a delegation credential                                                                             |

### `getSignatureForPublicKeyPublication()`

Despite the name, this needs **no `walletHost` and no backend**. It does not publish anything: it returns a signature that authorizes your session public key to represent your account, which your own application then publishes wherever it wants.

Availability depends on the mechanism the user signed in with, not on whether a host is configured:

- **Wallet mechanism** (always the case under `walletOnly: true`): the connected wallet signs `originPublicKeyPublicationMessage(origin, publicKey)` locally. Fully available in the backend-free shape.
- **Popup mechanisms** (email / OAuth / mnemonic): returns `account.savedPublicKeyPublicationSignature` if the hosted sign-in produced one, and otherwise throws `no saved public key publication signature for <address>`. There is currently no way to sign it after the fact for these mechanisms.

It throws `Not signed in` unless `step === 'SignedIn'`, so it is unavailable in the `targetStep: 'WalletConnected'` shape, which has no session public key to authorize.

### `account.savedDelegations`

Credentials authorizing the session signer to **act onchain for the account**, so a contract can verify "account A allows signer S to act for it" and attribute S's transactions to A. A separate authorization from the public-key one on purpose: a user who authorized an encryption key has not thereby authorized a key that spends gas and posts in their name.

**A list, not a field, because authority is per contract.** Each credential names one `(chainId, contract)` pair and is worth nothing anywhere else: the contract's own address is inside the bytes the owner signed, and the verifying contract reads it from `address(this)` rather than from the caller. There is deliberately no shared registry to point at, since that would make every credential valid at every contract on it.

```typescript
type SavedDelegation = {
	chainId: number;
	contract: `0x${string}`;
	delegate: `0x${string}`; // always signer.address today; makes the record self-describing
	deadline: number; // unix seconds after which it can no longer be registered; 0 = no expiry
	signature: `0x${string}`;
};
```

Ask for them at connect time with `permissions` (see the root README, "Acting onchain for the user"), and read `account.permissions` for the answer to **every** entry, granted or not: an absent credential does not say whether the user declined, whether this wallet was too old to understand the request, or whether the app never asked, and those call for different remedies.

### `getDelegation({chainId, contract, deadline?})`

The credential authorizing this session's signer to act for the account at one contract, from whichever source that mechanism has.

- **Hosted account** (email / OAuth / mnemonic): returns the record minted at sign-in, if the app declared that pair in `permissions`. It cannot sign after the fact, so a missing one throws and the remedy is to sign in again; read `account.permissions` to say why it is missing.
- **Wallet mechanism**: asks the connected wallet to sign now. Nothing needs declaring at connect time, and nothing is minted for a contract the app never touches.

It returns the whole `SavedDelegation` record rather than the signature alone, deliberately: a signature is unusable without the exact `delegate` and `deadline` it was made over, since both are inside the signed bytes. That also makes it interchangeable with `findSavedDelegation`.

`deadline` defaults to 0, meaning no expiry. On a hosted account a stored credential only answers a request naming the same deadline it was signed with, since a different one would be different bytes.

Credentials are minted at sign-in on popup mechanisms (email / OAuth / mnemonic), because a hosted account holds its key at the wallet host and exposes no live arbitrary-signing capability: sign-in is the only moment they can be produced. On the wallet mechanism the list is empty, since the connected wallet is right there and can sign for whatever contract is needed at the moment it is needed. The registration transaction is submitted and paid for by somebody else, so the account itself never needs gas: it signs, another party submits.

**Every field is a cache of what is inside the signature**, not metadata beside it. A stored copy that disagrees with the signed copy cannot be detected locally, the signature simply fails to recover, so treat a failure on the signature path as "discard this record and sign in again" rather than as a contract error. That makes any disagreement self-healing.

**The wording is consensus, not style.** The message lives in [`@etherplay/delegation`](../etherplay-delegation/README.md) next to the Solidity that verifies it, and both are pinned against a shared `vectors.json` from both languages. Changing either side without the other and the vectors, in the same commit, silently invalidates every signature ever generated.

### What to call on a locked wallet, and why `connect()` is not it

`connect()` and `ensureConnected()` behave **differently** on a wallet that has gone locked, and that is deliberate. It is the most surprising thing in this API from the outside, so it is worth reading once:

| Call                | What it promises                               | On a `WalletConnected` wallet that is `locked`                                |
| ------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `unlock()`          | Make this wallet usable again                  | Prompts the wallet. Keeps the step, the account, the mechanism and the wallet |
| `ensureConnected()` | Reach a target step, doing whatever that takes | Reconnects that wallet: it cannot deliver a usable connection otherwise       |
| `connect()` (bare)  | Start the flow from the user's choice          | Opens the wallet picker, which drops the current wallet                       |

**On a locked wallet, call `unlock()`.** It is the narrowest of the three and the only one that rebuilds nothing. `wallet.status` is published exactly so your UI can route on it: render an "Unlock" button when it says `locked`, rather than your "Connect" one. For `status: 'disconnected'` (the user moved to an account this connection is not on), the equivalent is `connectToAddress(wallet.accountChanged)`.

**`connect()` is not a repair tool and does not try to be.** A bare `connect()` means "the user wants to connect something": with nothing naming a wallet it opens the picker, from any state, including one that already has a wallet. That is what makes a switch-wallet button work, and it does not change meaning based on `wallet.status`. To connect a specific wallet without the picker, name it: `connect({type: 'wallet', name})`.

**`ensureConnected()` is the one that may reconnect**, because it promises a usable connection at a target step and cannot keep that promise on a locked wallet. If what you want is "make sure I can send", that is the call, and it handles the locked case for you.

One consequence worth stating plainly, because it used to be worse than it is: the picker drops the current wallet, so a bare `connect()` on a locked wallet loses the wallet binding (and, from `SignedIn`, the session with it). **What it does not lose is the announcement.** Anything the wallet is still holding stays on `connection.pendingRequests` throughout, with the account it is waiting on, so your app can still explain the popup, offer to cancel, and warn before unload. Erasing that is the bug that made this asymmetry look destructive, and it is fixed: see "What the user's wallet is holding" above.

The reasoning, including the version of this that made `connect()` reconnect too and why it was rejected, is in `docs/adr/0002-connect-ensure-connected-and-unlock-are-three-promises.md`.

**On accounts.** `ensureConnected()`'s reconnect replays the address the connection was on, so an ordinary unlock comes back to the same account rather than bouncing a multi-account user into `ChooseWalletAccount`. If the user unlocks on a _different_ account, the replayed address is treated as a preference and the reconnect lands on the account the wallet actually offers, with `mechanism.address` and `account` updated to say so.

An address YOU name is a requirement, and the two entry points answer an impossible one differently, on purpose:

- `connectToAddress(a)` and `connect({type: 'wallet', address: a})` **fail the attempt**, unchanged. `connect` drives the flow from the user's choice and has no promise to settle, so a demand it cannot meet is an error.
- `ensureConnected(step, {type: 'wallet', address: a})` **rests on `connection.addressUnavailable`** instead: it connects to what the wallet does offer, keeps the wallet, and publishes what was asked for beside what the wallet is on, so the app can tell the user which account to switch to. Switching resolves the original call; acknowledging settles it as cancelled. See "Asking for a specific account" above.

### Connect Options

```typescript
interface ConnectOptions {
	requireUserConfirmationBeforeSignatureRequest?: boolean;
	doNotStoreLocally?: boolean;
	requestSignatureRightAway?: boolean;
}
```

### EnsureConnected Options

```typescript
interface EnsureConnectedOptions extends ConnectOptions {
	skipChainCheck?: boolean; // Skip chain validation for WalletConnected step
	forceConnect?: boolean; // Initiate even from a picker the user is mid-choice on
}
```

`ConnectOptions.requestSignatureRightAway` is worth knowing here too: with a `SignedIn` target on an
already-connected wallet it is what lets `ensureConnected` ask for the signature itself, instead of
resting at `WalletConnected` waiting for your own "sign in" button.

## Origin Account Structure

When fully signed in, the account includes:

```typescript
interface OriginAccount {
	address: `0x${string}`; // Main wallet address
	signer: {
		origin: string; // Origin used for signing
		address: `0x${string}`; // Derived session address
		publicKey: `0x${string}`; // Session public key
		privateKey: `0x${string}`; // Session private key
	};
	metadata: {
		email?: string;
	};
	mechanismUsed: Mechanism;
	savedPublicKeyPublicationSignature?: `0x${string}`;
	savedDelegations: SavedDelegation[]; // one per granted (chainId, contract)
	permissions?: PermissionOutcome[]; // an answer for every permission the app requested
	accountType: string;
}
```

## Type Helpers

### isTargetStepReached

Type guard to narrow connection state:

```typescript
import {isTargetStepReached} from '@etherplay/connect';

connection.subscribe((state) => {
	if (isTargetStepReached(state, 'SignedIn')) {
		// state is now typed as SignedInState
		console.log(state.account.signer.address);
	}
});
```

## Svelte Integration

The connection store implements the [Svelte store contract](https://svelte.dev/docs/svelte/stores#Store-contract) and works seamlessly with Svelte's reactivity. Note that this package does **not** depend on `svelte` itself: it uses [`sveltore`](https://www.npmjs.com/package/sveltore), a standalone copy of Svelte's store implementation, so it can be used from any framework (or none) without pulling in Svelte.

```svelte
<script>
  import { createConnection } from '@etherplay/connect';

  const connection = createConnection({
    chainInfo: { id: 1, name: 'Ethereum', rpcUrls: { default: { http: ['...'] } } }
  });
</script>

{#if $connection.step === 'Idle'}
  <button on:click={() => connection.connect()}>Connect</button>
{:else if $connection.step === 'SignedIn'}
  <p>Connected as {$connection.account.address}</p>
  <button on:click={() => connection.disconnect()}>Disconnect</button>
{/if}
```

In a Svelte app the `$` auto-subscription and helpers such as `get`/`derived` from `svelte/store` work on these stores as-is, because the contract is the same.

## Server-side rendering (SSR)

`createConnection(...)` is safe to call in any JavaScript environment, including a Node SSR / prerender pass with no DOM. This is a tested property of the package (`test/ssr-inert.test.ts`), not an accident: the regression test runs in vitest's `node` environment with no `window`, `document`, `localStorage` or `sessionStorage`, constructs both supported configurations, and asserts no throw, the exact initial store value, no storage access, and no pending timers/intervals.

### What is guaranteed off-browser

- **Construction never throws and does no I/O.** No `window`, `document`, `localStorage`, `sessionStorage`, `navigator`, `crypto`, timers, intervals, or network requests are touched during `createConnection(...)`. The only thing it builds is in-memory state.
- **Nothing auto-connects without a `window`.** The entire auto-connect block (which reads saved accounts / last wallet from `localStorage` and polls installed wallets) is behind a `typeof window !== 'undefined'` guard, as is `fetchWallets()` in the Ethereum connector. Off-browser both are no-ops.
- **The store rests at `{step: 'Idle', loading: true, wallets: [], pendingRequests: []}`.** This is the exact same value a browser renders on its very first paint (before the auto-connect promise has resolved), so a server-rendered app hydrates with no store mismatch.

### Why `loading` stays `true` off-browser

Off-browser the auto-connect block is skipped entirely (no `window`), so the store keeps its initial `loading: true` rather than transitioning to `loading: false`. This is deliberate: it matches the browser's first render exactly. A browser also starts at `loading: true` and only flips to `false` once auto-connect has run its course. Keeping the server value identical means SSR output and the first client render agree, and hydration does not flash or remount.

> **Hydration-visible breaking change:** the value of `loading` (and the shape of the initial store object) at construction is part of the SSR contract. Changing it — for example resting at `loading: false` off-browser, or adding/removing a field — produces a mismatch between server-rendered and client-hydrated markup for any consumer that renders the store during SSR. Treat such a change as a breaking change for consumers and version it accordingly.

With `autoConnect: false` the behaviour differs: the explicit `else` branch sets `loading: false` immediately, since there is nothing to wait for. This is also deterministic and SSR-safe.

### What is only reachable from user-initiated flows

The following DOM/browser access exists in the package but is only ever reached when a user acts (calling `connect()`, `requestSignature()`, `disconnect()`, etc.), never from `createConnection()` itself:

- `localStorage` / `sessionStorage` reads and writes (`getOriginAccount`, `saveOriginAccount`, `deleteOriginAccount`, `getLastWallet`, `saveLastWallet`, `deleteLastWallet`). These helpers reference the storage globals directly; they are only invoked from the window-guarded auto-connect path or from explicit connect/disconnect actions.
- `window.crypto?.subtle` (the Same-Origin Callback Bridge key setup in `connect()`), guarded by `typeof window !== 'undefined' && window.crypto?.subtle`.
- `window.open`, `window.addEventListener('message', ...)`, `BroadcastChannel`, and `window.origin` in the popup launcher (`popup.ts`), used only from `connect()`.
- `location.href` in `connectViaPopup`, used only from `connect()`.
- The Web-Crypto helpers in `@etherplay/connect-core` (`generateEcdhKeyPair`, `exportPublicKeyB64`, `importPublicKeyB64`, `deriveAesKey`), which call `window.crypto.subtle`; only invoked from the domain-redirect bridge path inside `connect()`.
- The Openfort provider (`@etherplay/openfort`) only touches `window` / `location` from its `connect()` / `confirmOAuth()` methods, and `createOpenfortProvider()` is not invoked by `createConnection()` at all.

No DOM shim is required or recommended. The goal is genuine environment independence, not a simulated browser.

### `connection.provider.request(...)` off-browser (intended behaviour — read this)

The `provider` exposed on the store is the **always-on** provider. Its purpose is to serve read-only JSON-RPC (`eth_call`, `eth_blockNumber`, `eth_getBalance`, etc.) against the configured `chainInfo` RPC URL _even before a wallet is connected_ — that is its design. Non-signing methods are routed to the JSON-RPC endpoint via `fetch`.

Off-browser, Node provides a real global `fetch`, so `connection.provider.request(...)` for a non-signing method **performs a real network RPC request from the server**. Signing / wallet-only methods (`personal_sign`, `eth_sendTransaction`, `eth_requestAccounts`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, …) correctly reject with `wallet provider is not connected` when no wallet is set, so those are safe off-browser.

**This is intended and supported**, and the behaviour is deliberately left as-is:

- The always-on read path is a feature: a server render that needs chain state can read it without a wallet. Making `provider.request` reject off-browser would break legitimate server-side reads for consumers that want them.
- The package does not, and cannot, know whether a given consumer wants SSR-time reads or a fully IO-free render. It leaves that decision to the consumer.

**Footgun to be aware of:** if your SSR / prerender pass touches `connection.provider` (directly or via code that reads chain state), it will do live RPC IO at build/render time — hitting the configured RPC endpoint, subject to its rate limits, and requiring network at build time. If you want a fully IO-free SSR (as the `jolly-roger` template does — it constructs the runtime but never uses the provider during SSR), simply do not call `provider.request(...)` during the server render, or guard such calls with `typeof window !== 'undefined'` / a `connection.step` check. Constructing the store alone never touches the provider.

## Utility Exports

```typescript
// Re-exported from @etherplay/alchemy
export {
	fromEntropyKeyToMnemonic,
	originPublicKeyPublicationMessage,
	originKeyMessage,
	delegationMessage,
	delegationDigest,
	DELEGATION_ABI,
	findSavedDelegation,
};
export type {OriginAccount};

// Re-exported from @etherplay/wallet-connector-ethereum
export type {UnderlyingEthereumProvider};
```

## Related Packages

- [`@etherplay/wallet-connector`](../etherplay-wallet-connector) - Core wallet connector interfaces
- [`@etherplay/wallet-connector-ethereum`](../etherplay-wallet-connector-ethereum) - Ethereum wallet connector
- [`@etherplay/alchemy`](../etherplay-alchemy) - Social login mechanisms

## License

MIT
