import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  OCI_ARTIFACT_STORAGE_CONTRACT,
  createArtifactBytesRef,
  createOciArtifactStore
} from "../src/oci-artifact-storage.js";
import { createFixtureDescriptor } from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("push stores descriptor and artifact by stable digest, pull returns byte-identical content, and resolve points at the digest", async () => {
  const store = createOciArtifactStore();
  const artifactBytes = Buffer.from("provider component bytes v1\n");
  const descriptor = fixtureDescriptorForBytes({ artifactBytes });

  const pushed = store.push({
    descriptor,
    artifact: {
      mediaType: descriptor.artifact.mediaType,
      bytes: artifactBytes
    }
  });

  assert.match(pushed.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(pushed.digest, store.resolve({ name: descriptor.name, version: descriptor.version }));
  assert.equal(pushed.digest, store.push({ descriptor, artifact: { mediaType: descriptor.artifact.mediaType, bytes: artifactBytes } }).digest);
  assert.deepEqual(store.blobs().map((blob) => blob.role).sort(), ["artifact", "descriptor"]);

  const pulled = store.pull(pushed.digest);

  assert.deepEqual(pulled.descriptor, descriptor);
  assert.equal(Buffer.compare(pulled.artifact.bytes, artifactBytes), 0);
  assert.deepEqual(pulled.artifact.ref, descriptor.artifact);
});

test("push is idempotent for identical content and projects registry events into the catalog read model", () => {
  const store = createOciArtifactStore();
  const artifactBytes = Buffer.from("provider component bytes v1\n");
  const descriptor = fixtureDescriptorForBytes({ artifactBytes });

  const first = store.push({ descriptor, artifact: { mediaType: descriptor.artifact.mediaType, bytes: artifactBytes } });
  const second = store.push({ descriptor, artifact: { mediaType: descriptor.artifact.mediaType, bytes: artifactBytes } });
  const events = store.events();
  const catalog = store.catalog();

  assert.equal(second.digest, first.digest);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["ProviderRegistered", "CapabilityManifestUpdated"]);
  assert.deepEqual(catalog.resolve({ name: descriptor.name, version: descriptor.version }), first.digest);
  assert.deepEqual(catalog.entriesFor({ name: descriptor.name, version: descriptor.version }).map((entry) => entry.digest), [first.digest]);
});

test("nonexistent digests fail cleanly without returning partial content", () => {
  const store = createOciArtifactStore();

  assert.throws(
    () => store.pull("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    /artifact listing sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa not found/
  );
});

test("push rejects descriptors whose referenced artifact digest is absent from the supplied artifact", () => {
  const store = createOciArtifactStore();
  const artifactBytes = Buffer.from("provider component bytes v1\n");
  const descriptor = fixtureDescriptorForBytes({ artifactBytes });

  assert.throws(
    () => store.push({
      descriptor,
      artifact: {
        mediaType: descriptor.artifact.mediaType,
        bytes: Buffer.from("different artifact bytes\n")
      }
    }),
    /descriptor artifact digest .* does not match supplied artifact digest/
  );
});

test("re-pushing a name@version with different digest appends immutable history instead of overwriting", () => {
  const store = createOciArtifactStore();
  const firstBytes = Buffer.from("provider component bytes v1\n");
  const secondBytes = Buffer.from("provider component bytes v2\n");
  const firstDescriptor = fixtureDescriptorForBytes({ artifactBytes: firstBytes });
  const secondDescriptor = fixtureDescriptorForBytes({ artifactBytes: secondBytes });

  const first = store.push({ descriptor: firstDescriptor, artifact: { mediaType: firstDescriptor.artifact.mediaType, bytes: firstBytes } });
  const second = store.push({ descriptor: secondDescriptor, artifact: { mediaType: secondDescriptor.artifact.mediaType, bytes: secondBytes } });
  const catalog = store.catalog();

  assert.notEqual(second.digest, first.digest);
  assert.equal(store.resolve({ name: firstDescriptor.name, version: firstDescriptor.version }), second.digest);
  assert.equal(Buffer.compare(store.pull(first.digest).artifact.bytes, firstBytes), 0);
  assert.equal(Buffer.compare(store.pull(second.digest).artifact.bytes, secondBytes), 0);
  assert.deepEqual(
    catalog.entriesFor({ name: firstDescriptor.name, version: firstDescriptor.version }).map((entry) => entry.digest),
    [first.digest, second.digest]
  );
});

test("TypeScript declarations publish the OCI artifact storage contract surface", async () => {
  const declarations = await readFile(path.join(packageRoot, "src", "oci-artifact-storage.d.ts"), "utf8");

  assert.equal(OCI_ARTIFACT_STORAGE_CONTRACT, "hobo.oci-artifact-storage/v1");
  assert.match(declarations, /export interface OciArtifactStore/);
  assert.match(declarations, /export interface RegistryCatalogReadModel/);
});

function fixtureDescriptorForBytes({ artifactBytes }) {
  const descriptor = createFixtureDescriptor({ kind: "provider" });
  descriptor.name = "@acme/oci-provider";
  descriptor.version = "1.0.0";
  descriptor.artifact = createArtifactBytesRef({
    name: "acme/oci-provider/component.wasm",
    mediaType: "application/wasm",
    bytes: artifactBytes
  });
  return descriptor;
}
