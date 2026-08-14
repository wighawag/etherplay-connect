<script lang="ts">
	import {onMount} from 'svelte';
	import OAuth from './mechanism/OAuth.svelte';
	import Email from './mechanism/Email.svelte';
	import Loading from './Loading.svelte';
	import {debug} from './state';
	import type {AuthProvider} from '@etherplay/connect-core';
	import Mnemonic from './mechanism/Mnemonic.svelte';
	import {
		deriveOriginAccount,
		generateEcdhKeyPair,
		importPublicKeyB64,
		deriveAesKey,
		bufToB64,
		exportPublicKeyB64,
		resolvePermissions,
		deniedRequiredPermissions,
		delegationsToSign,
		resolveAccess,
		autoSignLookup,
		confirmAccess,
		confirmationsRequired as confirmationsRequiredFor,
		crossOriginBlockedError,
	} from '@etherplay/connect-core';
	import type {
		AccessDecision,
		CrossOriginBlocked,
		OriginApprovalRequest,
		PermissionOutcome,
		PermissionRequest,
	} from '@etherplay/connect-core';
	import type {AccountGenerator} from '@etherplay/wallet-connector';
	import Permissions from './Permissions.svelte';
	import type {ApprovalUI} from './approval';
	import {
		allowlistFor,
		autoSignedDeadline,
		PROMPTED_DEADLINE,
		crossOriginConsentFor,
		ALLOW_LOOPBACK_REQUESTERS,
	} from './allowlist';

	let {
		authProvider,
		accountGenerator,
		from,
	}: {
		authProvider: AuthProvider;
		accountGenerator: AccountGenerator;
		from: {
			source?: MessageEventSource;
			windowOrigin: string;
			signingOrigin: string;
			requestID: string;
			domainRedirectPublicKey?: string;
			canCloseAutomatically: boolean;
		};
	} = $props();

	function cancelOnClose() {
		_cancel();
	}

	// ------------------------------------------------------------------------------------------
	// APPROVAL
	//
	// Enforcement is that the opener DOES NOT RECEIVE THE THING. Nothing below asks the app to
	// behave, and nothing hands it a result with a flag saying which parts it should ignore: an
	// entry that was not granted produces no credential, and the whole result is withheld until
	// every entry has an answer.
	//
	// The decisions live here, in the host, rather than in `AuthState`: the auth provider says what
	// is being ASKED for, this component records what was ANSWERED.
	// ------------------------------------------------------------------------------------------

	let approvalInitialised = $state(false);
	// Starts denied. The gate is only lowered by an explicit grant or by there being no gate.
	let accessGranted = $state(false);
	let access = $state<AccessDecision | undefined>(undefined);
	let confirmationsRequired = $state(1);
	let confirmationsGiven = $state(0);
	// A refusal this host has already settled on, kept so that whatever this window ends up telling
	// the opener, it tells it THIS. Closing a window that was refused is not a change of mind, and
	// reporting it as a cancellation is what makes an app retry the thing that was refused.
	let refusal = $state<CrossOriginBlocked | undefined>(undefined);
	let outcomes = $state<PermissionOutcome[]>([]);
	let pending = $state<PermissionRequest[]>([]);

	async function initialiseApproval(approval: false | OriginApprovalRequest) {
		if (approvalInitialised) {
			return;
		}
		approvalInitialised = true;

		if (!approval) {
			access = {kind: 'same-origin'};
			accessGranted = true;
			return;
		}

		// WHETHER THIS WINDOW MAY BE SIGNED FOR AT ALL, answered first and by the host rather than by
		// the person reading the screen. A cross-origin request with nobody's consent behind it is
		// refused here, not prompted: a third party that wants to act for this user has its own origin
		// signer and an onchain registration to reach for, which is bounded and separately revocable.
		const decision = await resolveAccess(
			{windowOrigin: approval.windowOrigin, signingOrigin: approval.signingOrigin},
			{consentFor: crossOriginConsentFor, allowLoopbackRequesters: ALLOW_LOOPBACK_REQUESTERS},
		);
		access = decision;

		if (decision.kind === 'blocked') {
			// Told to the app IMMEDIATELY, and as its own kind of refusal. "Blocked" and "the user closed
			// the popup" call for opposite remedies: one is retried, the other is a misconfigured
			// `signingOrigin` or a prompt to register a delegate onchain. `accessGranted` stays false, so
			// nothing is derived, nothing is signed and nothing is delivered.
			//
			// Recorded as well as reported, so that whenever this window ends up telling the opener
			// anything, it tells it THIS. Without that, an opener reference that only arrives later
			// would receive "canceled" when the user closes the window, which is the one message that
			// makes the app retry the thing that was refused.
			refusal = crossOriginBlockedError({
				windowOrigin: approval.windowOrigin,
				signingOrigin: approval.signingOrigin,
			});
			// Guarded on `from.source` because `_cancel` closes the window when there is nobody to tell,
			// and here that would take the explanation off the screen of the one person still present.
			if (from.source) {
				_cancel(refusal);
			}
			return;
		}

		accessGranted = decision.kind === 'same-origin';
		confirmationsRequired = confirmationsRequiredFor(decision);

		// Split into what this host decides itself and what the human must be asked. Allowlisted
		// pairs are granted here with a real deadline, because they are the ones minted with nobody
		// in the loop; prompted ones get their deadline at the moment of granting.
		//
		// The lookup depends on HOW access was decided: same-origin uses that origin's own table, a
		// named cross-origin request needs the pair listed by both origins, and anything reached
		// without somebody vouching for the requester auto-signs nothing at all.
		const {settled, pending: toAsk} = resolvePermissions(approval.permissions, {
			isAllowlisted: autoSignLookup({
				windowOrigin: approval.windowOrigin,
				signingOrigin: approval.signingOrigin,
				access: decision,
				allowlistFor,
			}),
			deadline: autoSignedDeadline(),
		});
		outcomes = settled;
		pending = toAsk;
	}

	function answer(request: PermissionRequest, outcome: PermissionOutcome) {
		outcomes = [...outcomes, outcome];

		// Remove the entry that was just answered. The fallback drops the head, which is the one the
		// UI asks about, and exists so that this ALWAYS makes progress: an entry that failed to match
		// and so was never removed would be re-asked forever, which is a prompt loop the user cannot
		// escape and cannot sign in past.
		const index = pending.indexOf(request);
		pending = index === -1 ? pending.slice(1) : [...pending.slice(0, index), ...pending.slice(index + 1)];

		deliverIfApproved();
	}

	function grantPermission(request: PermissionRequest) {
		// No expiry on a prompted credential, for now: refreshing one costs a popup and re-consent
		// in the middle of someone's game, and unlike the auto-signed case there was a human here.
		answer(request, {request, granted: true, deadline: PROMPTED_DEADLINE});
	}

	function denyPermission(request: PermissionRequest) {
		answer(request, {request, granted: false, reason: 'denied'});
	}

	function grantAccess() {
		if (!access) {
			return;
		}
		// The gate itself lives in @etherplay/connect-core, under test. What is left here is storing
		// its answer: whether a blocked decision can be confirmed, and how many confirmations a
		// wildcard needs, are not properties of this component.
		const next = confirmAccess(access, confirmationsGiven);
		confirmationsGiven = next.confirmationsGiven;
		if (!next.accessGranted) {
			return;
		}
		accessGranted = true;
		deliverIfApproved();
	}

	// A required entry that was refused. Sign-in cannot complete, and the app has to be TOLD so,
	// rather than being handed an account with a hole in it.
	const blocking = $derived(deniedRequiredPermissions(outcomes));
	const approvalComplete = $derived(accessGranted && pending.length === 0 && blocking.length === 0);

	const approvalUI: ApprovalUI = $derived({
		request: $authProvider.step === 'SignedIn' ? $authProvider.requireOriginApproval : false,
		access,
		accessGranted,
		confirmationsRequired,
		confirmationsGiven,
		pending,
		outcomes,
		blocking,
		complete: approvalComplete,
		grantAccess,
		grant: grantPermission,
		deny: denyPermission,
	});

	// Same-Origin Callback Bridge: encrypt the result and redirect to the bridge
	// page on the parent's own origin (ECDH P-256 + AES-GCM, native Web Crypto).
	async function encryptAndRedirect(payload: any, parentPubB64: string, parentOrigin: string, requestId: string) {
		const parentPub = await importPublicKeyB64(parentPubB64);
		const ephemeral = await generateEcdhKeyPair();
		const aesKey = await deriveAesKey(ephemeral.privateKey, parentPub, ['encrypt']);

		const iv = window.crypto.getRandomValues(new Uint8Array(12));
		const ct = await window.crypto.subtle.encrypt(
			{name: 'AES-GCM', iv},
			aesKey,
			new TextEncoder().encode(JSON.stringify(payload)),
		);

		const dataB64 = bufToB64(ct);
		const ivB64 = bufToB64(iv);
		const ephPubB64 = await exportPublicKeyB64(ephemeral.publicKey);

		// Forward debug/testing flags (if present on the popup URL) to the bridge
		// page as query params: `debug` keeps the bridge window open with a manual
		// close button; `forceBroadcastChannel` skips the opener delivery path.
		const popupParams = new URL(location.href).searchParams;
		const bridgeParams = new URLSearchParams();
		if (popupParams.has('debug')) {
			bridgeParams.set('debug', popupParams.get('debug') || '');
		}
		if (popupParams.has('forceBroadcastChannel')) {
			bridgeParams.set('forceBroadcastChannel', popupParams.get('forceBroadcastChannel') || '');
		}
		const query = bridgeParams.toString() ? `?${bridgeParams.toString()}` : '';

		window.location.href =
			`${parentOrigin}/_etherplay_accounts.html${query}` +
			`#data=${encodeURIComponent(dataB64)}` +
			`&iv=${encodeURIComponent(ivB64)}` +
			`&pubKey=${encodeURIComponent(ephPubB64)}` +
			`&id=${encodeURIComponent(requestId)}`;
	}

	let cancelOnCloseEnabled = false;
	function enableCancelOnClose() {
		if (!cancelOnCloseEnabled) {
			window.addEventListener('beforeunload', cancelOnClose);
			cancelOnCloseEnabled = true;
		}
	}
	function disableCancelOnClose() {
		if (cancelOnCloseEnabled) {
			window.removeEventListener('beforeunload', cancelOnClose);
			cancelOnCloseEnabled = false;
		}
	}

	function onMessage(event: MessageEvent) {
		try {
			console.log('ping?', event.origin, event.source, event.data);
		} catch (err) {
			console.log(`error getting event`);
		}

		if (!from.source && event.origin === from.windowOrigin) {
			from.source = event.source || undefined;
		}
	}

	// Deliver the result, if and only if everything that had to be settled has been.
	//
	// Called both when sign-in completes (nothing to ask) and after each approval (the last answer
	// unblocks it), so the two routes cannot drift: there is one condition, in one place.
	async function deliverIfApproved() {
		if ($authProvider.step !== 'SignedIn') {
			return;
		}

		if (blocking.length > 0) {
			// Refusing a required permission is a refusal to sign in, and the app is told which one
			// rather than being left to infer it from an account that never arrives.
			//
			// Reported HERE rather than when the user closes the window, so the app hears "you
			// declined this permission" rather than the "canceled" it would get from a closed popup,
			// which is the distinction the whole per-entry result exists to preserve.
			_cancel({
				message: 'a required permission was denied',
				type: 'permission-denied',
				permissions: $state.snapshot(outcomes),
			});
			return;
		}

		if (!approvalComplete) {
			return;
		}

		// Delivery is opportunistic: try the direct opener first; only if the opener was severed AND
		// a domain-redirect-public-key is present do we fall back to the encrypted same-origin
		// bridge.
		// Gate on `from.source` only: that is the exact reference `postResultIfNotAlreadyPosted`
		// posts through (it throws without it), so "I think I can deliver" matches "I actually can
		// deliver".
		const openerAlive = !!(from.source && !(from.source as Window).closed);

		if (openerAlive) {
			// Happy path: link survived. Use the existing postMessage delivery.
			postResultIfNotAlreadyPosted(from.canCloseAutomatically);
		} else if (from.domainRedirectPublicKey) {
			// Opener severed: fall back to the encrypted same-origin bridge.
			const result = await buildResult($authProvider.account);
			await encryptAndRedirect(result, from.domainRedirectPublicKey, from.windowOrigin, from.requestID);
		} else {
			// No opener and no bridge configured: keep existing behavior
			// (will surface the closed-popup UX on the parent side).
			postResultIfNotAlreadyPosted(from.canCloseAutomatically);
		}
	}

	// The account as the app receives it: the origin signer, plus a credential for each granted
	// pair and an answer for every entry that was asked about.
	//
	// The credentials are minted HERE, from the outcomes, which is what makes withholding real: a
	// denied entry does not produce a signature that is then filtered out, it never produces one.
	async function buildResult(account: Parameters<typeof deriveOriginAccount>[1]) {
		const asked = $authProvider.step === 'SignedIn' && $authProvider.requireOriginApproval;
		return deriveOriginAccount(from.signingOrigin, account, accountGenerator, {
			delegations: delegationsToSign(outcomes),
			permissions: asked ? $state.snapshot(outcomes) : undefined,
		});
	}

	onMount(() => {
		enableCancelOnClose();
		const unsubscribeFromAuthProvider = authProvider.subscribe(async (v) => {
			if (v?.step == 'WaitingForOAuthResponse') {
				disableCancelOnClose();
			} else if (v?.step === 'SignedIn') {
				// Awaited, not fired off: the access decision is asynchronous, and delivering before it
				// has landed would hand over the result while `accessGranted` still holds its initial
				// value, which is the one case this gate exists to prevent.
				await initialiseApproval(v.requireOriginApproval);
				await deliverIfApproved();
			}
		});

		let closed = false;
		window.addEventListener('message', onMessage);
		const sourceTimeoutId = setTimeout(() => {
			if (!from.source) {
				//TODO
				// authProvider.setError({message: 'timeout waiting for source'});
				// TODO allow to cancel flow
			}
			if (!closed) {
				window.removeEventListener('message', onMessage);
			}
		}, 10000);

		return () => {
			clearTimeout(sourceTimeoutId);
			closed = true;
			window.removeEventListener('message', onMessage);
			disableCancelOnClose();
			unsubscribeFromAuthProvider();
		};
	});

	function acknowledgeError() {
		// TODO
		// alchemy.acknowledgeError();
	}

	async function continueAfterLogin() {
		if ($authProvider.step !== 'SignedIn') {
			throw new Error(`not signed in`);
		}

		// The same condition the automatic path uses, asserted again at the manual one: a Continue
		// button that could post an unapproved result would be a way around the whole mechanism.
		if (!approvalComplete) {
			throw new Error(`not approved`);
		}
		await postResultIfNotAlreadyPosted();
		if (debug) {
			console.log('please close manually, in debug mode, we keep it open.');
		} else {
			window.close();
		}

		// setTimeout(() => window.close(), 300);
	}

	// Whatever this popup told the opener, it says it ONCE. Without this, closing the window after a
	// delivered result posts a `canceled` error on `beforeunload`, and a denied required permission
	// posts its reason and then a `canceled` on top of it: in both cases the last thing the app
	// hears contradicts the true one.
	let resultPosted = false;
	let outcomeDelivered = false;
	async function postResultIfNotAlreadyPosted(closeWindow = false) {
		if (!from.source) {
			throw new Error(`no source`);
		}

		// TODO option ?
		// again should not be handled in openfort specific provider
		// saveEtherplayAccount(etherplayAccount);

		if (!approvalComplete) {
			throw new Error(`not approved`);
		}

		if (!resultPosted) {
			try {
				if ($authProvider.step === 'SignedIn') {
					const result = await buildResult($authProvider.account);
					if (debug) {
						console.log('postMessage', {result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					}
					from.source.postMessage({result, id: from.requestID}, {targetOrigin: from.windowOrigin});
					resultPosted = true;
					outcomeDelivered = true;
				} else {
					throw new Error(`invalid step: ${$authProvider.step}`);
				}
			} catch (e) {
				// TODO
				console.error(e);
			}
		}
		if (closeWindow) {
			window.close();
		}
	}

	function _cancel(error?: any) {
		if (outcomeDelivered) {
			return;
		}
		if (!from.source) {
			window.close();
			return;
		}
		outcomeDelivered = true;
		const toReport = error || refusal || {message: 'canceled', type: 'cancelation'};
		if (debug) {
			console.log('postMessage', {error: toReport, id: from.requestID}, from.windowOrigin);
		}
		from.source.postMessage({error: toReport, id: from.requestID}, {targetOrigin: from.windowOrigin});
	}
	async function cancel(error: any) {
		_cancel(error);
		window.close();
	}
</script>

<div class="root">
	<!-- TODO -->
	<!-- {#if $authProvider?.error && !$authProvider.error.delay} -->
	{#if $authProvider.error}
		<div class="banner">
			<p>{$authProvider.error.message}</p>
			<!-- {#if !$authProvider.error.timeout}
				<button onclick={() => acknowledgeError()} id="error-acknowledge">ok</button>
			{/if} -->
		</div>
	{/if}
	{#if $authProvider.step === 'Initialised' || $authProvider.step === 'Initialising' || $authProvider.step === 'Idle'}
		<Loading />
	{:else if $authProvider.step === 'MechanismToChoose'}
		<!-- TODO? -->
		<main>
			<p>Not Supported</p>
		</main>
	{:else if $authProvider.mechanism.type == 'email'}
		<Email
			{authProvider}
			approval={approvalUI}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $authProvider.mechanism.type == 'oauth'}
		<OAuth
			{authProvider}
			approval={approvalUI}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else if $authProvider.mechanism.type == 'mnemonic'}
		<Mnemonic
			{authProvider}
			approval={approvalUI}
			goingToRedirect={!!from.domainRedirectPublicKey}
			continueAfterLogin={from.source ? continueAfterLogin : undefined}
			{cancel}
		/>
	{:else}
		<main>
			<p>{$authProvider.step}</p>
		</main>
	{/if}
</div>

<style>
	main {
		padding: 16px;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		min-height: 100vh;
		max-width: 510px;
	}

	p {
		color: #222222;
		font-size: 1.5rem;
		margin-block: 1rem;
		font-weight: 400;
	}

	.root {
		width: 100%;
		height: 100%;
		line-height: 1.5;
		font-family: system-ui, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, Helvetica, Arial, 'Helvetica Neue',
			sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
		display: flex;
		justify-content: center;
	}

	.banner {
		padding: 1rem;
		position: absolute;
		width: 100%;
		opacity: 0.9;
		display: flex;
		justify-content: space-between;

		background-color: #d93526;
		> p {
			color: white;
			font-size: 1rem;
		}
	}
</style>
