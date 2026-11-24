---
'@etherplay/delegation': minor
---

`resignDelegate(owner, payee)`: the delegate's side of withdrawal. Sent by the delegate key itself, it ends that key's authorisation for `owner` (the same withdrawn state as `revokeDelegate`, so only an owner transaction can bring it back) and forwards the attached value to `payee`. An app holding a funded key for its user can now withdraw it and return its funds in one transaction, with no wallet prompt and nothing needed from the account. Only a currently allowed delegate may resign. Also `Delegation.resign` in the library, `IDelegation` and `DELEGATION_ABI`. Adopters of `UsingDelegation` gain the function on their next compile.
