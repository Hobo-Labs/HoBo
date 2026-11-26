import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { renderDashboardHtml } from "../src/dashboard-html-renderer.ts";
import {
  REQUIRED_DASHBOARD_VIEWS,
  REQUIRED_INTERACTIONS,
  classifyDashboardRequest,
  parseDashboardRenderResult,
  renderDashboardFromProjections,
} from "../src/full-dashboard-projection-views.ts";
import { createMultiCloudShopProjectionEvents } from "../src/multi-cloud-shop-projection-fixture.ts";
import {
  auditPseudoLocalization,
  pseudoLocalizeString,
  pseudoLocalizeStrings,
  renderPseudoLocalizedDashboard,
} from "../src/pseudo-localization.ts";
import { auditWcag21Aa } from "../src/wcag-audit.ts";
import { isJsonObject } from "../src/json.js";


const BASE_STRINGS = {
  "HoBo developer dashboard": "HoBo developer dashboard",
  Fixture: "Fixture",
  "Dashboard views": "Dashboard views",
  "Skip to dashboard content": "Skip to dashboard content",
  "Projection source": "Projection source",
  "Time travel scrubber": "Time travel scrubber",
  "Replay diff": "Replay diff",
  "Projection payload": "Projection payload",
  "Deployments timeline": "Deployments timeline",
  "Topology graph": "Topology graph",
  "Run inspector": "Run inspector",
  "Registry browser": "Registry browser",
  "Agent activity and credential audit": "Agent activity and credential audit",
  "Cost and FinOps": "Cost and FinOps",
  Drift: "Drift",
  "Plan preview": "Plan preview",
  "Policy gate approvals": "Policy gate approvals",
  "Promote and rollback": "Promote and rollback",
  "Live tail": "Live tail",
};

