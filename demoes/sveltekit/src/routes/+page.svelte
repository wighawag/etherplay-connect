<script lang="ts">
	import { PUBLIC_WALLET_HOST } from '$env/static/public';

	let walletHost: string;
	if (PUBLIC_WALLET_HOST.indexOf('{hostname}') === -1) {
		walletHost = PUBLIC_WALLET_HOST;
	} else if (typeof location === 'undefined') {
		walletHost = PUBLIC_WALLET_HOST.replace('{hostname}', 'localhost');
	} else {
		walletHost = PUBLIC_WALLET_HOST.replace('{hostname}', location.hostname);
	}
</script>

{walletHost}
