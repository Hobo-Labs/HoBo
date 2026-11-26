import assert from "node:assert/strict";
import { test } from "vitest";

import {
  analyzeAuthorTimeCapabilityFeedback,
  renderHoboPlanFeedback
} from "../src/author-time-capability-feedback.js";

const baseResource = Object.freeze({
  id: "api",
  type: "service",
  selectedProviderId: "local"
});

test("required unsupported capability emits hobo plan finding with named remediation provider", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:catalog-a",
    resource: baseResource,
    requests: [
      { port: "compute", feature: "containers", strictness: "require" }
    ],
    providers: [
      provider("local", [{ port: "compute", feature: "functions", stability: "stable" }]),
      provider("aws", [{ port: "compute", feature: "containers", stability: "stable" }])
    ]
  });
  const text = renderHoboPlanFeedback(report);

  assert.equal(report.ok, false);
  assert.equal(report.schema, "hobo.author-time-capability-feedback/v1");
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "capability.require.unsatisfied"
  ]);
  assert.deepEqual(report.findings[0].remediation.providerIds, ["aws"]);
  assert.match(text, /local does not support compute\.containers/);
  assert.match(text, /host on registered provider aws/);
});

test("preview and experimental capabilities surface stability warnings before deploy", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:catalog-preview",
    resource: { ...baseResource, selectedProviderId: "edge" },
    requests: [
      { port: "websocket", feature: "fanout", strictness: "require" },
      { port: "ai", feature: "batch-generation", strictness: "require" }
    ],
    providers: [
      provider("edge", [
        { port: "websocket", feature: "fanout", stability: "preview" },
        { port: "ai", feature: "batch-generation", stability: "experimental" }
      ])
    ]
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((finding) => finding.code), [
    "capability.stability.preview",
    "capability.stability.experimental"
  ]);
  assert.equal(report.findings.every((finding) => finding.severity === "warning"), true);
  assert.match(renderHoboPlanFeedback(report), /pinned, may change/);
});

test("fully supported stable config produces no author-time findings", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:catalog-clean",
    resource: { ...baseResource, selectedProviderId: "aws" },
    requests: [
      { port: "database", feature: "managed", strictness: "require" },
      { port: "database", feature: "ha", strictness: "require" }
    ],
    providers: [
      provider("aws", [
        { port: "database", feature: "managed", stability: "stable" },
        { port: "database", feature: "ha", stability: "stable" }
      ])
    ]
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.findings, []);
  assert.equal(renderHoboPlanFeedback(report), "");
});

test("findings are deterministic and machine consumable for codegen and doctor", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:catalog-many",
    resource: baseResource,
    requests: [
      { port: "database", feature: "ha", strictness: "require" }
    ],
    providers: [
      provider("local", [{ port: "database", feature: "managed", stability: "stable" }]),
      provider("gcp", [{ port: "database", feature: "ha", stability: "stable" }]),
      provider("aws", [{ port: "database", feature: "ha", stability: "stable" }])
    ]
  });

  assert.deepEqual(report.findings[0], {
    code: "capability.require.unsatisfied",
    severity: "error",
    resourceId: "api",
    providerId: "local",
    port: "database",
    feature: "ha",
    strictness: "require",
    message: "local does not support database.ha required by api.",
    remediation: {
      kind: "provider-candidates",
      message: "Host on registered provider aws.",
      providerIds: ["aws", "gcp"]
    }
  });
  assert.deepEqual(report.surfaces.codegenDiagnostics, report.findings);
  assert.deepEqual(report.surfaces.doctor.findings, report.findings);
});

test("no provider support and prefer misses warn without blocking deploy authoring", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:catalog-none",
    resource: baseResource,
    requests: [
      { port: "database", feature: "read-replica", strictness: "prefer" },
      { port: "search", feature: "vector", strictness: "require" }
    ],
    providers: [
      provider("local", [{ port: "database", feature: "managed", stability: "stable" }])
    ]
  });

  assert.equal(report.ok, false);
  assert.equal(report.findings[0].code, "capability.prefer.degraded");
  assert.equal(report.findings[0].severity, "warning");
  assert.equal(report.findings[1].code, "capability.require.unsatisfied");
  assert.equal(report.findings[1].severity, "error");
  assert.deepEqual(report.findings[1].remediation, {
    kind: "register-provider",
    message: "No registered provider supports search.vector; register a provider that does.",
    providerIds: []
  });
});

test("stale author catalog snapshot is advisory and preserves deploy-time gate requirement", () => {
  const report = analyzeAuthorTimeCapabilityFeedback({
    catalogContentHash: "sha256:author-old",
    deployCatalogContentHash: "sha256:deploy-new",
    resource: { ...baseResource, selectedProviderId: "aws" },
    requests: [
      { port: "database", feature: "managed", strictness: "require" }
    ],
    providers: [
      provider("aws", [{ port: "database", feature: "managed", stability: "stable" }])
    ]
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.findings.map((finding) => finding.code), ["catalog.snapshot.stale"]);
  assert.equal(report.deployGateRequired, true);
  assert.equal(report.findings[0].severity, "warning");
  assert.match(report.findings[0].message, /author catalog sha256:author-old differs/);
});

function provider(id, capabilities) {
  return {
    id,
    capabilities
  };
}
