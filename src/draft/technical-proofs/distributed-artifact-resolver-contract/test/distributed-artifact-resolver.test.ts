import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  canonicalResolutionResult,
  resolveDistributedArtifacts,
} from "../src/distributed-artifact-resolver.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vectors = JSON.parse(await readFile(
  path.resolve(packageRoot, "../version-compat-resolution-semantics/fixtures/resolution-vectors.json"),
  "utf8",
));

for (const vector of vectors) {
  test(`HOBO-340 compatibility vector: ${vector.name}`, () => {
    const actual = canonicalResolutionResult(resolveDistributedArtifacts(vector));

    assert.deepEqual(actual, vector.expected);
  });
}

test("catalog order is not part of resolver output identity", () => {
  const vector = vectors.find(({ shuffleCatalog }) => shuffleCatalog);
  const forward = canonicalResolutionResult(resolveDistributedArtifacts(vector));
  const reversed = canonicalResolutionResult(resolveDistributedArtifacts({
    ...vector,
    catalog: [...vector.catalog].reverse(),
  }));

  assert.deepEqual(forward, vector.expected);
  assert.deepEqual(reversed, vector.expected);
});

test("manifest IR pin records freeze floating ranges to concrete digests", () => {
  const vector = vectors.find(({ name }) => name === "initial install selects highest compatible stable candidate");

  const result = resolveDistributedArtifacts(vector);

  assert.equal(result.ok, true);
  assert.match(result.catalogSnapshotHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.manifestIr, {
    schema: "hobo.manifest/v1",
    artifactPins: [
      {
        name: "provider.aws",
        version: "1.3.0",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        immutable: true,
        constraints: ["provider.aws ^1.2.0"],
        catalogSnapshotHash: result.catalogSnapshotHash,
      },
    ],
  });
});

test("ordinary plan refuses in-place mutation of an existing immutable manifest pin", () => {
  const result = resolveDistributedArtifacts({
    mode: "plan",
    requests: [
      { name: "provider.aws", range: "^2.0.0" },
    ],
    currentPins: [
      {
        name: "provider.aws",
        version: "1.3.0",
        tier: "stable",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
    catalog: [
      {
        name: "provider.aws",
        version: "1.3.0",
        tier: "stable",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      {
        name: "provider.aws",
        version: "2.0.0",
        tier: "stable",
        digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "immutable-pin-mutation",
      name: "provider.aws",
      current: "1.3.0@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      constraints: ["provider.aws ^2.0.0"],
      reason: "publish a new Bindle version to change an immutable manifest pin",
    },
  });
});

test("lockfile set must exactly match the manifest pin set when present", () => {
  const baseInput = {
    mode: "plan",
    requests: [
      { name: "provider.aws", range: "^1.2.0" },
    ],
    currentPins: [
      {
        name: "provider.aws",
        version: "1.2.1",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    catalog: [
      {
        name: "provider.aws",
        version: "1.2.1",
        tier: "stable",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
  };

  assert.deepEqual(resolveDistributedArtifacts({
    ...baseInput,
    lockPins: [],
  }).ok, true);
  assert.deepEqual(resolveDistributedArtifacts({
    ...baseInput,
    lockPins: [
      {
        name: "provider.aws",
        version: "1.2.1",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      {
        name: "extra.plugin",
        version: "1.0.0",
        digest: "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      },
    ],
  }), {
    ok: false,
    error: {
      code: "lock-mismatch",
      name: "extra.plugin",
      manifest: null,
      lock: "1.0.0@sha256:9999999999999999999999999999999999999999999999999999999999999999",
    },
  });
  assert.deepEqual(resolveDistributedArtifacts({
    ...baseInput,
    lockPins: [
      {
        name: "zz.plugin",
        version: "1.0.0",
        digest: "sha256:8888888888888888888888888888888888888888888888888888888888888888",
      },
    ],
  }), {
    ok: false,
    error: {
      code: "lock-mismatch",
      name: "provider.aws",
      manifest: "1.2.1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lock: null,
    },
  });
});

test("ordinary plan cannot preserve a manifest pin absent from the catalog snapshot", () => {
  const result = resolveDistributedArtifacts({
    mode: "plan",
    requests: [
      { name: "provider.aws", range: "^1.2.0" },
    ],
    currentPins: [
      {
        name: "provider.aws",
        version: "1.2.1",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ],
    catalog: [
      {
        name: "provider.aws",
        version: "1.3.0",
        tier: "stable",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "manifest-pin-not-in-catalog",
      name: "provider.aws",
      current: "1.2.1@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      reason: "catalog snapshot must contain the immutable manifest pin before plan can preserve it",
    },
  });
});

test("transitive major-boundary constraint fails closed after a root pin was selected", () => {
  const result = resolveDistributedArtifacts({
    mode: "install",
    requests: [
      { name: "a.shared", range: "^1.0.0" },
      { name: "z.pack", range: "1.0.0" },
    ],
    catalog: [
      {
        name: "a.shared",
        version: "1.4.0",
        tier: "stable",
        digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      },
      {
        name: "a.shared",
        version: "2.0.0",
        tier: "stable",
        digest: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      },
      {
        name: "z.pack",
        version: "1.0.0",
        tier: "stable",
        digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        dependencies: [
          { name: "a.shared", range: "^2.0.0" },
        ],
      },
    ],
  });

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: "dependency-conflict",
      name: "a.shared",
      constraints: [
        "a.shared ^1.0.0",
        "z.pack@1.0.0 -> a.shared ^2.0.0",
      ],
    },
  });
});

test("late transitive constraint narrows an already selected root to the intersection", () => {
  const result = resolveDistributedArtifacts({
    mode: "install",
    requests: [
      { name: "a.shared", range: "^1.0.0" },
      { name: "z.pack", range: "1.0.0" },
    ],
    catalog: [
      {
        name: "a.shared",
        version: "1.2.5",
        tier: "stable",
        digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212",
      },
      {
        name: "a.shared",
        version: "1.4.0",
        tier: "stable",
        digest: "sha256:1414141414141414141414141414141414141414141414141414141414141414",
      },
      {
        name: "z.pack",
        version: "1.0.0",
        tier: "stable",
        digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        dependencies: [
          { name: "a.shared", range: "~1.2.0" },
        ],
      },
    ],
  });

  assert.deepEqual(canonicalResolutionResult(result), {
    ok: true,
    pins: [
      {
        name: "a.shared",
        version: "1.2.5",
        digest: "sha256:1212121212121212121212121212121212121212121212121212121212121212",
      },
      {
        name: "z.pack",
        version: "1.0.0",
        digest: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    ],
  });
});
