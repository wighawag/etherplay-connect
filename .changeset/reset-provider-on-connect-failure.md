---
'@etherplay/connect': patch
---
Reset the always-on provider wrapper when a connection attempt fails, so read-only RPC calls (eth_call, eth_blockNumber, etc.) fall back to the JSON-RPC endpoint instead of being routed through the failed wallet provider.