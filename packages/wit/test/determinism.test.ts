import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNTIME_WIT = join(
	import.meta.dirname,
	"../wit/deps/hobo-runtime/hobo-runtime.wit",
);
const NONDETERMINISTIC_RE = /wall-clock|now-ms|random/i;

describe("hobo:runtime determinism", () => {
	it("keeps replay-safe primitives free of wall-clock or random shapes", async () => {
		const source = await readFile(RUNTIME_WIT, "utf8");
		expect(NONDETERMINISTIC_RE.test(source)).toBe(false);
	});
});
