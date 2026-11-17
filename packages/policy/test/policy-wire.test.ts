import { readFileSync } from "node:fs";
import {
	create,
	createFileRegistry,
	fromBinary,
	fromJson,
	toBinary,
	toJson,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { expect, it } from "vitest";
import { DecisionEvidenceSchema } from "../src/_generated/policy_ir_pb.js";
import {
	decodePolicyEvidence,
	encodePolicyEvidence,
} from "../src/policy-ir.js";

const evidence = {
	policyIds: ["deny-prod"],
	inputHash: `sha256:${"a".repeat(64)}`,
	engine: "policy-engine",
	packId: "mandatory/prod",
	packVersion: "2.3.1",
};

it("preserves evidence through protobuf and both legacy reader directions", () => {
	const encoded = encodePolicyEvidence(evidence);
	expect(decodePolicyEvidence(encoded)).toEqual(evidence);
	const descriptor = fromBinary(
		FileDescriptorSetSchema,
		readFileSync(
			new URL("./fixtures/policy-v1.descriptor.bin", import.meta.url),
		),
	);
	const legacy = createFileRegistry(descriptor).getMessage(
		"hobo.policy.v1.DecisionEvidence",
	);
	if (!legacy) throw new Error("legacy policy descriptor missing");
	expect(toJson(legacy, fromBinary(legacy, encoded))).toEqual({
		policyIds: ["deny-prod"],
		inputHash: evidence.inputHash,
		engine: "policy-engine",
	});
	const old = fromJson(legacy, {
		policyIds: ["old-rule"],
		inputHash: evidence.inputHash,
		engine: "old-engine",
	});
	expect(decodePolicyEvidence(toBinary(legacy, old))).toEqual({
		policyIds: ["old-rule"],
		inputHash: evidence.inputHash,
		engine: "old-engine",
	});
});

it("rejects incomplete or invalid evidence at the protobuf boundary", () => {
	const partial = toBinary(
		DecisionEvidenceSchema,
		create(DecisionEvidenceSchema, {
			policyIds: [],
			inputHash: evidence.inputHash,
			engine: evidence.engine,
			packId: evidence.packId,
		}),
	);
	expect(() => decodePolicyEvidence(partial)).toThrow(
		"pack id and version must be recorded together",
	);
	expect(() => encodePolicyEvidence({ ...evidence, inputHash: "bad" })).toThrow(
		"invalid-input-hash",
	);
});