describe("HOBO-662 full dashboard projection views", () => {
  const events = createMultiCloudShopProjectionEvents();

  it("Given multi-cloud-shop projection events When dashboard renders Then every Plan 07 view is projection-only", () => {
    const dashboard = parseDashboardRenderResult(renderDashboardFromProjections(events));

    assert.equal(dashboard.issue, "HOBO-662");
    assert.equal(dashboard.fixture, "examples/multi-cloud-shop");
    assert.equal(dashboard.projectionOnly, true);
    assert.deepEqual(
      dashboard.views.map((view) => view.id),
      REQUIRED_DASHBOARD_VIEWS,
    );
    assert.deepEqual(dashboard.interactions, REQUIRED_INTERACTIONS);
    assert.ok(dashboard.views.every((view) => view.projectionOnly));
  });

  it("Given deployment and topology projections When timeline and graph render Then scrubber and bind-edge cost tiers are present", () => {
    const dashboard = renderDashboardFromProjections(events, { scrubberAtSeq: 12 });
    const timeline = dashboard.views.find((view) => view.id === "deployments-timeline");
    const topology = dashboard.views.find((view) => view.id === "topology-graph");

    assert.ok(timeline);
    assert.ok(topology);
    assert.equal(timeline.scrubberAtSeq, 12);
    assert.equal(timeline.projectionSource, "DeploymentView");
    assert.ok(Array.isArray(timeline.payload.timeline));
    assert.equal(topology.projectionSource, "TopologyView");
    const edges = Array.isArray(topology.payload.edges)
      ? topology.payload.edges.filter(isJsonObject)
      : [];
    assert.ok(edges.every((edge) => edge.connectivityTier && edge.estimatedCostUsd !== undefined));
  });

  it("Given run projection events When run inspector renders Then replay-diff status is exposed", () => {
    const dashboard = renderDashboardFromProjections(events);
    const runInspector = dashboard.views.find((view) => view.id === "run-inspector");

    assert.equal(runInspector?.projectionSource, "RunView");
    assert.equal(runInspector?.replayDiffStatus, "unchanged");
    assert.deepEqual(runInspector?.payload.replayDiff, {
      status: "unchanged",
      comparedAtSeq: events.at(-1)?.seq,
    });
  });

  it("Given registry, credential, cost, and drift projections When auxiliary views render Then forge provenance and FinOps showback are visible", () => {
    const dashboard = renderDashboardFromProjections(events);
    const registry = dashboard.views.find((view) => view.id === "registry-browser");
    const credential = dashboard.views.find((view) => view.id === "agent-activity-credential-audit");
    const cost = dashboard.views.find((view) => view.id === "cost-finops");
    const drift = dashboard.views.find((view) => view.id === "drift");

    assert.ok(registry);
    assert.ok(credential);
    assert.ok(drift);
    const providers = Array.isArray(registry.payload.providers) ? registry.payload.providers : [];
    assert.ok(isJsonObject(providers[0]));
    assert.equal(providers[0].forgeCertification, "certified");
    assert.ok(Array.isArray(credential.payload.grants) && credential.payload.grants.length > 0);
    assert.equal(cost?.payload.showbackLabel, "tenant-acme/multi-cloud-shop/prod");
    const driftItems = Array.isArray(drift.payload.items) ? drift.payload.items : [];
    assert.ok(isJsonObject(driftItems[0]));
    assert.equal(driftItems[0].healAction, "propose-scale-down");
  });

  it("Given plan, policy, promote, and stream projections When interaction views render Then inline approvals and live tail are fixture-backed", () => {
    const dashboard = renderDashboardFromProjections(events);
    const planPreview = dashboard.views.find((view) => view.id === "plan-preview");
    const policy = dashboard.views.find((view) => view.id === "policy-gate-approvals");
    const promote = dashboard.views.find((view) => view.id === "promote-rollback");
    const liveTail = dashboard.views.find((view) => view.id === "live-tail");

    assert.ok(policy);
    assert.ok(liveTail);
    assert.equal(planPreview?.payload.approvable, true);
    const gates = Array.isArray(policy.payload.gates) ? policy.payload.gates : [];
    assert.ok(isJsonObject(gates[0]));
    assert.equal(gates[0].status, "approved");
    assert.equal(promote?.payload.rollbackEnabled, true);
    assert.ok(Array.isArray(liveTail.payload.logLines) && liveTail.payload.logLines.length > 0);
  });

  it("When dashboard HTML is rendered Then automated WCAG 2.1 AA audit passes", () => {
    const dashboard = renderDashboardFromProjections(events);
    const document = renderDashboardHtml(dashboard, { strings: BASE_STRINGS });
    const audit = auditWcag21Aa(document);

    assert.equal(audit.target, "WCAG-2.1-AA");
    assert.equal(audit.passed, true, audit.violations.map((v) => v.message).join("; "));
    assert.deepEqual(audit.violations, []);
  });

  it("When dashboard strings are pseudo-localized Then 200 percent expansion and RTL layout audit passes", () => {
    const dashboard = renderDashboardFromProjections(events);
    const base = renderDashboardHtml(dashboard, { strings: BASE_STRINGS });
    const localized = renderPseudoLocalizedDashboard(base, BASE_STRINGS);
    const audit = auditPseudoLocalization(localized);

    assert.equal(localized.dir, "rtl");
    assert.equal(pseudoLocalizeString("Cost").length, "Cost".length * 2 + 2);
    assert.equal(audit.expansionFactor, 2);
    assert.equal(audit.passed, true, audit.overflowViolations.join("; "));
    assert.ok(
      Object.values(pseudoLocalizeStrings({ label: "Deploy" })).every(
        (value) => value.startsWith("\u00AB") && value.endsWith("\u00BB"),
      ),
    );
  });

  it("Adversarial: production dashboard runtime requests are classified out of scope", () => {
    assert.deepEqual(classifyDashboardRequest("build the Next.js production app with live gateway websocket"), {
      owner: "Production apps/dashboard",
      inScope: false,
    });
    assert.deepEqual(classifyDashboardRequest("render projection dashboard view for multi-cloud-shop"), {
      owner: "Full Dashboard",
      inScope: true,
    });
  });
});
