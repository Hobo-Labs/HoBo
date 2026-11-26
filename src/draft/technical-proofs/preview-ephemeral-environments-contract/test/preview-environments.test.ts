import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertPreviewStreamIsolation,
  clonePreviewEnvironment,
  openPullRequestPreview,
  reapExpiredPreview,
  rebuildBaselineProjection,
  reopenPullRequestPreview,
} from "../src/preview-environments.js";

describe("preview ephemeral environment contract", () => {
  it("opens a per-PR ephemeral Camp with its own stream, live URL, and envType bindings", () => {
    const preview = openPullRequestPreview({
      tenant: "acme",
      project: "checkout",
      repository: "acme/checkout",
      pullRequest: { number: 42, headSha: "abc123" },
      baselineCampId: "camp-prod",
      baselineSetId: "set-prod-2026-06-25",
      resourceRequests: [
        {
          name: "postgres",
          capability: "sql.database",
          variants: [
            { id: "postgres-prod", envType: "production", size: "standard" },
            { id: "postgres-lite", envType: "ephemeral", size: "micro" },
          ],
        },
      ],
    }, {
      now: "2026-06-25T10:00:00.000Z",
      urlBase: "https://preview.hobo.dev",
    });

    assert.equal(preview.camp.id, "camp:acme:checkout:pr-42");
    assert.equal(preview.camp.envType, "ephemeral");
    assert.equal(preview.camp.state, "active");
    assert.equal(preview.stream.id, "stream:camp:acme:checkout:pr-42");
    assert.equal(preview.stream.baselineStreamId, "stream:camp-prod");
    assert.equal(preview.previewUrl, "https://pr-42-checkout-acme.preview.hobo.dev");
    assert.equal(preview.ttl.expiresAt, "2026-06-28T10:00:00.000Z");
    assert.equal(preview.resources[0].selectedVariant.id, "postgres-lite");
    assert.equal(preview.resources[0].selectedVariant.envType, "ephemeral");
    assert.deepEqual(
      preview.events.map((event) => event.type),
      [
        "env.PreviewCloneRequested",
        "env.PreviewCampCreated",
        "deploy.PreviewUrlAssigned",
      ],
    );
    assertPreviewStreamIsolation(preview, preview.events);
  });

  it("clones a baseline Set into a preview Camp without mutating the baseline projection", () => {
    const baseline = {
      campId: "camp-prod",
      setId: "set-prod-2026-06-25",
      streamId: "stream:camp-prod",
      resources: [
        { name: "api", digest: "sha256:api" },
        { name: "worker", digest: "sha256:worker" },
      ],
      projection: {
        campId: "camp-prod",
        resources: ["api", "worker"],
      },
    };

    const preview = clonePreviewEnvironment({
      tenant: "acme",
      project: "checkout",
      repository: "acme/checkout",
      pullRequest: { number: 42, headSha: "abc123" },
      baseline,
      resourceRequests: [
        {
          name: "queue",
          capability: "events.queue",
          variants: [
            { id: "queue-memory", envType: "ephemeral", durability: "in-memory" },
          ],
        },
      ],
    }, {
      now: "2026-06-25T11:00:00.000Z",
      urlBase: "https://preview.hobo.dev",
    });

    assert.equal(preview.clone.sourceSetId, baseline.setId);
    assert.deepEqual(preview.clone.resources, baseline.resources);
    assert.notEqual(preview.clone.resources, baseline.resources);
    assert.equal(preview.camp.baselineCampId, baseline.campId);
    assert.equal(preview.stream.baselineStreamId, baseline.streamId);

    const rebuilt = rebuildBaselineProjection([...preview.events], baseline.streamId);
    assert.deepEqual(rebuilt, { streamId: baseline.streamId, appliedEventIds: [] });
  });

  it("reaps expired previews, escalates missed hard ceilings, and keeps teardown events in the preview stream", () => {
    const preview = openPullRequestPreview(baseRequest(), {
      now: "2026-06-25T10:00:00.000Z",
      ttlHours: 1,
      hardCeilingHours: 2,
      urlBase: "https://preview.hobo.dev",
    });

    const beforeTtl = reapExpiredPreview(preview, {
      now: "2026-06-25T10:30:00.000Z",
    });
    assert.equal(beforeTtl.action, "none");
    assert.equal(beforeTtl.camp.state, "active");

    const expired = reapExpiredPreview(preview, {
      now: "2026-06-25T11:00:01.000Z",
    });
    assert.equal(expired.action, "deprovision");
    assert.equal(expired.camp.state, "reaped");
    assert.deepEqual(
      expired.events.map((event) => event.type),
      ["env.PreviewTtlExpired", "deploy.PreviewTeardownRequested"],
    );
    assertPreviewStreamIsolation(expired, expired.events);

    const missed = reapExpiredPreview(preview, {
      now: "2026-06-25T12:00:01.000Z",
    });
    assert.equal(missed.action, "escalate");
    assert.equal(missed.camp.state, "escalated");
    assert.equal(missed.escalation.severity, "page");
    assert.match(missed.escalation.reason, /hard ceiling/);
    assert.equal(missed.events.at(-1).type, "env.PreviewHardCeilingEscalated");
  });

  it("rejects preview events that would bleed into the baseline stream", () => {
    const preview = openPullRequestPreview(baseRequest(), {
      now: "2026-06-25T10:00:00.000Z",
      urlBase: "https://preview.hobo.dev",
    });
    const contaminated = {
      ...preview.events[0],
      id: "event-contaminated",
      streamId: preview.stream.baselineStreamId,
    };

    assert.throws(
      () => assertPreviewStreamIsolation(preview, [contaminated]),
      /preview event event-contaminated targeted baseline stream stream:camp-prod/,
    );
  });

  it("reopens a PR deterministically without orphaning an earlier preview Camp", () => {
    const first = openPullRequestPreview(baseRequest(), {
      now: "2026-06-25T10:00:00.000Z",
      urlBase: "https://preview.hobo.dev",
    });
    const reaped = reapExpiredPreview(first, {
      now: "2026-06-28T10:00:01.000Z",
    });

    const reopened = reopenPullRequestPreview(reaped, baseRequest({
      pullRequest: { number: 42, headSha: "def456" },
    }), {
      now: "2026-06-29T10:00:00.000Z",
      urlBase: "https://preview.hobo.dev",
    });

    assert.equal(reopened.camp.id, first.camp.id);
    assert.equal(reopened.camp.generation, 2);
    assert.equal(reopened.replacesCampId, first.camp.id);
    assert.equal(reopened.events[0].type, "env.PreviewReopened");
    assert.equal(reopened.events[0].data.previousGeneration, 1);
    assert.equal(reopened.events[0].data.nextGeneration, 2);
    assertPreviewStreamIsolation(reopened, reopened.events);
  });
});

function baseRequest(overrides = {}) {
  return {
    tenant: "acme",
    project: "checkout",
    repository: "acme/checkout",
    pullRequest: { number: 42, headSha: "abc123" },
    baselineCampId: "camp-prod",
    baselineSetId: "set-prod-2026-06-25",
    resourceRequests: [
      {
        name: "postgres",
        capability: "sql.database",
        variants: [
          { id: "postgres-lite", envType: "ephemeral", size: "micro" },
        ],
      },
    ],
    ...overrides,
  };
}
