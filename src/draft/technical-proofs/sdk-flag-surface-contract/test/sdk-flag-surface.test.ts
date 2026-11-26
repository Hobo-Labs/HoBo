import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { createFlagArchived, createFlagChanged } from "../../flag-event-contract/src/flag-event-contract.js";

import {
  createFlagSurfaceEventLog,
  createSdkFlagContract,
  createSdkFlagSurface,
} from "../src/sdk-flag-surface.js";

const actor = Object.freeze({
  kind: "user",
  id: "operator_1",
  tenant: "tenant_a",
});

const betaRequest = Object.freeze({
  user: {
    kind: "user",
    id: "user_123",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "beta" }],
  },
  identity: {
    kind: "service",
    id: "spiffe://tenant-a/camp/prod/bindle/checkout",
    tenant: "tenant_a",
    claims: [],
  },
  attributes: [],
});

const controlClient = Object.freeze({
  user: {
    kind: "user",
    id: "user_456",
    tenant: "tenant_a",
    claims: [{ key: "segment", value: "control" }],
  },
  attributes: [],
});

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

test("server ctx.flags.eval uses request context and returns declaration-typed values", async () => {
  const contract = createSdkFlagContract({ knownTargetingAttributes: ["user.segment"] });
  const newCheckout = contract.flag.boolean("new-checkout", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }],
  });
  const eventLog = createFlagSurfaceEventLog([
    { seq: 1, event: newCheckout.event },
    {
      seq: 2,
      event: createFlagChanged(newCheckout.ref, {
        from: false,
        to: true,
        actor,
      }),
    },
  ]);
  const surface = createSdkFlagSurface({
    eventLog,
    requestContext: () => betaRequest,
  });

  assert.equal(await surface.ctx.flags.eval(newCheckout), true);
  assert.equal(await surface.ctx.flags.eval(newCheckout, controlClient), false);
  assert.deepEqual(await surface.ctx.flags.details(newCheckout), {
    flagKey: "new-checkout",
    value: true,
    reason: "targeting-match",
    variant: "on",
    bucket: await surface.ctx.flags.bucket(newCheckout),
    rulesetSeq: 2,
  });
});

test("useFlag reads static client context and rerenders on flag.Changed pushes", () => {
  const contract = createSdkFlagContract({ knownTargetingAttributes: ["user.segment"] });
  const newCheckout = contract.flag.boolean("new-checkout", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }],
  });
  const eventLog = createFlagSurfaceEventLog([{ seq: 1, event: newCheckout.event }]);
  const surface = createSdkFlagSurface({
    eventLog,
    clientContext: controlClient,
  });
  const hook = surface.useFlag(newCheckout);

  assert.equal(hook.value(), false);
  assert.equal(hook.renderCount(), 1);

  eventLog.append({
    seq: 2,
    event: createFlagChanged(newCheckout.ref, {
      from: false,
      to: true,
      targeting: {
        from: [{ attribute: "user.segment", op: "equals", value: "beta" }],
        to: [{ attribute: "user.segment", op: "equals", value: "control" }],
      },
      actor,
    }),
  });

  assert.equal(hook.value(), true);
  assert.equal(hook.renderCount(), 2);
  assert.equal(hook.details().rulesetSeq, 2);
  hook.unsubscribe();
});

test("useFlag returns archived flags to defaults with deprecation evidence", () => {
  const contract = createSdkFlagContract();
  const archivedFlag = contract.flag.boolean("old-checkout", { default: false });
  const eventLog = createFlagSurfaceEventLog([
    { seq: 1, event: archivedFlag.event },
    { seq: 2, event: createFlagChanged(archivedFlag.ref, { from: false, to: true, actor }) },
    { seq: 3, event: createFlagArchived(archivedFlag.ref, { actor, reason: "cleanup" }) },
  ]);
  const hook = createSdkFlagSurface({ eventLog }).useFlag(archivedFlag);

  assert.equal(hook.value(), false);
  assert.deepEqual(hook.details().deprecation, {
    code: "flag-archived",
    message: "flag old-checkout is archived; default returned",
  });
  hook.unsubscribe();
});

test("rapid successive flips coalesce to the latest value", () => {
  const contract = createSdkFlagContract();
  const killSwitch = contract.flag.boolean("kill-switch", { default: false });
  const eventLog = createFlagSurfaceEventLog([{ seq: 1, event: killSwitch.event }]);
  const hook = createSdkFlagSurface({ eventLog }).useFlag(killSwitch);

  eventLog.appendBatch([
    { seq: 2, event: createFlagChanged(killSwitch.ref, { from: false, to: true, actor }) },
    { seq: 3, event: createFlagChanged(killSwitch.ref, { from: true, to: false, actor }) },
    { seq: 4, event: createFlagChanged(killSwitch.ref, { from: false, to: true, actor }) },
  ]);

  assert.equal(hook.value(), true);
  assert.equal(hook.renderCount(), 2);
  assert.equal(hook.details().rulesetSeq, 4);
  hook.unsubscribe();
});

test("server eval outside a user request falls back to global/default context", async () => {
  const contract = createSdkFlagContract({ knownTargetingAttributes: ["user.segment"] });
  const requiresUser = contract.flag.boolean("requires-user", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }],
  });
  const eventLog = createFlagSurfaceEventLog([
    { seq: 1, event: requiresUser.event },
    { seq: 2, event: createFlagChanged(requiresUser.ref, { from: false, to: true, actor }) },
  ]);

  assert.equal(await createSdkFlagSurface({ eventLog }).ctx.flags.eval(requiresUser), false);
});

test("type declarations carry flag declaration value types to call sites", () => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
