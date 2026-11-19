import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { test } from "vitest";
import { EvalResultSchema } from "../src/_generated/promotion_decision_pb.js";
import { aggregateEvalResults } from "../src/aggregate.js";

const cueFile = fileURLToPath(
	new URL("../data-models/promotion_decision.cue", import.meta.url),
);

function vet(value: string) {
	const directory = mkdtempSync(join(tmpdir(), "hobo-eval-result-"));
	try {
		const fixture = join(directory, "result.json");
		writeFileSync(fixture, value);
		const result = spawnSync(
			"cue",
			["vet", cueFile, fixture, "-d", "#EvalResult", "-c"],
			{
				encoding: "utf8",
			},
		);
		if (result.error) throw result.error;
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("per-metric counts survive protobuf and satisfy the CUE boundary", () => {
	const result = aggregateEvalResults(
		[{ scores: { accuracy: 1 } }, { scores: { accuracy: 0.5, latency: 1 } }],
		{ rubricRef: "rubric://x@1.0.0", source: "live-eval" },
	);
	const decoded = fromBinary(
		EvalResultSchema,
		toBinary(EvalResultSchema, result),
	);
	assert.deepEqual(decoded.metricSampleCounts, { accuracy: 2, latency: 1 });
	const json = toJson(EvalResultSchema, decoded, { useProtoFieldName: true });
	const valid = vet(JSON.stringify(json));
	assert.equal(valid.status, 0, valid.stderr);

	const invalid = create(EvalResultSchema, {
		rubricRef: "rubric://x@1.0.0",
		scores: { accuracy: 1 },
		sampleCount: 1,
		source: "live-eval",
		metricSampleCounts: { accuracy: 2 },
	});
	const invalidJson = toJson(EvalResultSchema, invalid, {
		useProtoFieldName: true,
	});
	assert.notEqual(vet(JSON.stringify(invalidJson)).status, 0);
});
