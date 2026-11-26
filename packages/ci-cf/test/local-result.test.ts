import { create, toJsonString } from "@bufbuild/protobuf";
import {
	createArtifact,
	PipelineResultSchema,
	PipelineStepResultSchema,
} from "@hobo/ci/execution";
import { expect, it } from "vitest";
import { LocalPreparationSchema } from "../src/_generated/readiness_pb.js";
import { verifyLocalResult } from "../src/local-runtime.js";

const preparation = create(LocalPreparationSchema, {
	pipelineJson: JSON.stringify({
		id: "verified",
		accountId: "local",
		timeoutSeconds: 30,
		steps: [
			{ id: "first", argv: ["true"], cwd: ".", env: {} },
			{ id: "second", argv: ["true"], cwd: ".", env: {} },
		],
		artifactPaths: ["result.dat"],
		requiredCapabilities: [],
	}),
});
async function valid() {
	return create(PipelineResultSchema, {
		id: "verified",
		backend: "cf",
		status: "succeeded",
		steps: [
			create(PipelineStepResultSchema, { id: "first" }),
			create(PipelineStepResultSchema, { id: "second" }),
		],
		artifacts: [
			await createArtifact("result.dat", new Uint8Array([0, 255, 173])),
		],
	});
}

it("requires every admitted step and artifact before accepting a successful pipeline", async () => {
	const result = await valid();
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).resolves.toEqual(result);
	result.steps.pop();
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).rejects.toThrow("incomplete pipeline");
});
it("rejects execution that continued after a failed command", async () => {
	const result = await valid();
	result.status = "failed";
	const first = result.steps[0];
	if (!first) throw new Error("missing fixture step");
	first.exitCode = 23;
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).rejects.toThrow("continued after a failed command");
});
it("independently verifies returned artifact path and bytes", async () => {
	const result = await valid();
	const artifact = result.artifacts[0];
	if (!artifact) throw new Error("missing fixture artifact");
	artifact.data = new Uint8Array([1]);
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).rejects.toThrow("artifact integrity");
});
it("refuses results from another pipeline or backend", async () => {
	const result = await valid();
	result.id = "different";
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).rejects.toThrow("admitted pipeline");
	result.id = "verified";
	result.backend = "dagger";
	await expect(
		verifyLocalResult(toJsonString(PipelineResultSchema, result), preparation),
	).rejects.toThrow("admitted pipeline");
});
