import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createArtifactRepoRegistry,
  createDigestArtifactRef,
  createInMemoryArtifactRepoAdapter,
  defineMirrorSet,
  publishArtifact,
  pullArtifact,
  runArtifactRepoConformance
} from "../src/artifact-repo-port.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("WIT and TypeScript surfaces publish the hobo:artifact-repo port contract", async () => {
  const wit = await readFile(path.join(packageRoot, "wit", "world.wit"), "utf8");
  const declarations = await readFile(path.join(packageRoot, "src", "artifact-repo-port.d.ts"), "utf8");

  assert.match(wit, /package hobo:artifact-repo@0\.1\.0;/);
  assert.match(wit, /pull: func\(coordinate: artifact-coordinate\) -> result<verified-artifact, artifact-repo-error>;/);
  assert.match(wit, /publish: func\(artifact: artifact-ref, provenance: provenance-ref\) -> result<artifact-ref, artifact-repo-error>;/);
  assert.match(wit, /record mirror-set/);
  assert.match(declarations, /export interface ArtifactRepoPort/);
  assert.match(declarations, /export interface MirrorSet/);
});

test("in-memory adapter satisfies digest-pinned pull and provenance-required publish", async () => {
  const registry = createArtifactRepoRegistry();
  const artifact = createDigestArtifactRef("npm-leftpad-1.0.0", {
    mediaType: "application/vnd.npm.package.tgz"
  });
  const provenance = createDigestArtifactRef("npm-leftpad-provenance", {
    mediaType: "application/vnd.in-toto+json"
  });
  const adapter = createInMemoryArtifactRepoAdapter({
    id: "npm-primary",
    kind: "npm",
    artifacts: {
      "@acme/leftpad@1.0.0": artifact
    }
  });

  registry.registerAdapter(adapter);
  const mirrorSet = defineMirrorSet(registry, {
    name: "public-npm",
    adapters: ["npm-primary"]
  });

  const pulled = await pullArtifact(mirrorSet, {
    ecosystem: "npm",
    name: "@acme/leftpad",
    version: "1.0.0"
  });

  assert.deepEqual(pulled.artifact, artifact);
  assert.equal(pulled.adapterId, "npm-primary");

  const published = await publishArtifact(adapter, {
    artifact: createDigestArtifactRef("new-package", {
      mediaType: "application/vnd.npm.package.tgz"
    }),
    provenance
  });

  assert.match(published.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(adapter.published.length, 1);
});

test("pulls fail closed when an adapter returns a mutable tag without a resolved digest", async () => {
  const registry = createArtifactRepoRegistry();
  const tagOnlyAdapter = {
    id: "oci-tag-only",
    kind: "oci",
    async pull() {
      return {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        uri: "oci://registry.example/acme/app:latest"
      };
    },
    async publish() {
      throw new Error("not used");
    }
  };

  registry.registerAdapter(tagOnlyAdapter);
  const mirrorSet = defineMirrorSet(registry, {
    name: "oci",
    adapters: ["oci-tag-only"]
  });

  await assert.rejects(
    () => pullArtifact(mirrorSet, { ecosystem: "oci", name: "acme/app", version: "latest" }),
    /digest-pinned artifact/
  );
});

test("publish requires provenance before the adapter is called", async () => {
  let publishCalls = 0;
  const adapter = {
    id: "pypi-primary",
    kind: "pypi",
    async pull() {
      throw new Error("not used");
    },
    async publish() {
      publishCalls += 1;
      return createDigestArtifactRef("should-not-publish");
    }
  };

  await assert.rejects(
    () => publishArtifact(adapter, { artifact: createDigestArtifactRef("wheel") }),
    /provenance/
  );
  assert.equal(publishCalls, 0);
});

test("mirror sets only contain registered adapters and never consult unregistered mirrors", async () => {
  const registry = createArtifactRepoRegistry();
  let unregisteredPulls = 0;
  const registered = createInMemoryArtifactRepoAdapter({
    id: "nuget-primary",
    kind: "nuget",
    artifacts: {}
  });
  const unregistered = {
    id: "nuget-shadow",
    kind: "nuget",
    async pull() {
      unregisteredPulls += 1;
    },
    async publish() {
      throw new Error("not used");
    }
  };

  registry.registerAdapter(registered);

  assert.throws(
    () => defineMirrorSet(registry, { name: "nuget", adapters: ["nuget-primary", unregistered] }),
    /unregistered adapter nuget-shadow/
  );
  assert.equal(unregisteredPulls, 0);
});

test("conformance stub asserts digest-pinned pull and provenance-required publish invariants", async () => {
  const passing = createInMemoryArtifactRepoAdapter({
    id: "oci-primary",
    kind: "oci",
    artifacts: {
      "registry.example/acme/app@1.0.0": createDigestArtifactRef("oci-app", {
        mediaType: "application/vnd.oci.image.manifest.v1+json"
      })
    }
  });
  const failing = {
    id: "oci-bad",
    kind: "oci",
    async pull() {
      return { mediaType: "application/vnd.oci.image.manifest.v1+json", uri: "oci://example/app:1.0.0" };
    },
    async publish() {
      return createDigestArtifactRef("published-without-provenance");
    }
  };

  const passReport = await runArtifactRepoConformance(passing, {
    coordinate: { ecosystem: "oci", name: "registry.example/acme/app", version: "1.0.0" }
  });
  const failReport = await runArtifactRepoConformance(failing, {
    coordinate: { ecosystem: "oci", name: "registry.example/acme/app", version: "1.0.0" }
  });

  assert.equal(passReport.ok, true, passReport.failures.join("\n"));
  assert.equal(failReport.ok, false);
  assert.match(failReport.failures.join("\n"), /digest-pinned artifact/);
  assert.match(failReport.failures.join("\n"), /publish without provenance must fail/);
});
