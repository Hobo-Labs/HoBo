import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { cueBinary } from "../../../stage-gate/test/helpers/cue-binary.js";
import {
	CliAuthMdStateRecordSchema,
	StoredCliAuthMdStateRecordSchema,
} from "../../src/_generated/auth_md_pb.js";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(contracts, "../../..");
const cue = cueBinary(process.env, root);

for (const [boundary, definition] of [
	["public", "#CliAuthMdStateRecord"],
	["private", "#StoredCliAuthMdStateRecord"],
] as const) {
	describe(`CLI auth.md ${boundary} state schema`, () => {
		for (const expectation of ["valid", "invalid"] as const) {
			const directory = join(contracts, "fixtures", boundary, expectation);
			for (const fixture of readdirSync(directory)
				.filter((name) => name.endsWith(".json"))
				.sort()) {
				it(`${expectation}: ${fixture}`, () => {
					const validate = () =>
						execFileSync(
							cue,
							[
								"vet",
								"-c",
								"-d",
								definition,
								join(contracts, "../data-models/cli-state/schema.cue"),
								join(directory, fixture),
							],
							{ encoding: "utf8", stdio: "pipe" },
						);
					if (expectation === "valid") expect(validate).not.toThrow();
					else {
						try {
							validate();
							expect.unreachable("invalid fixture must be rejected");
						} catch (error) {
							expect(error).toMatchObject({ status: 1 });
						}
					}
				});
			}
		}
	});
}

describe("generated CLI auth.md state wire boundary", () => {
	it("round-trips public refs and refuses private material on the public record", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(contracts, "fixtures/public/valid/claimed-ref-state.json"),
				"utf8",
			),
		);
		const record = fromJson(CliAuthMdStateRecordSchema, fixture);
		expect(toJson(CliAuthMdStateRecordSchema, record)).toEqual(fixture);
		const injected = JSON.parse(
			readFileSync(
				join(contracts, "fixtures/public/invalid/private-key-in-public.json"),
				"utf8",
			),
		);
		expect(() => fromJson(CliAuthMdStateRecordSchema, injected)).toThrow();
	});
	it("round-trips owner-only custody only through the private record", () => {
		const fixture = JSON.parse(
			readFileSync(
				join(contracts, "fixtures/private/valid/claimed-owner-only-state.json"),
				"utf8",
			),
		);
		const record = fromJson(StoredCliAuthMdStateRecordSchema, fixture);
		expect(toJson(StoredCliAuthMdStateRecordSchema, record)).toEqual(fixture);
		expect(() => fromJson(CliAuthMdStateRecordSchema, fixture)).toThrow();
	});
});
