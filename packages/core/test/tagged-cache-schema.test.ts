import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { afterAll, describe, expect, it } from "vitest";
import { TaggedCacheEntryRecordSchema } from "../src/_generated/tagged_cache_pb.js";
import type { JsonValue } from "../src/json.js";

const cue =
	process.env.HOBO_CUE_BIN ||
	fileURLToPath(
		new URL(
			`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
			import.meta.url,
		),
	);
const schema = fileURLToPath(
	new URL("../data-models/tagged_cache.cue", import.meta.url),
);
const directory = mkdtempSync(join(tmpdir(), "hobo-tagged-cache-cue-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
let sequence = 0;
function check(type: string, value: JsonValue) {
	const path = join(directory, `${++sequence}.json`);
	writeFileSync(path, JSON.stringify(value));
	return spawnSync(cue, ["vet", "-c", "-d", `#${type}`, schema, path], {
		encoding: "utf8",
		timeout: 10_000,
	});
}

describe("tagged cache records", () => {
	it("preserves tags and epochs across protobuf and CUE", () => {
		const value = {
			value: "Ada",
			tagEpochs: [
				{ tag: "__proto__", epoch: "e7100d6a-5a85-4aa8-87da-8fb6a09fe402" },
			],
		};
		const record = fromJsonString(
			TaggedCacheEntryRecordSchema,
			JSON.stringify(value),
		);
		expect(
			fromBinary(
				TaggedCacheEntryRecordSchema,
				toBinary(TaggedCacheEntryRecordSchema, record),
			).tagEpochs[0]?.tag,
		).toBe("__proto__");
		const result = check("TaggedCacheEntryRecord", value);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
	});
	it.each([
		[
			"TaggedCacheEntryRecord",
			{ value: "Ada", tagEpochs: [{ tag: "users", epoch: "invalid" }] },
		],
		["TaggedCacheReadRecord", { hit: true }],
	])("rejects invalid %s", (type, value) => {
		const result = check(type, value);
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
	});
});
