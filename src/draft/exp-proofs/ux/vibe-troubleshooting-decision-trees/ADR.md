# ADR: Fixture-First Troubleshooting Decision Trees

## Status

Accepted for HOBO-553 draft proof.

## Context

Troubleshooting Guides must help app developers, coding agents, support
operators, platform engineers, and docs maintainers classify stuck states without
absorbing product UI, support tooling, live remediation, incident communication,
or docs portal implementation scope.

HOBO-577 is the accepted quickstart source for downstream docs, support, launch,
workspace, plan/diff, and dashboard consumers. HOBO-553 needs decision trees that
reuse those fixture ids and proof-mode labels while adding troubleshooting owner
routing, redaction, and customer-safe wording.

## Decision

Represent each troubleshooting guide entry as a parsed decision-tree record with
symptom, diagnostic evidence, owner, safe next action, customer-safe wording,
escalation route, proof mode, quickstart fixture references, accessibility notes,
and redaction evidence.

Parse, don't validate: this package parses untrusted fixture input once at the
boundary into the derived domain type
`ParsedVibeTroubleshootingDecisionTrees`. Rendering functions accept parsed
records, and tests assert Pact/CUE fixtures align with the parser instead of
rechecking raw DTOs.

The command family is `troubleshooting.classify`,
`troubleshooting.renderGuideEntry`, and `troubleshooting.prepareHandoff`. The
event family is `troubleshooting.CaseClassified`,
`troubleshooting.GuideEntryRendered`, and
`troubleshooting.SupportHandoffPrepared`.

`TroubleshootingGuideActor` owns those commands and appends the events to a
fixture event-store stream. `TroubleshootingGuideProjection` is the materialized
view / projection that folds the stream into read store snapshots for Docs
Portal, Support Workflow, launch support, and known-limitations consumers.

## Alternatives Considered

- Prose-only guide outline: rejected because owner routing, redaction, and proof
  modes would not be executable.
- Production docs or support ticket prototype: rejected as explicit scope-out.
- Live diagnostic automation: rejected because this slice is fixture-backed and
  cannot mutate live provider, control-plane, support, or customer state.

## Consequences

Downstream Docs Portal, Support Workflow, launch support, and known-limitations
work can consume stable fixture records. Any future guide implementation must
preserve redaction and proof-mode labels before publishing customer-facing
wording.
