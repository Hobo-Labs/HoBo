import assert from "node:assert/strict";
import { test } from "vitest";

import {
  adoptPreviewBumpAsNewBindleVersion,
  planPinnedRedeploy,
} from "../src/version-pinning-drift-guard.js";

const OLD_WEBSOCKET_PIN = Object.freeze({
  name: "wasi.websocket",
  version: "0.2.0",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
});

const NEW_WEBSOCKET_PREVIEW = Object.freeze({
  name: "wasi.websocket",
  version: "0.2.1",
  tier: "preview",
  digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
});

test("ordinary redeploy preserves a deployed preview pin despite a higher preview release", () => {
  const decision = planPinnedRedeploy({
    bindleVersion: "shop@1.0.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    now: "2026-06-28T00:00:00Z",
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.runningPins, [OLD_WEBSOCKET_PIN]);
  assert.deepEqual(decision.redeployPins, [OLD_WEBSOCKET_PIN]);
  assert.equal(decision.driftPrevented, true);
  assert.match(decision.reason, /immutable Bindle pin preserved/i);
});

test("floating ranges cannot drift a pinned consumer across a breaking preview boundary", () => {
  const decision = planPinnedRedeploy({
    bindleVersion: "shop@1.0.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    lockPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    now: "2026-06-28T00:00:00Z",
  });

  assert.equal(decision.ok, true);
  assert.deepEqual(decision.redeployPins, [OLD_WEBSOCKET_PIN]);
  assert.equal(decision.remediation.kind, "explicit-upgrade-required");
  assert.equal(decision.remediation.targetVersion, "0.2.1");
});

test("expired deprecation window blocks redeploy without force-rewriting the running pin", () => {
  const decision = planPinnedRedeploy({
    bindleVersion: "shop@1.0.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      {
        ...OLD_WEBSOCKET_PIN,
        tier: "deprecated",
        deprecationExpiresAt: "2026-06-01T00:00:00Z",
      },
      NEW_WEBSOCKET_PREVIEW,
    ],
    now: "2026-06-28T00:00:00Z",
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.error.code, "redeploy-blocked-unservable-pin");
  assert.deepEqual(decision.runningPins, [OLD_WEBSOCKET_PIN]);
  assert.equal(decision.forcedRewrite, false);
  assert.match(decision.error.remediation, /publish a new Bindle version/i);
});

test("adopting the preview bump requires an upcaster and publishes a new Bindle version", () => {
  const blocked = adoptPreviewBumpAsNewBindleVersion({
    currentBindleVersion: "shop@1.0.0",
    nextBindleVersion: "shop@1.0.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    upcasters: [],
  });

  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "new-bindle-version-required");

  const missingUpcaster = adoptPreviewBumpAsNewBindleVersion({
    currentBindleVersion: "shop@1.0.0",
    nextBindleVersion: "shop@1.1.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    upcasters: [],
  });

  assert.equal(missingUpcaster.ok, false);
  assert.equal(missingUpcaster.error.code, "upcaster-required");

  const missingConformance = adoptPreviewBumpAsNewBindleVersion({
    currentBindleVersion: "shop@1.0.0",
    nextBindleVersion: "shop@1.1.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    upcasters: [
      {
        name: "wasi.websocket",
        from: "0.2.0",
        to: "0.2.1",
      },
    ],
  });

  assert.equal(missingConformance.ok, false);
  assert.equal(missingConformance.error.code, "reconformance-required");

  const adopted = adoptPreviewBumpAsNewBindleVersion({
    currentBindleVersion: "shop@1.0.0",
    nextBindleVersion: "shop@1.1.0",
    requests: [{ name: "wasi.websocket", range: "^0.2.0" }],
    currentPins: [OLD_WEBSOCKET_PIN],
    catalog: [
      { ...OLD_WEBSOCKET_PIN, tier: "preview" },
      NEW_WEBSOCKET_PREVIEW,
    ],
    upcasters: [
      {
        name: "wasi.websocket",
        from: "0.2.0",
        to: "0.2.1",
      },
    ],
    conformanceReport: {
      status: "passed",
      suite: "@hobo/conformance/wasi-websocket",
    },
  });

  assert.equal(adopted.ok, true);
  assert.deepEqual(adopted.newPins, [
    {
      name: "wasi.websocket",
      version: "0.2.1",
      digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  ]);
  assert.equal(adopted.replanRequired, true);
  assert.equal(adopted.reconformanceRequired, true);
  assert.equal(adopted.previousBindleVersion, "shop@1.0.0");
  assert.equal(adopted.nextBindleVersion, "shop@1.1.0");
});
