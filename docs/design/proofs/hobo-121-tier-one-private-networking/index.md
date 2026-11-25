# HOBO-121 Tier-One Private Networking Proof

Executable proof for the M1 same-provider same-region connectivity slice.

It lives in [`src/draft/technical-proofs/tier-one-private-network-contract`](../../../../src/draft/technical-proofs/tier-one-private-network-contract) and proves:

- A tier-one `ConnectivityPlan` realizes a native private link for one provider and region.
- Generated egress/ingress rules authorize only the bound source resource to reach the dependency.
- The target logical endpoint is injected from provider outputs and can change without application edits.
- A same-VPC but unbound peer is denied.
- The mTLS data-path contract accepts only the bound SVID peer.
- Cross-region/non-tier-one plans fail closed, leaving tiers 2-5 out of scope.

Run:

```powershell
npm.cmd --prefix src\draft\technical-proofs\tier-one-private-network-contract test
```

Scope out remains intact: no cloud provider APIs, no cross-region or cross-provider tier realization, no Junction inference, no Planner objective changes, and no provider IaC internals beyond the tier-one contract model.
