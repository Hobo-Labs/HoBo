import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createIssueTrackerAdapter,
  createKnowledgeAdapter,
  createOperatorIntegrationRuntime,
  createOperatorPortRegistry,
} from "../src/operator-integration-ports.js";

const SRE_PRINCIPAL = Object.freeze({
  name: "SRE",
  svid: "spiffe://yard/acme/agent/sre",
});

const INCIDENT = Object.freeze({
  id: "incident-api-503",
  title: "API 503s in prod",
  severity: "sev2",
  service: "api",
});

describe("operator integration ports", () => {
  it("syncs an Incident to a linked ticket through the configured issue-tracker port", async () => {
    const issueTracker = createIssueTrackerAdapter({
      id: "linear",
      provider: "linear",
      ticketPrefix: "LIN",
    });
    const registry = createOperatorPortRegistry().registerIssueTracker(issueTracker);
    const runtime = createOperatorIntegrationRuntime(registry, {
      issueTracker: "linear",
    });

    const result = await runtime.syncIncidentToTicket({
      incident: INCIDENT,
      policyDecision: policyDecision({ id: "policy-ticket-1", effect: "allow" }),
      action: action({
        id: "action-ticket-1",
        kind: "issue-tracker.sync-incident",
        target: INCIDENT.id,
      }),
    });

    assert.equal(result.link.incidentId, INCIDENT.id);
    assert.equal(result.link.status, "linked");
    assert.match(result.link.ticket.url, /^https:\/\/linear\.example\/LIN-/);
    assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "crew.ActionApplied"]);
    assert.equal(result.events[1].data.port, "issue-tracker");
    assert.equal(result.events[1].data.result.ticketUrl, result.link.ticket.url);
    assert.equal(issueTracker.writes.length, 1);
    assert.equal(issueTracker.writes[0].idempotencyKey, `${INCIDENT.id}:action-ticket-1`);
  });

  it("publishes a postmortem through the knowledge port using policy.Decided and crew.ActionApplied", async () => {
    const knowledge = createKnowledgeAdapter({
      id: "confluence",
      provider: "confluence",
      baseUrl: "https://confluence.example",
    });
    const registry = createOperatorPortRegistry().registerKnowledge(knowledge);
    const runtime = createOperatorIntegrationRuntime(registry, {
      knowledge: "confluence",
    });

    const result = await runtime.publishKnowledge({
      document: postmortem({ id: "pm-api-503", classification: "internal" }),
      target: { space: "sre", visibility: "internal" },
      policyDecision: policyDecision({ id: "policy-knowledge-1", effect: "allow" }),
      action: action({
        id: "action-knowledge-1",
        kind: "knowledge.publish-postmortem",
        target: "sre/pm-api-503",
      }),
    });

    assert.match(result.publication.url, /^https:\/\/confluence\.example\/sre\//);
    assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "crew.ActionApplied"]);
    assert.equal(result.events[1].data.port, "knowledge");
    assert.equal(result.events[1].data.result.publicationUrl, result.publication.url);
    assert.equal(knowledge.publishes.length, 1);
  });

  it("swaps issue-tracker and knowledge adapters by config only", async () => {
    const linear = createIssueTrackerAdapter({ id: "linear", provider: "linear", ticketPrefix: "LIN" });
    const github = createIssueTrackerAdapter({ id: "github", provider: "github", ticketPrefix: "GHI" });
    const confluence = createKnowledgeAdapter({
      id: "confluence",
      provider: "confluence",
      baseUrl: "https://confluence.example",
    });
    const obsidian = createKnowledgeAdapter({
      id: "obsidian",
      provider: "obsidian",
      baseUrl: "obsidian://vault",
    });
    const registry = createOperatorPortRegistry()
      .registerIssueTracker(linear)
      .registerIssueTracker(github)
      .registerKnowledge(confluence)
      .registerKnowledge(obsidian);

    const linearConfluence = createOperatorIntegrationRuntime(registry, {
      issueTracker: "linear",
      knowledge: "confluence",
    });
    const githubObsidian = createOperatorIntegrationRuntime(registry, {
      issueTracker: "github",
      knowledge: "obsidian",
    });

    const first = await linearConfluence.syncIncidentToTicket({
      incident: INCIDENT,
      policyDecision: policyDecision({ id: "policy-linear", effect: "allow" }),
      action: action({ id: "action-linear", kind: "issue-tracker.sync-incident", target: INCIDENT.id }),
    });
    const second = await githubObsidian.syncIncidentToTicket({
      incident: { ...INCIDENT, id: "incident-db-timeout" },
      policyDecision: policyDecision({ id: "policy-github", effect: "allow" }),
      action: action({ id: "action-github", kind: "issue-tracker.sync-incident", target: "incident-db-timeout" }),
    });
    const publication = await githubObsidian.publishKnowledge({
      document: postmortem({ id: "pm-db-timeout", incidentId: "incident-db-timeout", classification: "internal" }),
      target: { space: "sre", visibility: "internal" },
      policyDecision: policyDecision({ id: "policy-obsidian", effect: "allow" }),
      action: action({ id: "action-obsidian", kind: "knowledge.publish-postmortem", target: "sre/pm-db-timeout" }),
    });

    assert.equal(first.link.ticket.provider, "linear");
    assert.equal(second.link.ticket.provider, "github");
    assert.equal(publication.publication.provider, "obsidian");
    assert.equal(linear.writes.length, 1);
    assert.equal(github.writes.length, 1);
    assert.equal(confluence.publishes.length, 0);
    assert.equal(obsidian.publishes.length, 1);
  });

  it("keeps a pending Incident link and retries failed issue-tracker writes with the same idempotency key", async () => {
    const issueTracker = createIssueTrackerAdapter({
      id: "linear",
      provider: "linear",
      ticketPrefix: "LIN",
      failFirstFor: [`${INCIDENT.id}:action-retry-1`],
    });
    const registry = createOperatorPortRegistry().registerIssueTracker(issueTracker);
    const runtime = createOperatorIntegrationRuntime(registry, {
      issueTracker: "linear",
    });
    const operation = {
      incident: INCIDENT,
      policyDecision: policyDecision({ id: "policy-retry-1", effect: "allow" }),
      action: action({ id: "action-retry-1", kind: "issue-tracker.sync-incident", target: INCIDENT.id }),
    };

    await assert.rejects(() => runtime.syncIncidentToTicket(operation), /external issue-tracker write failed/);

    const pending = runtime.getIncidentLink(INCIDENT.id);
    assert.equal(pending.status, "pending");
    assert.equal(pending.idempotencyKey, `${INCIDENT.id}:action-retry-1`);

    const retry = await runtime.retryPendingIssueWrite(pending.idempotencyKey);

    assert.equal(retry.link.status, "linked");
    assert.equal(retry.link.incidentId, INCIDENT.id);
    assert.equal(issueTracker.writes.length, 2);
    assert.deepEqual(new Set(issueTracker.writes.map((write) => write.idempotencyKey)).size, 1);
  });

  it("does not leave a retryable Incident link when policy denies issue-tracker sync", async () => {
    const issueTracker = createIssueTrackerAdapter({
      id: "linear",
      provider: "linear",
      ticketPrefix: "LIN",
    });
    const registry = createOperatorPortRegistry().registerIssueTracker(issueTracker);
    const runtime = createOperatorIntegrationRuntime(registry, {
      issueTracker: "linear",
    });

    await assert.rejects(
      () =>
        runtime.syncIncidentToTicket({
          incident: INCIDENT,
          policyDecision: policyDecision({
            id: "policy-ticket-deny",
            effect: "deny",
            reason: "external ticket write requires approval",
          }),
          action: action({ id: "action-ticket-deny", kind: "issue-tracker.sync-incident", target: INCIDENT.id }),
        }),
      /policy denied issue-tracker write/,
    );

    assert.equal(issueTracker.writes.length, 0);
    assert.equal(runtime.getIncidentLink(INCIDENT.id), null);
    assert.deepEqual(runtime.getEventLog().map((event) => event.type), ["policy.Decided", "crew.ActionDenied"]);
  });

  it("does not leak internal-only knowledge to a public space when policy denies the publish", async () => {
    const knowledge = createKnowledgeAdapter({
      id: "wiki",
      provider: "wiki",
      baseUrl: "https://wiki.example",
    });
    const registry = createOperatorPortRegistry().registerKnowledge(knowledge);
    const runtime = createOperatorIntegrationRuntime(registry, {
      knowledge: "wiki",
    });

    await assert.rejects(
      () =>
        runtime.publishKnowledge({
          document: postmortem({ id: "pm-sensitive", classification: "internal-only" }),
          target: { space: "public", visibility: "public" },
          policyDecision: policyDecision({
            id: "policy-public-deny",
            effect: "deny",
            reason: "internal-only content cannot publish to public spaces",
          }),
          action: action({ id: "action-public-deny", kind: "knowledge.publish-postmortem", target: "public/pm" }),
        }),
      /policy denied knowledge publish/,
    );

    assert.equal(knowledge.publishes.length, 0);
    assert.deepEqual(runtime.getEventLog().map((event) => event.type), ["policy.Decided", "crew.ActionDenied"]);
    assert.equal(runtime.getEventLog()[1].data.port, "knowledge");
  });
});

function policyDecision({ id, effect, reason }) {
  return Object.freeze({
    id,
    type: "policy.Decided",
    v: 1,
    streamId: `policy:${id}`,
    seq: 1,
    ts: "2026-06-27T21:05:00.000Z",
    data: {
      effect,
      ...(reason ? { reason } : undefined),
    },
  });
}

function action({ id, kind, target }) {
  return Object.freeze({
    id,
    streamId: "crew:sre",
    seq: 2,
    ts: "2026-06-27T21:06:00.000Z",
    principal: SRE_PRINCIPAL,
    kind,
    target,
  });
}

function postmortem({ id, incidentId = INCIDENT.id, classification }) {
  return Object.freeze({
    id,
    type: "postmortem",
    incidentId,
    title: `Postmortem for ${incidentId}`,
    body: "Root cause and corrective action summary.",
    classification,
  });
}
