# @etherplay/dev-wallet-host

## 0.1.0

### Minor Changes

- 83b841a: New package: the sign-in host, prebuilt, for development and e2e.

  An adopter adds a dependency, gets a version pinned in their lockfile, and serves a directory. No
  build step, no publishable key, no sibling checkout, and no assumption that the etherplay-connect
  repo is present on the machine. `dev-wallet-host --port 50000` puts it on a port, and
  `--config ./wallet-host.config.json` hands it a runtime configuration document from the adopter's
  own project rather than from inside `node_modules`.

  It is the DEVELOPMENT build of `web/`, which is what makes every value in it injectable: it holds
  nothing worth protecting, and it is named so that nobody deploys it by accident. The host that
  holds real accounts is the other build of the same source, with its configuration baked in and no
  runtime document honoured.

  Signing in by mnemonic against it needs no key, no account and no network.
