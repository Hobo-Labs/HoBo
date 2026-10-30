import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, toJson } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { RailwayDeploymentIdentitySchema } from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function vet(
	changes: {
		recordedAtMs?: number;
		requestDigest?: string;
		deploymentId?: string;
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "railway-identity-schema-"));
	directories.push(directory);
	const json = join(directory, "identity.json");
	writeFileSync(
		json,
		JSON.stringify(
			toJson(
				RailwayDeploymentIdentitySchema,
				create(RailwayDeploymentIdentitySchema, {
					tenantId: "tenant",
					operationId: "hosting:version-1",
					requestDigest: `sha256:${"a".repeat(64)}`,
					projectId: "project-one",
					environmentId: "environment-one",
					serviceId: "service-one",
					logicalId: "app",
					deploymentId: "deployment-one",
					commitSha: "a".repeat(40),
					recordedAtMs: 1000,
					...changes,
				}),
			),
		),
	);
	execFileSync(
		fileURLToPath(
			new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
		),
		[
			"vet",
			fileURLToPath(
				new URL("../data-models/deployment_identity.cue", import.meta.url),
			),
			json,
			"-d",
			"#RailwayDeploymentIdentity",
		],
		{ stdio: "pipe" },
	);
}
describe("Railway durable deployment identity wire contract", () => {
	it("validates the generated native-identity metadata with actual CUE", () => {
		expect(() => vet()).not.toThrow();
	});
	it.each([
		{ recordedAtMs: 1.5 },
		{ recordedAtMs: Number.MAX_SAFE_INTEGER + 1 },
		{ requestDigest: "not-a-content-digest" },
		{ deploymentId: "../foreign" },
	])("refuses malformed persistence metadata: %j", (changes) => {
		expect(() => vet(changes)).toThrow();
	});
});
