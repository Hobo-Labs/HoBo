import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { defineProjection } from "../src/index.js";
import type { JsonObject } from "../src/json.js";

const directory = mkdtempSync(join(tmpdir(), "hobo-projection-schema-"));
const schema = fileURLToPath(
	new URL("../data-models/data.cue", import.meta.url),
);
const cueAvailable =
	spawnSync("cue", ["version"], { stdio: "ignore" }).status === 0;

afterAll(() => rmSync(directory, { recursive: true, force: true }));

function validate(value: JsonObject): number | null {
	const input = join(directory, "projection.cue");
	writeFileSync(
		input,
		`package hobo\nvalue: #ProjectionDeclaredData & ${JSON.stringify(value)}\n`,
	);
	return spawnSync("cue", ["export", schema, input, "-e", "value"], {
		encoding: "utf8",
	}).status;
}

describe.skipIf(!cueAvailable)("projection metadata contract", () => {
	it("accepts production declarations and rejects mismatched schemas", () => {
		const base = {
			name: "orders",
			key: () => "row",
			on: { "order.Placed": () => ({}) },
		};
		const legacy = defineProjection(base).declared().data;
		const withMetadata = defineProjection({
			...base,
			rowSchema: {
				witRecord: "shop:orders/view@1.0.0",
				fields: [{ name: "id", type: "string" }],
			},
			indexHints: ["id"],
		}).declared().data;
		expect(validate(legacy)).toBe(0);
		expect(validate(withMetadata)).toBe(0);
		expect(
			validate({ ...withMetadata, readModel: "shop:other/view@1.0.0" }),
		).not.toBe(0);
	});
});
