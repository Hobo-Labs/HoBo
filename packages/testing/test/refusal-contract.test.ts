import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { TEST_HARNESS_ERROR_CODES } from "../src/index.js";

it("keeps the runtime refusal codes and CUE vocabulary in sync", async () => {
	const cue = await readFile(
		new URL("../data-models/test_harness.cue", import.meta.url),
		"utf8",
	);
	const definition = cue
		.split("#HarnessRefusalCode:")[1]
		?.split("#HarnessRefusalRecord:")[0];
	if (!definition) throw new Error("missing refusal code definition");
	const codes = [...definition.matchAll(/"(HARNESS_[A-Z_]+)"/gu)].map(
		(match) => match[1],
	);
	expect(codes).toHaveLength(new Set(codes).size);
	expect(codes.sort()).toEqual([...TEST_HARNESS_ERROR_CODES].sort());
});
