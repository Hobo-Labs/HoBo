# HOBO-174 Fly Provider Proof

This proof backs [PLAN-04](../../control-plane.md#plan-04),
[PLAN-25](../../platform-engineering.md#plan-25), and
[ADR-0024](../../adr/07-portability-extensibility.md#adr-0024).

Executable artifact:

- [`src/draft/technical-proofs/provider-fly-contract`](../../../../src/draft/technical-proofs/provider-fly-contract)

Acceptance evidence:

- `provider-fly` passes shared provider conformance for `compute`, `database`,
  `objectStore`, `queue`, and `cache`, plus a package-local Fly volume
  conformance check.
- Its capability manifest claims Fly volume support alongside the shared seed
  ports, so registry consumers see the implemented volume default definition.
- A fixture realizes a Fly Machine, regional Fly Volume, and Fly Postgres into a
  declarative IaC program without backend execution.
- A supporting-services fixture realizes Tigris, NATS, and Upstash defaults.
- The same Bindle fixture deploys to Fly and preserves the Bindle digest in the
  planned realization.
- Fly-only `.with` options are surfaced as `provider-option` entries in the
  PortabilityReport.

Adversarial evidence:

- Machine cold-start and region-placement facts are explicit in the planned
  Machine node and portability report.
- Fly Postgres refuses to silently satisfy a managed Postgres HA requirement.
- Non-Postgres database engines and non-container compute runtimes fail closed
  instead of being overclaimed as Fly-compatible.
- Tigris S3 compatibility divergences fail closed for strict S3 features.
- A regional volume cannot be planned for a Machine in an unreachable region.

Scope boundary:

- No other provider packages.
- No IaC apply/backend execution.
- No global anycast routing or multi-region failover.
- No Fly surface beyond Machines, volumes, Fly Postgres, Tigris, NATS, and
  Upstash seed mappings.
