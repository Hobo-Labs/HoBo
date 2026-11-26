import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { cueBinary } from "../../stage-gate/test/helpers/cue-binary.js";
import { GeneratedResourcePutSchema } from "../src/_generated/project_codegen_pb.js";
import { parseFieldSchema, serializedSchema } from "../src/codegen/schema.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cue = cueBinary(process.env, repo);
const schemaFile = join(repo, "packages/cli/data-models/project_codegen.cue");

describe("executed codegen Protobuf/CUE contracts", () => {
	it("accepts real recursive schema wire output and rejects missing child contracts", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-cue-contract-"));
		try {
			const valid = join(root, "valid.json"),
				invalid = join(root, "invalid.json");
			await writeFile(
				valid,
				JSON.stringify(
					serializedSchema(
						parseFieldSchema({
							type: "object",
							fields: {
								tags: {
									type: "array",
									items: { type: "enum", values: ["red", "green"] },
								},
								location: {
									type: "object",
									fields: { city: { type: "string" } },
								},
							},
						}),
					),
				),
			);
			await writeFile(invalid, JSON.stringify({ kind: "array" }));
			expect(() =>
				execFileSync(
					cue,
					["vet", schemaFile, "-d", "#CodegenFieldSchema", valid],
					{ stdio: "pipe" },
				),
			).not.toThrow();
			expect(() =>
				execFileSync(
					cue,
					["vet", schemaFile, "-d", "#CodegenFieldSchema", invalid],
					{ stdio: "pipe" },
				),
			).toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("round-trips a nested resource event through Protobuf and enforces its CUE invariant", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-event-contract-"));
		try {
			const event = {
				key: "order-1",
				value: {
					customer: { name: "Ada" },
					items: [{ sku: "book", quantity: 2 }],
				},
			};
			const wire = toJson(
				GeneratedResourcePutSchema,
				fromJson(GeneratedResourcePutSchema, event),
			);
			expect(wire).toEqual(event);
			const valid = join(root, "valid.json"),
				invalid = join(root, "invalid.json");
			await writeFile(valid, JSON.stringify(wire));
			await writeFile(invalid, JSON.stringify({ ...event, key: "" }));
			expect(() =>
				execFileSync(
					cue,
					["vet", schemaFile, "-d", "#GeneratedResourcePut", valid],
					{ stdio: "pipe" },
				),
			).not.toThrow();
			expect(() =>
				execFileSync(
					cue,
					["vet", schemaFile, "-d", "#GeneratedResourcePut", invalid],
					{ stdio: "pipe" },
				),
			).toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
