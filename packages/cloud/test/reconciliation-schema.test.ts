import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	ExecFailedRecordSchema,
	ResourceFailedRecordSchema,
} from "../src/_generated/cloud_pb.js";

const cue =
	process.env.HOBO_CUE_BIN ??
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/cloud.cue", import.meta.url),
);

describe("reconciliation failure records", () => {
	it.each([
		[
			"#ExecFailedRecord",
			{ execId: "exec", classification: "retryable", reason: "failure" },
			true,
		],
		[
			"#ExecFailedRecord",
			{
				execId: "exec",
				classification: "fatal",
				reason: "uncertain",
				requiresReconciliation: true,
				reservationId: "iac:r",
				reconciliationOperation: "apply",
			},
			true,
		],
		[
			"#ExecFailedRecord",
			{
				execId: "exec",
				classification: "retryable",
				reason: "uncertain",
				requiresReconciliation: true,
				reconciliationOperation: "apply",
			},
			false,
		],
		[
			"#ExecFailedRecord",
			{
				execId: "exec",
				classification: "fatal",
				reason: "uncertain",
				requiresReconciliation: true,
			},
			false,
		],
		[
			"#ExecFailedRecord",
			{
				execId: "exec",
				classification: "fatal",
				reason: "failure",
				requiresReconciliation: false,
				reservationId: "iac:r",
			},
			false,
		],
		[
			"#ResourceFailedRecord",
			{
				deploymentId: "deployment",
				resourceId: "resource",
				classification: "fatal",
				reason: "uncertain",
				crossedNoGoThreshold: false,
				requiresReconciliation: true,
				reservationId: "iac:r",
				reconciliationOperation: "destroy",
			},
			true,
		],
		[
			"#ResourceFailedRecord",
			{
				deploymentId: "deployment",
				resourceId: "resource",
				classification: "fatal",
				reason: "uncertain",
				crossedNoGoThreshold: true,
				requiresReconciliation: true,
				reconciliationOperation: "apply",
			},
			false,
		],
		[
			"#ResourceFailedRecord",
			{
				deploymentId: "deployment",
				resourceId: "resource",
				classification: "retryable",
				reason: "uncertain",
				crossedNoGoThreshold: false,
				requiresReconciliation: true,
				reconciliationOperation: "apply",
			},
			false,
		],
		[
			"#ResourceFailedRecord",
			{
				deploymentId: "deployment",
				resourceId: "resource",
				classification: "fatal",
				reason: "uncertain",
				crossedNoGoThreshold: false,
				requiresReconciliation: true,
			},
			false,
		],
		[
			"#ResourceFailedRecord",
			{
				deploymentId: "deployment",
				resourceId: "resource",
				classification: "fatal",
				reason: "uncertain",
				crossedNoGoThreshold: false,
				requiresReconciliation: true,
				reconciliationOperation: "preview",
			},
			false,
		],
		[
			"#TopologyNode",
			{
				id: "resource:web",
				kind: "resource",
				label: "web",
				lifecycle: "reconciliation-required",
			},
			true,
		],
	] as const)("checks %s reconciliation constraints", (definition, input, valid) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-reconciliation-cue-"));
		try {
			const path = join(dir, "failure.json");
			writeFileSync(path, JSON.stringify(input));
			const result = spawnSync(
				cue,
				["vet", "-c", "-d", definition, schema, path],
				{ encoding: "utf8" },
			);
			if (result.error) throw result.error;
			expect(result.status, result.stderr).toBe(valid ? 0 : 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		ExecFailedRecordSchema,
		ResourceFailedRecordSchema,
	])("preserves the reservation and reconciliation marker through protobuf JSON", (recordSchema) => {
		const record = create(recordSchema, {
			requiresReconciliation: true,
			reservationId: "iac:r",
			reconciliationOperation: "apply",
		});
		const roundTrip = fromJson(recordSchema, toJson(recordSchema, record));
		expect(roundTrip).toMatchObject({
			requiresReconciliation: true,
			reservationId: "iac:r",
			reconciliationOperation: "apply",
		});
	});
});
