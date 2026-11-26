import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_EVIDENCE_SOURCES,
  REQUIRED_SUPPORT_ROUTES,
  V1_SUPPORTED_PLATFORM_MATRIX,
  classifyUnsupportedEnvironment,
  validateSupportedPlatformMatrix,
} from "../src/supported-platform-matrix.mjs";

test("M0 matrix defines desktop browser, responsive, CLI, viewport, and unsupported environment support", () => {
  const result = validateSupportedPlatformMatrix(V1_SUPPORTED_PLATFORM_MATRIX);

  assert.deepEqual(result.errors, []);
  assert.equal(V1_SUPPORTED_PLATFORM_MATRIX.issue, "HOBO-511");
  assert.equal(V1_SUPPORTED_PLATFORM_MATRIX.phase, "M0");
  assert.deepEqual(
    V1_SUPPORTED_PLATFORM_MATRIX.desktopBrowsers.map((browser) => browser.name),
    ["Chrome", "Edge", "Firefox", "Safari"],
  );
  assert.deepEqual(
    V1_SUPPORTED_PLATFORM_MATRIX.cliAndLocalBootstrap.map((platform) => platform.os),
    ["macOS", "Linux", "Windows"],
  );
  assert.equal(V1_SUPPORTED_PLATFORM_MATRIX.responsivePosture.minimumViewport.width, 390);
  assert.ok(V1_SUPPORTED_PLATFORM_MATRIX.unsupportedEnvironments.length >= 4);
});

test("every support claim maps to an allowed evidence source", () => {
  const requiredSources = new Set(REQUIRED_EVIDENCE_SOURCES);

  for (const claim of V1_SUPPORTED_PLATFORM_MATRIX.supportClaims) {
    assert.ok(claim.id);
    assert.ok(claim.claim);
    assert.ok(claim.owner);
    assert.ok(claim.evidenceSources.length > 0);
    for (const source of claim.evidenceSources) {
      assert.equal(requiredSources.has(source), true, `${claim.id} uses unsupported source ${source}`);
    }
  }

  assert.deepEqual(
    [...new Set(V1_SUPPORTED_PLATFORM_MATRIX.supportClaims.flatMap((claim) => claim.evidenceSources))].sort(),
    REQUIRED_EVIDENCE_SOURCES.toSorted(),
  );
});

test("beta and GA support levels are explicit for browsers and CLI bootstrap platforms", () => {
  for (const browser of V1_SUPPORTED_PLATFORM_MATRIX.desktopBrowsers) {
    assert.ok(browser.beta);
    assert.ok(browser.ga);
    assert.match(browser.beta.level, /supported|limited|unsupported/);
    assert.match(browser.ga.level, /supported|limited|unsupported/);
  }

  for (const platform of V1_SUPPORTED_PLATFORM_MATRIX.cliAndLocalBootstrap) {
    assert.ok(platform.beta);
    assert.ok(platform.ga);
    assert.ok(platform.architectures.length > 0);
  }
});

test("support/debug and release notes know how to route unsupported environment reports", () => {
  assert.deepEqual(
    V1_SUPPORTED_PLATFORM_MATRIX.unsupportedReportRoutes.map((route) => route.destination),
    REQUIRED_SUPPORT_ROUTES,
  );

  assert.deepEqual(
    classifyUnsupportedEnvironment({
      browser: "Internet Explorer",
      os: "Windows",
      viewportWidth: 1280,
      workflow: "dashboard",
    }),
    {
      supportLevel: "unsupported",
      route: "support-debug",
      releaseNoteClass: "unsupported-browser",
    },
  );

  assert.deepEqual(
    classifyUnsupportedEnvironment({
      browser: "Safari",
      os: "iOS",
      viewportWidth: 360,
      workflow: "dashboard",
    }),
    {
      supportLevel: "limited",
      route: "release-notes",
      releaseNoteClass: "mobile-responsive-limitation",
    },
  );
});

test("scope guard rejects broad device lab, native mobile, and automated browser grid expansion", () => {
  const invalid = structuredClone(V1_SUPPORTED_PLATFORM_MATRIX);
  invalid.scopeIn.push("Build a full device lab, native mobile app, and automated browser grid.");

  const result = validateSupportedPlatformMatrix(invalid);

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("adversarial guard rejects a compatibility matrix that only covers package or runtime versions", () => {
  const invalid = structuredClone(V1_SUPPORTED_PLATFORM_MATRIX);
  invalid.desktopBrowsers = [];
  invalid.responsivePosture = null;
  invalid.unsupportedEnvironments = [];
  invalid.supportClaims = invalid.supportClaims.filter((claim) => claim.id === "package-runtime-versions");

  const result = validateSupportedPlatformMatrix(invalid);

  assert.match(result.errors.join("\n"), /user-facing browser\/device support/i);
});
