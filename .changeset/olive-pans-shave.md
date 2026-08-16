---
'@etherplay/dev-wallet-host': patch
---

Say what the configuration document actually did, and stop a missing one looking like an error.

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
