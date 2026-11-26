import { bench, describe } from "vitest";

import {
	createArtifactRepoRegistry,
	createDigestArtifactRef,
	createInMemoryArtifactRepoAdapter,
	defineMirrorSet,
	publishArtifact,
	pullArtifact,
} from "../src/artifact-repo-port.ts";

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
const provenance = createDigestArtifactRef("npm-leftpad-provenance", {
	mediaType: "application/vnd.in-toto+json",
});

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("artifact-repo port hot path", () => {
	bench("digest-pinned pull through mirror set", async () => {
		await pullArtifact(mirrorSet, { ecosystem: "npm", name: "@acme/leftpad", version: "1.0.0" });
	});

	bench("provenance-gated publish", async () => {
		await publishArtifact(adapter, {
			artifact: createDigestArtifactRef("new-package", {
				mediaType: "application/vnd.npm.package.tgz",
			}),
			provenance,
		});
	});

	bench("createDigestArtifactRef (sha256 pin)", () => {
		createDigestArtifactRef("npm-leftpad-1.0.0");
	});
});
