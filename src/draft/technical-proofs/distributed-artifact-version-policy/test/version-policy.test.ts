import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  checkImmutablePinMutation,
  classifyTierAwareBump,
  evaluateDeprecationWindow,
  normalizeVersion,
  satisfies,
  validateAcceptedRange
} from "../src/version-policy.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("policy doc states immutable pins, tier-aware bumps, deprecation, and accepted ranges", async () => {
  const policy = await readFile(
    path.join(packageRoot, "policy", "distributed-artifact-version-policy.md"),
    "utf8"
  );

  assert.match(policy, /Immutable Bindle pins/);
  assert.match(policy, /Accepted range syntax/);
  assert.match(policy, /Tier-aware compatibility/);
  assert.match(policy, /Deprecation windows/);
});

test("fixture table pins accepted range syntax and tier-aware compatibility verdicts", () => {
  const cases = JSON.parse(
    readFileSync(path.join(packageRoot, "fixtures", "compatibility-cases.json"), "utf8")
  );

  for (const entry of cases) {
    const result = satisfies(entry);
    assert.equal(result.verdict, entry.verdict, entry.name);
  }
});

test("immutable Bindle pins reject in-place mutation", () => {
  assert.deepEqual(
    checkImmutablePinMutation({
      bindleVersion: "shop@1.4.0",
      before: {
        name: "@acme/database-provider",
        version: "1.2.0",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      },
      after: {
        name: "@acme/database-provider",
        version: "1.2.1",
        digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
      }
    }),
    {
      ok: false,
      reason: "shop@1.4.0 pins @acme/database-provider to 1.2.0@sha256:1111111111111111111111111111111111111111111111111111111111111111; publish a new Bindle version to adopt 1.2.1@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    }
  );
});

test("deprecation window expiry makes old pins unservable", () => {
  assert.equal(
    evaluateDeprecationWindow({
      status: "deprecated",
      expiresAt: "2026-06-30T00:00:00.000Z",
      checkedAt: "2026-06-29T23:59:59.000Z"
    }).state,
    "deprecated"
  );
  assert.equal(
    evaluateDeprecationWindow({
      status: "deprecated",
      expiresAt: "2026-06-30T00:00:00.000Z",
      checkedAt: "2026-06-30T00:00:00.000Z"
    }).state,
    "unservable"
  );
});

test("adversarial ranges and preview zero-series bumps fail closed", () => {
  assert.deepEqual(validateAcceptedRange(">=1.2.0 <3.0.0"), {
    ok: false,
    reason: "range crosses major boundary for a pinned consumer"
  });
  assert.deepEqual(validateAcceptedRange("^not-semver"), {
    ok: false,
    reason: "version must be semver: not-semver"
  });
  assert.equal(
    satisfies({
      installed: "1.2.3",
      requested: "~not-semver",
      tier: "stable"
    }).verdict,
    "invalid-range"
  );
  assert.deepEqual(validateAcceptedRange(">=2.0.0 <1.0.0"), {
    ok: false,
    reason: "range lower bound must be less than upper bound"
  });
  assert.deepEqual(
    classifyTierAwareBump({
      from: "0.2.3",
      to: "0.2.4",
      tier: "preview"
    }),
    {
      verdict: "upcaster-required",
      reason: "0.x preview interface bumps are potentially breaking"
    }
  );
});

test("immutable pin comparison preserves build metadata as part of the version tuple", () => {
  assert.deepEqual(
    checkImmutablePinMutation({
      bindleVersion: "shop@1.4.0",
      before: {
        name: "@acme/database-provider",
        version: "1.2.3+build.1",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      },
      after: {
        name: "@acme/database-provider",
        version: "1.2.3+build.2",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111"
      }
    }),
    {
      ok: false,
      reason: "shop@1.4.0 pins @acme/database-provider to 1.2.3+build.1@sha256:1111111111111111111111111111111111111111111111111111111111111111; publish a new Bindle version to adopt 1.2.3+build.2@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    }
  );
});

test("semver build metadata is normalized deterministically for compatibility checks", () => {
  assert.deepEqual(normalizeVersion("1.2.3+build.7"), {
    canonical: "1.2.3",
    original: "1.2.3+build.7",
    build: "build.7"
  });
  assert.equal(
    satisfies({
      installed: "1.2.3+build.7",
      requested: "1.2.3+build.2",
      tier: "stable"
    }).verdict,
    "compatible"
  );
});
