import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HoboUpError,
  createHoboUpConvergence,
  sampleSnapshopProject,
} from "../src/up-convergence.js";

function engine(options = {}) {
  let nextId = 1;
  return createHoboUpConvergence({
    now: () => "2026-06-26T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${nextId++}`,
    ...options,
  });
}

test("hobo up provisions and deploys a sample app to a local/dev Camp with JSON evidence", async () => {
  const streamed = [];
  const result = await engine().run({
    project: sampleSnapshopProject(),
    flags: { camp: "dev", json: true },
    streamEvent: (event) => streamed.push(event.type),
  });

  assert.equal(result.status, "deployed");
  assert.equal(result.campId, "dev");
  assert.equal(result.revision, "rev-working-tree");
  assert.equal(result.liveUrl, "http://localhost:4100/snapshop");
  assert.equal(result.json.liveUrl, result.liveUrl);
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "deployment.UpStarted",
      "deployment.RevisionSelected",
      "bindle.ManifestProduced",
      "deployment.Planned",
      "gate.DeployPassed",
      "resource.Provisioned",
      "resource.Provisioned",
      "resource.Provisioned",
      "deployment.SetApplied",
      "deployment.Deployed",
      "deployment.UpCompleted",
    ],
  );
  assert.deepEqual(streamed, result.events.map((event) => event.type));
});

test("second hobo up is an idempotent no-op and does not call apply or deploy again", async () => {
  const eventLog = [];
  const first = await engine().run({
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
  });
  assert.equal(first.status, "deployed");

  const second = await engine({
    applySet: () => {
      throw new Error("no-op must not apply");
    },
    deployRevision: () => {
      throw new Error("no-op must not deploy");
    },
  }).run({ eventLog });

  assert.equal(second.status, "noop");
  assert.equal(second.liveUrl, "http://localhost:4100/snapshop");
  assert.equal(second.applied, false);
  assert.equal(second.events.at(-1).type, "deployment.UpNoop");
  assert.equal(second.events.some((event) => event.type === "resource.Provisioned"), false);
});

test("hobo up --to re-realizes the named revision even after a newer completed target", async () => {
  const eventLog = [];
  const appendEvent = (event) => {
    eventLog.push(event);
    return { appended: true };
  };
  await engine().run({
    flags: { camp: "staging", to: "rev-older" },
    eventLog,
    appendEvent,
  });
  await engine().run({
    flags: { camp: "staging", to: "rev-newer" },
    eventLog,
    appendEvent,
  });

  let deployCalls = 0;
  const result = await engine({
    deployRevision: (set, { project, campId, revision }) => {
      deployCalls += 1;
      return {
        revision: revision.revision,
        liveUrl: `https://${project.name}.${campId}.hobo.example`,
      };
    },
  }).run({
    eventLog,
    flags: { camp: "staging", to: "rev-older", strategy: "canary" },
  });

  assert.equal(result.status, "deployed");
  assert.equal(result.revision, "rev-older");
  assert.equal(deployCalls, 1);
  assert.equal(result.liveUrl, "https://snapshop.staging.hobo.example");
  assert.deepEqual(result.events.find((event) => event.type === "deployment.RevisionSelected").data, {
    kind: "explicit",
    revision: "rev-older",
  });
  assert.equal(result.events.find((event) => event.type === "deployment.Planned").data.strategy, "canary");
});

test("hobo up --rollback selects the last-good revision from the event log", async () => {
  const eventLog = [];
  await engine().run({
    flags: { camp: "prod", to: "rev-good" },
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
  });

  const rollback = await engine().run({
    flags: { camp: "prod", rollback: true },
    eventLog,
  });

  assert.equal(rollback.status, "noop");
  assert.equal(rollback.revision, "rev-good");
  assert.equal(rollback.liveUrl, "https://snapshop.prod.hobo.example");
  assert.deepEqual(rollback.events.find((event) => event.type === "deployment.RevisionSelected").data, {
    kind: "rollback",
    revision: "rev-good",
  });
  assert.equal(rollback.events.at(-1).type, "deployment.UpNoop");
});

test("gate denial is a clean no-op with no provisioned resources", async () => {
  const result = await engine({
    evaluateGate: () => ({
      status: "failed",
      code: "policy.denied",
      reason: "prod requires approval",
      fix: "request a policy waiver or rerun against staging",
    }),
    applySet: () => {
      throw new Error("blocked gate must not apply");
    },
    deployRevision: () => {
      throw new Error("blocked gate must not deploy");
    },
  }).run({ flags: { camp: "prod" } });

  assert.equal(result.status, "blocked");
  assert.equal(result.applied, false);
  assert.match(result.reason, /requires approval/);
  assert.match(result.fix, /waiver|staging/);
  assert.equal(result.events.at(-1).type, "deployment.PlanRejected");
  assert.equal(result.events.some((event) => event.type === "resource.Provisioned"), false);
  assert.equal(result.events.at(-1).data.provisionedResourceIds.length, 0);
});

test("hobo up rejects --to and --rollback together before collection", async () => {
  await assert.rejects(
    () =>
      engine({
        collectResources: () => {
          throw new Error("conflict must fail before collect");
        },
      }).run({ flags: { to: "rev-1", rollback: true } }),
    (error) =>
      error instanceof HoboUpError
      && error.code === "conflicting-revision-selector"
      && /--to cannot be combined/.test(error.message),
  );
});

test("interrupted deploy resumes from the applied Set without provisioning again", async () => {
  const eventLog = [];
  let applyCalls = 0;
  const interrupted = await engine({
    applySet: (set) => {
      applyCalls += 1;
      return { resources: set.resources.map((resource) => ({ resourceId: resource.id })) };
    },
    deployRevision: () => {
      throw new Error("network dropped after apply");
    },
  }).run({
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
  });

  assert.equal(interrupted.status, "interrupted");
  assert.equal(applyCalls, 1);
  assert.equal(interrupted.events.at(-1).type, "deployment.UpInterrupted");
  assert.equal(interrupted.events.at(-1).data.stage, "deploy");

  const resumed = await engine({
    applySet: () => {
      throw new Error("resume must not apply the same Set twice");
    },
  }).run({ eventLog });

  assert.equal(resumed.status, "deployed");
  assert.equal(resumed.events.some((event) => event.type === "deployment.SetReused"), true);
  assert.equal(resumed.events.some((event) => event.type === "resource.Provisioned"), false);
});

test("prod event-shape incompatibility blocks with the dual-publish deploy-order fix", async () => {
  const result = await engine({
    evaluateGate: ({ campId }) => {
      assert.equal(campId, "prod");
      return {
        status: "failed",
        code: "compat.GateFailed",
        reason: "api publishes order.created v3 but worker still consumes tenantId",
        fix: "dual-publish tenantId for one migration window, or deploy worker first",
      };
    },
    applySet: () => {
      throw new Error("compat failure must not apply");
    },
  }).run({ flags: { camp: "prod", to: "rev-breaking-event" } });

  assert.equal(result.status, "blocked");
  assert.equal(result.json.reason, "api publishes order.created v3 but worker still consumes tenantId");
  assert.equal(result.json.fix, "dual-publish tenantId for one migration window, or deploy worker first");
  assert.equal(result.events.at(-1).data.code, "compat.GateFailed");
  assert.equal(result.events.some((event) => event.type === "deployment.SetApplied"), false);
});
