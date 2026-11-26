# Networking Reference Architecture

## Overview

The epic architecture is a policy-first networking plane. Authoring and planning produce a connectivity intent; the reference implementation folds Yard topology, selects the lowest legal tier, enforces data-path policy, and drives DNS, gateway, Relay, and tenant ingress through mocked service boundaries.

## Vertical Slice Map

| Slice | Persona | Inputs | Boundary decisions | Observable proof |
|---|---|---|---|---|
| Secure cross-cloud connectivity fabric | Platform engineer | Bind edge, Yard manifests, mTLS fixture, policy decision | Tier 3 private interconnect, policy ceiling, mTLS, internal service discovery, Junction mirrored halves | `crossCloudBind.outcome = deployable` |
| Safe custom-domain and gateway promotion | Domain operator | Domain record, DNS evidence, ACME challenge, gateway route, cost inputs | Shadow DNS only, four validation checks, ACME and private ACME, weighted routing, cost routing single-writer refusal | `domainPromotion.validation.status = validated` and `liveZoneWrites = 0` |
| Outbound-only Relay execution | SecOps engineer | Relay spec, policy decisions, private work request | Outbound TCP 443 attach, SVID mTLS, target-id routing, no forward proxy, no credential egress | `relay.status = attached` and denial taxonomy |
| Tenant-aware ingress | Application operator | Tenant routing table, request host/path/JWT | Tenant claims before handler, placement selection, mismatch denial | `tenantIngress.resolved.ctx.tenant = tenant-alpha` |

## Service Boundaries

| Boundary | Consumer | Provider role | Mock strategy |
|---|---|---|---|
| ConnectivityTierSelector | Reference service | Selects connectivity tier from bind edge | Existing `connectivity-tier-ir-contract` module |
| ConnectivityPolicyGate | Reference service | Enforces tier ceilings, residency, and override rules | Existing `connectivity-policy-enforcement-contract` module |
| IdentityMtlsDataPath | Reference service | Validates SVID keyed transport | Existing `mtls-data-path-contract` module |
| YardTopologyManifest | Reference service | Projects Yard topology and content hash | Existing `yard-topology-manifest-contract` module |
| JunctionConnectivityPlanner | Reference service | Folds manifests into per-Yard halves | Existing `junction-connectivity-plan-contract` module |
| DnsShadowPort | Domain orchestrator | Stages DNS before live mutation | In-memory adapter from `hobo-dns-port-contract` |
| DomainValidationGate | Domain orchestrator | Runs multi-vantage, TTL, ACME, health checks | Existing validation gate module |
| CertificateAuthority | Domain orchestrator | Issues public and private DNS-01 certificates | Fixture identity CA and private ACME endpoint |
| GatewayTrafficRouter | Domain orchestrator and tenant ingress | Terminates TLS and routes traffic | Existing gateway realization module |
| CostRoutingLedger | Routing planner | Checks single-writer cost-routing eligibility | Existing cost-routing eligibility module |
| HoBoRelayPrivateExecutor | Relay controller | Executes private scoped work | Existing Relay contract module |
| TenantRoutingClaims | Gateway ingress | Resolves tenant context before handler | Existing tenant routing module |

## Contract Strategy

Pact files under `contracts/pacts/` are consumer-driven boundary fixtures. They intentionally verify request/response or message compatibility only. Business logic remains in focused POC modules and the reference tests.

Provider verification is marked `mocked_provider_unavailable` because the selected epic still lives in reference architecture space. This is not a missing boundary: every service boundary has a contract fixture and a simulation assertion.

## Scope Control

The implementation does not create production networking providers, live DNS changes, live ACME orders, real Relay sockets, tenant databases, or cross-epic Identity/Policy features. Identity, policy, reliability, and control-plane POCs are consumed only as mocked boundaries where the Networking epic crosses them.
## Guardrail evidence

Parse, don't validate: incoming command payloads, Pact fixtures, and protobuf/CUE-backed scenario records cross a parser boundary before the epic simulation uses them. The parsed domain types are the scenario commands, boundary fixtures, and role-flow records described above; mocked providers receive only those derived domain types, not raw DTOs.

Event architecture: command handlers in the epic actors emit events into an in-memory event-store. Materialized views and projections are rebuilt from that event stream, snapshots represent the current read model, and historical snapshots are retained in a read store so CLI, MCP, operator, and simulation reads never infer state from mutable provider internals.
