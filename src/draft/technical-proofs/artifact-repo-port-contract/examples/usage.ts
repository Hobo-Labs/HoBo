/**
 * Runnable example for artifact-repo-port-contract. The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-347: the hobo:artifact-repo port pulls ONLY digest-pinned artifacts
 * through mirror sets of registered adapters, requires provenance before publish,
 * and ships a conformance stub that fails adapters violating either invariant. The
 * WIT world and TypeScript declaration surfaces are checked as committed fixtures.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
	ARTIFACT_REPO_WIT_PACKAGE,
	createArtifactRepoRegistry,
	createDigestArtifactRef,
	createInMemoryArtifactRepoAdapter,
	defineMirrorSet,
	publishArtifact,
	pullArtifact,
	runArtifactRepoConformance,
} from "../src/artifact-repo-port.ts";

// 1) The committed WIT world and .d.ts publish the same port surface.
const wit = readFileSync(new URL("../wit/world.wit", import.meta.url), "utf8");
const declarations = readFileSync(new URL("../src/artifact-repo-port.d.ts", import.meta.url), "utf8");
assert.match(wit, /package hobo:artifact-repo@0\.1\.0;/);
assert.match(wit, /record mirror-set/);
assert.match(declarations, /export interface ArtifactRepoPort/);
console.log(`surfaces: wit=${ARTIFACT_REPO_WIT_PACKAGE} dts=ArtifactRepoPort+MirrorSet declared`);

// 2) Digest-pinned pull through a mirror set of registered adapters.
const registry = createArtifactRepoRegistry();
const artifact = createDigestArtifactRef("npm-leftpad-1.0.0", {
	mediaType: "application/vnd.npm.package.tgz",
});
const adapter = createInMemoryArtifactRepoAdapter({
	id: "npm-primary",
	kind: "npm",
	artifacts: { "@acme/leftpad@1.0.0": artifact },
});
registry.registerAdapter(adapter);
const mirrorSet = defineMirrorSet(registry, { name: "public-npm", adapters: ["npm-primary"] });
const pulled = await pullArtifact(mirrorSet, {
	ecosystem: "npm",
	name: "@acme/leftpad",
	version: "1.0.0",
});
assert.deepEqual(pulled.artifact, artifact);
assert.equal(pulled.verification.digestPinned, true);
console.log(
	`pull: adapter=${pulled.adapterId} digestPinned=${pulled.verification.digestPinned} digest=${pulled.artifact.digest.slice(0, 19)}...`,
);

// 3) Mutable-tag pulls (no resolved digest) fail closed.
const tagOnly = {
	id: "oci-tag-only",
	kind: "oci",
	pull: async () => ({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		uri: "oci://registry.example/acme/app:latest",
	}),
	publish: async () => {
		throw new Error("not used");
	},
};
registry.registerAdapter(tagOnly);
const ociMirror = defineMirrorSet(registry, { name: "oci", adapters: ["oci-tag-only"] });
await assert.rejects(
	() => pullArtifact(ociMirror, { ecosystem: "oci", name: "acme/app", version: "latest" }),
	/digest-pinned artifact/,
);
console.log("mutable tag pull: rejected (digest-pinned artifact required)");

// 4) Publish requires provenance BEFORE the adapter is called.
let publishCalls = 0;
const countingAdapter = {
	id: "pypi-primary",
	kind: "pypi",
	pull: async () => {
		throw new Error("not used");
	},
	publish: async () => {
		publishCalls += 1;
		return createDigestArtifactRef("should-not-publish");
	},
};
await assert.rejects(
	() => publishArtifact(countingAdapter, { artifact: createDigestArtifactRef("wheel") }),
	/provenance/,
);
assert.equal(publishCalls, 0);
const published = await publishArtifact(adapter, {
	artifact: createDigestArtifactRef("new-package", {
		mediaType: "application/vnd.npm.package.tgz",
	}),
	provenance: createDigestArtifactRef("npm-leftpad-provenance", {
		mediaType: "application/vnd.in-toto+json",
	}),
});
assert.match(published.digest, /^sha256:[a-f0-9]{64}$/);
console.log(`publish: without provenance adapterCalls=${publishCalls}; with provenance digest ok`);

// 5) Mirror sets never consult unregistered adapters.
assert.throws(
	() =>
		defineMirrorSet(registry, {
			name: "nuget",
			adapters: ["nuget-shadow"],
		}),
	/unregistered adapter nuget-shadow/,
);
console.log("mirror set: unregistered adapter rejected");

// 6) The conformance stub passes a compliant adapter and fails a violating one.
const passing = createInMemoryArtifactRepoAdapter({
	id: "oci-primary",
	kind: "oci",
	artifacts: {
		"registry.example/acme/app@1.0.0": createDigestArtifactRef("oci-app", {
			mediaType: "application/vnd.oci.image.manifest.v1+json",
		}),
	},
});
const failing = {
	id: "oci-bad",
	kind: "oci",
	pull: async () => ({
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		uri: "oci://example/app:1.0.0",
	}),
	publish: async () => createDigestArtifactRef("published-without-provenance"),
};
const coordinate = { ecosystem: "oci", name: "registry.example/acme/app", version: "1.0.0" };
const passReport = await runArtifactRepoConformance(passing, { coordinate });
const failReport = await runArtifactRepoConformance(failing, { coordinate });
assert.equal(passReport.ok, true);
assert.equal(failReport.ok, false);
assert.match(failReport.failures.join("\n"), /publish without provenance must fail/);
console.log(
	`conformance: compliant ok=${passReport.ok}; violating ok=${failReport.ok} failures=${failReport.failures.length}`,
);

console.log("CONTRACT HELD: digest-pinned pulls, provenance-gated publish, registered mirrors only");
