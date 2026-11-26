# Promoted from the README's prose gherkin blocks; every step drives
# services/data-plane-reference-architecture.ts (the epic's real simulation).
Feature: Data plane event sourcing, CQRS, and reactivity
  Snapshop orders write through an event-sourced CQRS pipeline, project into
  portable sinks with explicit escape hatches, and fail closed on stale,
  poisoned, or erased data without ever rewriting the event log.

  Scenario: Place an order and read it through a reactive projection
    Given a typed order domain event, a CQRS aggregate, and a tenant-scoped materialization
    When the Snapshop app places an order through the data plane
    Then the order event appends once, replay and live projections agree, and the Reactor pushes the updated view

  Scenario: Keep reads portable while exposing explicit escape hatches
    Given relational, document, full-text, and vector projection surfaces
    When the reference projection updates and portable search runs
    Then every sink boundary is consumer-tested and raw driver access stays read-only and portability-flagged

  Scenario: Handle stale, poisoned, and erased data without rewriting history
    Given projection lag, snapshot divergence, a poison event, and an erasure request
    When the data plane rebuilds from the event log
    Then stale reads are labeled, poison events quarantine, and erased fields tombstone without log rewrite
