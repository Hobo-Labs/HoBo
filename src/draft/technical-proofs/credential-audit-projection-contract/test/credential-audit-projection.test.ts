import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  createIdentityEvent,
  foldCredentialAudit,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  AUDIT_RETENTION_FLOOR_MS,
  CREDENTIAL_AUDIT_VIEW,
  NEVER_COMPACT_AUDIT_STREAM_PREFIXES,
  applyCredentialAuditEvent,
  assertAuditStreamsNeverCompacted,
  assertRetentionFloorPreservesAuditEvents,
  brokeredDeployCredentialTrail,
  queryCredentialAuditByPrincipal,
  queryCredentialAuditViaGateway,
  queryCredentialAuditViaMcp,
  snapshotCredentialAuditView,
} from "../src/credential-audit-projection.js";

describe("CredentialAudit projection + NFR-018 retention (HOBO-635)", () => {
  it("rebuilds grant/use/revoke timeline per principal with deterministic digest", () => {
    const { events } = brokeredDeployCredentialTrail();
    const replayed = snapshotCredentialAuditView(events, { seq: 4 });
    const replayedAgain = snapshotCredentialAuditView([...events].reverse(), { seq: 4 });
    const incremental = events.reduce(
      (view, event) => applyCredentialAuditEvent(view, event),
      snapshotCredentialAuditView([], { seq: 0 }),
    );

    assert.equal(replayed.view, CREDENTIAL_AUDIT_VIEW);
    assert.equal(replayed.digest, replayedAgain.digest);
    assert.equal(replayed.digest, incremental.digest);
    assert.equal(replayed.chains.length, 1);
    assert.equal(replayed.chains[0].revoked, true);
    assert.deepEqual(replayed.revokedGrantIds, ["grant-cf-deploy"]);

    const userTimeline = queryCredentialAuditByPrincipal(replayed, "user:priya");
    const agentTimeline = queryCredentialAuditByPrincipal(replayed, "agent:deploy");
    assert.equal(userTimeline.entries.length, 2);
    assert.equal(agentTimeline.entries.length, 4);
    assert.deepEqual(
      agentTimeline.entries.map((entry) => entry.type),
      ["identity.Issued", "token.Granted", "token.Used", "token.Revoked"],
    );
  });

  it("reconstructs a full brokered-deploy credential trail for a run", () => {
    const { runId, events } = brokeredDeployCredentialTrail({ runId: "run-hello-bindle" });
    const view = snapshotCredentialAuditView(events, { seq: 4 });
    const mcp = queryCredentialAuditViaMcp(view, "inspect_credential_audit", { runId });
    const gateway = queryCredentialAuditViaGateway(view, { grantId: "grant-cf-deploy" });

    assert.equal(mcp.ok, true);
    assert.equal(mcp.chains.length, 1);
    assert.equal(mcp.chains[0].target, "provider:cloudflare");
    assert.deepEqual(mcp.chains[0].uses, ["use-cf-deploy"]);
    assert.equal(gateway.ok, true);
    assert.equal(gateway.grant.revoked, true);
    assert.deepEqual(foldCredentialAudit(events).chains, mcp.chains);
  });

  it("exposes Gateway and MCP query surfaces for security review", () => {
    const { events } = brokeredDeployCredentialTrail();
    const view = snapshotCredentialAuditView(events, { seq: 4 });

    const gatewaySummary = queryCredentialAuditViaGateway(view, {});
    const gatewayPrincipal = queryCredentialAuditViaGateway(view, { principalId: "agent:deploy" });
    const mcpTrails = queryCredentialAuditViaMcp(view, "list_credential_trails");
    const mcpPrincipal = queryCredentialAuditViaMcp(view, "inspect_credential_audit", {
      principalId: "agent:deploy",
    });

    assert.equal(gatewaySummary.ok, true);
    assert.equal(gatewaySummary.chainCount, 1);
    assert.equal(gatewayPrincipal.ok, true);
    assert.equal(gatewayPrincipal.audit.chains[0].agent, "agent:deploy");
    assert.equal(mcpTrails.ok, true);
    assert.equal(mcpTrails.trails[0].grantId, "grant-cf-deploy");
    assert.equal(mcpPrincipal.ok, true);
    assert.equal(mcpPrincipal.audit.principalId, "agent:deploy");
  });

  it("keeps compliance audit streams older than the retention floor and never compacts them", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    const oldTimestamp = now - AUDIT_RETENTION_FLOOR_MS - 86_400_000;

    const retention = assertRetentionFloorPreservesAuditEvents(
      "token.grants/agent-deploy",
      [
        { type: "token.Granted", seq: 1, timestamp: oldTimestamp },
        { type: "token.Used", seq: 2, timestamp: now - 60_000 },
        { type: "token.Revoked", seq: 3, timestamp: now - 30_000 },
      ],
      { now, floorMs: AUDIT_RETENTION_FLOOR_MS },
    );

    assert.equal(retention.ok, true);
    assert.equal(retention.compactionRejected, true);
    assert.equal(retention.olderThanFloorCount, 1);
    assert.equal(retention.retainedCount, 3);

    const neverCompact = assertAuditStreamsNeverCompacted([
      "token.session/user-1",
      "resource.vm/vm-1",
      "policy.rules/org-1",
    ]);
    assert.equal(neverCompact.ok, true);
    assert.deepEqual(NEVER_COMPACT_AUDIT_STREAM_PREFIXES, ["token.", "resource.", "policy."]);
  });

  it("flags token.Used without grant as anomaly instead of silently folding", () => {
    const actor = {
      kind: "agent",
      id: "agent:rogue",
      delegatedBy: { kind: "user", id: "user:priya" },
    };
    const view = snapshotCredentialAuditView(
      [
        createIdentityEvent(
          "token.Used",
          {
            grantId: "missing-grant",
            usageId: "use-rogue",
            operation: "objectStore.write",
            resource: "bucket/photos",
          },
          { id: "evt-rogue-use", actor, seq: 1 },
        ),
      ],
      { seq: 1 },
    );

    assert.deepEqual(view.anomalies, [
      {
        type: "token.Used",
        id: "evt-rogue-use",
        code: "missing-token-grant",
        grantId: "missing-grant",
      },
    ]);
    assert.deepEqual(view.chains, []);
  });

  it("rejects compaction attempts on token audit streams (adversarial)", () => {
    const compaction = assertAuditStreamsNeverCompacted(["token.audit/grant-cf-deploy"]);
    assert.equal(compaction.ok, true);
    assert.deepEqual(compaction.failures, []);
  });

  it("pins architecture artifacts and satisfies PACT boundary interactions", () => {
    const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
    const proto = readFileSync(
      new URL("../architecture/credential_audit_projection_contract.proto", import.meta.url),
      "utf8",
    );
    const cue = readFileSync(
      new URL("../architecture/credential_audit_projection_contract.cue", import.meta.url),
      "utf8",
    );
    const pact = JSON.parse(
      readFileSync(
        new URL("../architecture/pacts/credential_audit_projection_contract.pact.json", import.meta.url),
        "utf8",
      ),
    );

    for (const typeName of [
      "CredentialAuditProjectionContractRecord",
      "CredentialAuditTimelineEntry",
      "CredentialAuditViewSnapshot",
    ]) {
      assert.match(proto, new RegExp(`message ${typeName}`));
      assert.match(cue, new RegExp(`#${typeName}:`));
    }

    assert.equal(pact.consumer.name, "CredentialAuditProjectionContractConsumer");
    assert.equal(pact.provider.name, "CredentialAuditProjectionContractBoundary");
    assert.ok(pact.interactions.length >= 3);
    assert.match(adr, /parse, don't validate/i);
    assert.match(adr, /Event store/i);
    assert.match(adr, /projection/i);

    const { runId, events } = brokeredDeployCredentialTrail({ runId: "run-hello-bindle" });
    const view = snapshotCredentialAuditView(events, { seq: 4 });
    const gatewayGrant = queryCredentialAuditViaGateway(view, { grantId: "grant-cf-deploy" });
    const mcpInspect = queryCredentialAuditViaMcp(view, "inspect_credential_audit", { runId });

    assert.equal(gatewayGrant.ok, true);
    assert.equal(gatewayGrant.surface, "gateway");
    assert.equal(gatewayGrant.grant.grantId, "grant-cf-deploy");
    assert.equal(gatewayGrant.grant.revoked, true);
    assert.equal(mcpInspect.ok, true);
    assert.equal(mcpInspect.surface, "mcp");
    assert.equal(mcpInspect.tool, "inspect_credential_audit");
    assert.equal(mcpInspect.chains.length, 1);
  });
});
