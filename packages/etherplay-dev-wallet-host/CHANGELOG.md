# @etherplay/dev-wallet-host

## 0.1.1

### Patch Changes

- e1fade9: Say what the configuration document actually did, and stop a missing one looking like an error.

  `/config.json` is optional and the host asks for it on every popup, so an absent one put a 404 in
  the console of a correctly configured host: a red line meaning nothing is wrong, which is how real
  errors come to be ignored. The bundled server now answers an empty document for that one path when
  there is no file and no `--config`, and only for that path: anything else missing is still a 404,
  and a `config.json` in the served directory or behind `--config` still wins.

  That distinction has to exist on the other side too, or it would just move the confusion. The
  startup line now separates three states rather than two: no document, a document that is present
  and changes nothing, and a document that changed something, in which case it NAMES the fields it
  changed. Announcing an empty document as "configured by config.json" would have been read as
  confirmation by the one person who most needs to hear otherwise: the developer whose settings are
  being ignored because of a typo'd field name.

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
