# Adapters

Adapters are mocked boundary descriptions for the Control Plane reference implementation. They are not provider implementations.

| Adapter | Status | Notes |
|---|---|---|
| Manifest collector | mocked | Represents SDK/IfC manifest IR handoff. |
| Resource Definition catalog | mocked | Stable catalog snapshot with hash. |
| Capability registry | mocked | Provider support matrix and remediation hints. |
| Objective ledger | mocked | Pinned CreditLedgerView and objective inputs. |
| Gatekeeper | mocked | Contract/policy/eval decision surface. |
| EventStore/ActorHost | mocked | Replayable actor state and correlation graph. |
| Executor sandbox | mocked | Firecracker-shaped run descriptor, no ambient credentials. |
| Driver adapter | mocked | Terraform/template/echo/container/custom-webhook response shape. |
| Drift refresh | mocked | Drift and orphan evidence. |
| Identity broker | mocked | Redacted short-lived token descriptor. |
| Bootstrap handover | mocked | Seed-to-real Identity transition transcript. |
| DeploymentView projection | mocked | Saga graph reconstruction output. |
